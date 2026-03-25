#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { buildProjectIndexReport } = require('../tools/vscode-pocketpages/src/project-index-report')

const ROOT_DIR = path.resolve(__dirname, '..')
const APPS_DIR = path.join(ROOT_DIR, 'apps')
const SECTION_NAMES = new Set(['routes', 'partials', 'resolveGraph', 'routeLinks', 'schemaUsage', 'impactByFile'])

/**
 * Git Bash 스타일 경로를 현재 런타임 경로로 바꿉니다.
 * @param {string} value 사용자 입력 경로입니다.
 * @returns {string} 현재 런타임에서 읽을 수 있는 경로입니다.
 */
function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`
  }

  return value
}

/**
 * 서비스 인자를 실제 서비스 루트 경로로 정리합니다.
 * @param {string | undefined} rawArg 서비스 이름 또는 경로입니다.
 * @returns {string} 서비스 절대 경로입니다.
 */
function resolveServiceDir(rawArg) {
  if (!rawArg) {
    throw new Error('Usage: node scripts/index-pocketpages.js <service> [--json|--pretty] [--section name]')
  }

  const asPath = path.resolve(fromMsysPath(rawArg))
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory() && fs.existsSync(path.join(asPath, 'pb_hooks', 'pages'))) {
    return asPath
  }

  const serviceDir = path.join(APPS_DIR, rawArg)
  if (fs.existsSync(serviceDir) && fs.statSync(serviceDir).isDirectory() && fs.existsSync(path.join(serviceDir, 'pb_hooks', 'pages'))) {
    return serviceDir
  }

  throw new Error(`Unknown service path: ${rawArg}`)
}

/**
 * CLI 인자를 해석합니다.
 * @param {string[]} argv process.argv.slice(2) 결과입니다.
 * @returns {{ serviceArg: string | undefined, pretty: boolean, section: string | null }} 파싱 결과입니다.
 */
function parseArgs(argv) {
  let serviceArg
  let pretty = true
  let section = null

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (!value) {
      continue
    }

    if (value === '--json') {
      pretty = false
      continue
    }

    if (value === '--pretty') {
      pretty = true
      continue
    }

    if (value === '--section') {
      const nextValue = argv[index + 1]
      if (!nextValue) {
        throw new Error('--section requires a section name.')
      }

      if (!SECTION_NAMES.has(nextValue)) {
        throw new Error(`Unknown section: ${nextValue}`)
      }

      section = nextValue
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`)
    }

    if (!serviceArg) {
      serviceArg = value
      continue
    }

    throw new Error(`Unexpected argument: ${value}`)
  }

  return {
    serviceArg,
    pretty,
    section,
  }
}

/**
 * 섹션 옵션이 있으면 해당 섹션만 남긴 결과를 만듭니다.
 * @param {object} report 전체 보고서입니다.
 * @param {string | null} section 남길 섹션 이름입니다.
 * @returns {object} 출력용 보고서입니다.
 */
function selectSection(report, section) {
  if (!section) {
    return report
  }

  return {
    service: report.service,
    appRoot: report.appRoot,
    pagesRoot: report.pagesRoot,
    generatedAt: report.generatedAt,
    [section]: report[section],
  }
}

function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
  }

  let serviceDir
  try {
    serviceDir = resolveServiceDir(parsed.serviceArg)
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
  }

  const report = buildProjectIndexReport({
    appRoot: serviceDir,
  })
  const payload = selectSection(report, parsed.section)
  const spacing = parsed.pretty ? 2 : 0

  process.stdout.write(`${JSON.stringify(payload, null, spacing)}\n`)
}

main()
