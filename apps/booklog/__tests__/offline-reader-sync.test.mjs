import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const readerLines = readFileSync(new URL('../pb_hooks/pages/assets/booklog-reader.js', import.meta.url), 'utf8').split(/\r?\n/)
const offlineLines = readFileSync(new URL('../pb_hooks/pages/assets/booklog-offline.js', import.meta.url), 'utf8').split(/\r?\n/)

// 오프라인에서 쓰지 않는 진단·독서 세션·완독 안내·진행률을 대신하는 자리라 일부러 다릅니다.
const OFFLINE_STANDINS = new Set([
  'traceReader',
  'isReaderTraceOn',
  'markReadingSessionActivity',
  'scheduleFinishPromptIfNeeded',
  'getProgressPercentFromLocator',
  'activeComponent',
])

function topLevelFunctions(lines) {
  const functions = new Map()
  lines.forEach((line, index) => {
    const match = /^ {2}function (\w+)\(/.exec(line)
    if (!match) return
    let end = index
    while (lines[end] !== '  }') end += 1
    functions.set(match[1], lines.slice(index, end + 1).join('\n'))
  })
  return functions
}

function topLevelVars(lines) {
  return new Map(
    lines
      .map((line) => /^ {2}var (\w+) = (.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  )
}

test('The offline shelf scrolls with the same functions and settings as the online reader', () => {
  const reader = topLevelFunctions(readerLines)
  const offline = topLevelFunctions(offlineLines)
  const shared = [...offline.keys()].filter((name) => reader.has(name) && !OFFLINE_STANDINS.has(name))
  assert.ok(shared.length >= 50, 'the scroll code is shared, not rewritten: ' + shared.length)
  for (const name of shared) {
    assert.equal(offline.get(name), reader.get(name), name + ' changed in booklog-reader.js; copy it to booklog-offline.js')
  }

  const readerVars = topLevelVars(readerLines)
  for (const [name, value] of topLevelVars(offlineLines)) {
    if (readerVars.has(name) && !OFFLINE_STANDINS.has(name)) assert.equal(value, readerVars.get(name), name)
  }
})
