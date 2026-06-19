#!/usr/bin/env node
'use strict'

const fs = require('fs')
const net = require('net')
const path = require('path')
const { collectManagedWatchedFiles, getDiagIpcPath, resolveTarget, ROOT_DIR, runDiagnosticsAsync, readFileToken } = require('./diag-pocketpages-core')
const { PocketPagesLanguageServiceManager } = require('../tools/vscode-pocketpages/packages/language-service/language-service')

const IDLE_TIMEOUT_MS = 10 * 60 * 1000

function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let pipePath = ''

  while (args.length > 0) {
    const current = args.shift()
    if (current === '--pipe') {
      pipePath = args.shift() || ''
    }
  }

  return {
    pipePath: pipePath || getDiagIpcPath(),
  }
}

function ensureParentDirectory(pipePath) {
  if (process.platform === 'win32') {
    return
  }

  const dirPath = path.dirname(pipePath)
  fs.mkdirSync(dirPath, { recursive: true })
}

function removePipeFileIfNeeded(pipePath) {
  if (process.platform === 'win32') {
    return
  }

  if (fs.existsSync(pipePath)) {
    fs.unlinkSync(pipePath)
  }
}

function buildServiceSnapshot(serviceDir) {
  const snapshot = new Map()

  for (const filePath of collectManagedWatchedFiles(serviceDir)) {
    snapshot.set(path.resolve(filePath), readFileToken(filePath))
  }

  return snapshot
}

function collectChangedFiles(previousSnapshot, nextSnapshot) {
  const changes = []

  for (const [filePath, token] of nextSnapshot.entries()) {
    if (previousSnapshot.get(filePath) !== token) {
      changes.push({
        type: previousSnapshot.has(filePath) ? 'change' : 'create',
        filePath,
      })
    }
  }

  for (const filePath of previousSnapshot.keys()) {
    if (!nextSnapshot.has(filePath)) {
      changes.push({
        type: 'delete',
        filePath,
      })
    }
  }

  return changes
}

const manager = new PocketPagesLanguageServiceManager()
const serviceSnapshots = new Map()
let idleTimer = null
let requestQueue = Promise.resolve()

function resetIdleTimer(server, pipePath) {
  if (idleTimer) {
    clearTimeout(idleTimer)
  }

  idleTimer = setTimeout(() => {
    try {
      server.close(() => {
        if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
          fs.unlinkSync(pipePath)
        }
        process.exit(0)
      })
    } catch (_error) {
      process.exit(0)
    }
  }, IDLE_TIMEOUT_MS)
}

function syncManagerForTarget(rawTarget) {
  const target = resolveTarget(rawTarget)
  let serviceDirs = []

  if (target.mode === 'service') {
    serviceDirs = target.serviceDirs
  } else {
    const normalizedFilePath = path.resolve(target.filePath)
    const marker = `${path.sep}pb_hooks${path.sep}pages${path.sep}`
    const markerIndex = normalizedFilePath.indexOf(marker)
    if (markerIndex !== -1) {
      serviceDirs = [normalizedFilePath.slice(0, markerIndex)]
    }
  }

  if (serviceDirs.length === 0) {
    return
  }

  const allChanges = []

  for (const serviceDir of serviceDirs) {
    const normalizedServiceDir = path.resolve(serviceDir)
    const previousSnapshot = serviceSnapshots.get(normalizedServiceDir) || new Map()
    const nextSnapshot = buildServiceSnapshot(normalizedServiceDir)
    const changes = collectChangedFiles(previousSnapshot, nextSnapshot)

    serviceSnapshots.set(normalizedServiceDir, nextSnapshot)
    allChanges.push(...changes)
  }

  if (allChanges.length > 0) {
    manager.handleWatchedFileChanges(allChanges)
  }
}

function sendResponseAndWait(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function sendFinalResponse(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`)
}

async function handleRequest(socket, rawText) {
  try {
    const request = JSON.parse(String(rawText || '{}'))
    const rawTarget = request && typeof request.rawTarget === 'string' ? request.rawTarget : ''
    const profile = !!(request && request.profile)

    syncManagerForTarget(rawTarget)
    const result = await runDiagnosticsAsync(rawTarget, {
      manager,
      profile,
      onLine(line) {
        return sendResponseAndWait(socket, {
          type: 'line',
          line,
        })
      },
    })

    sendFinalResponse(socket, {
      ok: true,
      type: 'result',
      result,
    })
  } catch (error) {
    sendFinalResponse(socket, {
      ok: false,
      type: 'result',
      error: String(error && error.message ? error.message : error),
    })
  }
}

const options = parseArgs(process.argv.slice(2))
ensureParentDirectory(options.pipePath)
removePipeFileIfNeeded(options.pipePath)
process.chdir(ROOT_DIR)

const server = net.createServer((socket) => {
  resetIdleTimer(server, options.pipePath)

  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) {
      return
    }

    const rawRequest = buffer.slice(0, newlineIndex)
    requestQueue = requestQueue.then(() => handleRequest(socket, rawRequest))
  })
})

server.on('error', (error) => {
  // 이미 다른 데몬이 같은 파이프를 점유 중이면 그 데몬에 맡기고 조용히 종료합니다.
  // 그 외 listen 실패는 클라이언트가 로컬 폴백하도록 종료합니다(unhandled 크래시 방지).
  process.exit(error && error.code === 'EADDRINUSE' ? 0 : 1)
})

server.listen(options.pipePath, () => {
  resetIdleTimer(server, options.pipePath)
})
