'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { after, test } = require('node:test')
const vm = require('node:vm')

const ROOT_DIR = path.resolve(__dirname, '..')
const CLI_PATH = path.join(__dirname, 'index-pocketpages.js')
const CLI_SOURCE = fs.readFileSync(CLI_PATH, 'utf8')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'index-pocketpages-'))
const pagesRoot = path.join(fixture, 'pb_hooks', 'pages')
const relativeFile = 'entries/detail.ejs'

fs.mkdirSync(path.join(pagesRoot, 'entries'), { recursive: true })
fs.mkdirSync(path.join(pagesRoot, 'other'), { recursive: true })
fs.writeFileSync(
  path.join(fixture, 'pb_schema.json'),
  JSON.stringify([{ name: 'entries', type: 'base', fields: [{ name: 'title', type: 'text' }] }])
)
fs.writeFileSync(
  path.join(pagesRoot, relativeFile),
  `<script server>
const record = $app.findRecordById('entries', 'example')
const title = record.get('title')
record.set('title', title)
const records = $app.findRecordsByFilter('entries', 'title != ""', '-title', 10, 0)
</script>
<p><%= title %></p>
`
)
fs.writeFileSync(path.join(pagesRoot, 'entries/index.ejs'), '<p>Entries</p>')
fs.writeFileSync(path.join(pagesRoot, 'other/index.ejs'), '<p>Other</p>')
after(() => fs.rmSync(fixture, { recursive: true, force: true }))

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.ifError(result.error)
  return result
}

function readPayload(result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

// CLI 진입점 전체를 실행하되 OS별 경로와 인덱스 보고서만 대체한다.
function runPathCli(platform, fileSpecifier, { upperDrive = true, section = 'routes', reportOverrides = {} } = {}) {
  const windows = platform === 'win32'
  const pathApi = windows ? path.win32 : path.posix
  const root = windows ? `${upperDrive ? 'C' : 'c'}:\\repo` : '/repo'
  const appRoot = pathApi.join(root, 'apps', 'demo')
  const report = {
    service: 'demo',
    appRoot,
    pagesRoot: pathApi.join(appRoot, 'pb_hooks', 'pages'),
    routes: [
      { relativePath: relativeFile, routePath: '/entries/detail', method: 'GET' },
      { relativePath: 'entries/index.ejs', routePath: '/entries', method: 'GET' },
      { relativePath: 'other/index.ejs', routePath: '/other', method: 'GET' },
    ],
    ...reportOverrides,
  }
  let stdout = ''
  let stderr = ''
  let status = 0
  const exitSignal = {}
  try {
    vm.runInNewContext(
      CLI_SOURCE,
      {
        __dirname: pathApi.join(root, 'scripts'),
        require(name) {
          if (name === 'fs') return { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }
          if (name === 'path') return pathApi
          if (name === '../tools/vscode-pocketpages/packages/language-service/project-index-report') {
            return { buildProjectIndexReport: () => report }
          }
          throw new Error(`Unexpected require: ${name}`)
        },
        process: {
          platform,
          argv: ['node', CLI_PATH, 'demo', '--section', section, '--file', fileSpecifier, '--json'],
          stdout: {
            write: (text) => {
              stdout += text
            },
          },
          exit(code) {
            status = code
            throw exitSignal
          },
        },
        console: {
          error: (text) => {
            stderr += `${text}\n`
          },
        },
      },
      { filename: CLI_PATH, timeout: 1000 }
    )
  } catch (error) {
    if (error !== exitSignal) throw error
  }
  return { status, stdout, stderr }
}

for (const platform of ['linux', 'win32']) {
  test(`${platform}: pages/app/repo 상대 --file 정규화`, () => {
    for (const file of [
      relativeFile,
      `./${relativeFile}`,
      'entries/../entries/detail.ejs',
      `pb_hooks/pages/${relativeFile}`,
      `./pb_hooks/pages/${relativeFile}`,
      `apps/demo/pb_hooks/pages/${relativeFile}`,
      `./apps/demo/pb_hooks/pages/${relativeFile}`,
      'apps\\demo\\pb_hooks\\pages\\entries\\detail.ejs',
      'detail.ejs',
    ]) {
      const payload = readPayload(runPathCli(platform, file))
      assert.equal(payload.file, relativeFile, file)
      assert.equal(payload.routes.file, relativeFile, file)
    }
  })
}

test('절대 POSIX pages/app 경로의 선행 슬래시 보존', () => {
  for (const file of [
    `/repo/apps/demo/pb_hooks/pages/${relativeFile}`,
    '/repo/apps/demo/pb_hooks/pages/entries/../entries/detail.ejs',
  ]) {
    assert.equal(readPayload(runPathCli('linux', file)).file, relativeFile)
  }
})

test('Windows 드라이브 대소문자, 역슬래시 및 MSYS 절대 경로', () => {
  for (const upperDrive of [true, false]) {
    for (const file of [
      `C:/repo/apps/demo/pb_hooks/pages/${relativeFile}`,
      `c:/repo/apps/demo/pb_hooks/pages/${relativeFile}`,
      'c:\\repo\\apps\\demo\\pb_hooks\\pages\\entries\\detail.ejs',
      `/c/repo/apps/demo/pb_hooks/pages/${relativeFile}`,
      `/C/repo/apps/demo/pb_hooks/pages/${relativeFile}`,
    ]) {
      assert.equal(readPayload(runPathCli('win32', file, { upperDrive })).file, relativeFile, file)
    }
  }
})

test('resolveGraph와 impactByFile: sourceType 보존 및 기존 보고서 기본값', () => {
  for (const sourceType of ['resolve', 'require', undefined, null, '']) {
    const entry = {
      ...(sourceType === undefined ? {} : { sourceType }),
      sourceRelativePath: relativeFile,
      requestPath: 'entry-data',
      targetRelativePath: '_private/entry-data.js',
      targetKind: 'module',
    }
    const reportOverrides = {
      resolveGraph: { edges: [entry], targets: [] },
      impactByFile: [{ relativePath: relativeFile, resolveTargetsUsed: [entry] }],
    }
    for (const section of ['resolveGraph', 'impactByFile']) {
      const payload = readPayload(runPathCli('linux', relativeFile, { section, reportOverrides }))
      const entries =
        section === 'resolveGraph' ? payload.resolveGraph.outgoing : payload.impactByFile.resolveTargetsUsed
      assert.equal(entries.length, 1)
      assert.equal(entries[0].sourceType, sourceType || 'resolve')
      assert.equal(entries[0].requestPath, entry.requestPath)
      assert.equal(entries[0].targetFile, entry.targetRelativePath)
    }
  }
})

test('실제 CLI: 파일 경로 표기별 동일한 section-file 출력', () => {
  for (const file of [
    relativeFile,
    `pb_hooks/pages/${relativeFile}`,
    path.relative(ROOT_DIR, path.join(pagesRoot, relativeFile)),
    path.join(pagesRoot, relativeFile),
    'detail.ejs',
  ]) {
    const payload = readPayload(runCli([fixture, '--section', 'routes', '--file', file, '--json']))
    assert.equal(payload.mode, 'section-file')
    assert.equal(payload.file, relativeFile)
    assert.equal(payload.routes.file, relativeFile)
  }
})

test('실제 CLI: --file 누락값과 뒤따르는 옵션은 인자 오류', () => {
  for (const option of [null, '--json', '--pretty', '--section', '--file', '--unknown', '-x']) {
    const args = ['missing-service', '--file']
    if (option !== null) args.push(option)
    const result = runCli(args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^--file requires a relative path or file name\./)
  }
})

test('실제 CLI: 모호한 파일명과 존재하지 않는 파일은 거부', () => {
  for (const [file, message] of [
    ['index.ejs', /Ambiguous --file/],
    ['missing.ejs', /Unknown file for index query/],
  ]) {
    const result = runCli([fixture, '--file', file, '--json'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
  }
})

test('실제 CLI: schemaUsage와 impactByFile이 필드 접근 종류와 메서드를 보존', () => {
  const payload = readPayload(runCli([fixture, '--file', relativeFile, '--json']))
  assert.equal(payload.mode, 'file')
  const fields = payload.schemaUsage.fields
  const schemaFields = payload.impactByFile.schemaFields
  assert.ok(fields.length >= 4)
  assert.deepEqual(schemaFields, fields)
  for (const [accessKind, methodName] of [
    ['record-field', null],
    ['filter-field', 'findRecordsByFilter'],
    ['sort-field', 'findRecordsByFilter'],
  ]) {
    assert.ok(
      fields.some(
        (field) => field.fieldName === 'title' && field.accessKind === accessKind && field.methodName === methodName
      ),
      `누락된 필드 접근: ${accessKind}/${methodName}`
    )
  }
  for (const [section, key] of [
    ['schemaUsage', 'fields'],
    ['impactByFile', 'schemaFields'],
  ]) {
    const sectionPayload = readPayload(runCli([fixture, '--section', section, '--file', relativeFile, '--json']))
    assert.equal(sectionPayload.mode, 'section-file')
    assert.deepEqual(sectionPayload[section][key], fields)
  }
})
