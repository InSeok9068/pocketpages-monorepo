import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// 실행: node --test scripts/pocketpages-include-paths.test.mjs
const root = fileURLToPath(new URL('../', import.meta.url))
const noop = () => {}
const slash = (value) => value.replaceAll('\\', '/')

/** 의존성 디렉터리를 제외한 EJS와 JS 소스를 정렬해서 수집한다. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(filename)
      return /\.(ejs|js)$/.test(entry.name) ? [filename] : []
    })
}

/** 모든 include 후보와 독립 추출한 고정 문자열을 대조한다. */
function auditIncludes(directory) {
  const calls = []
  const literals = []
  for (const filename of sourceFiles(directory)) {
    const source = readFileSync(filename, 'utf8')
    for (const match of source.matchAll(/\binclude\s*\(/g)) {
      calls.push({
        filename,
        offset: match.index,
        line: source.slice(0, match.index).split('\n').length,
        evidence: source.slice(match.index).split('\n')[0],
      })
    }
    // 문자열 뒤가 연산자이면 동적 표현식이다. 템플릿 보간도 고정값으로 취급하지 않는다.
    const fixed =
      /\binclude\s*\(\s*((?:'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`))\s*(?=[,)])/g
    for (const match of source.matchAll(fixed)) {
      if (match[1].startsWith('`') && match[1].includes('${')) continue
      literals.push({
        filename,
        offset: match.index,
        name: vm.runInNewContext(match[1], {}, { timeout: 1000 }),
      })
    }
  }
  const dynamic = calls.filter(
    (call) => !literals.some((item) => item.filename === call.filename && item.offset === call.offset)
  )
  return { calls, literals, dynamic }
}

/** 패치 계약에 어긋나는 include 이름을 식별한다. 실제 resolver는 별도로 검증한다. */
function forbiddenName(name) {
  const normalized = slash(name)
  return (
    name.length === 0
    || name.includes('\0')
    || name.includes(':')
    || normalized.startsWith('//')
    || normalized.split('/').some((part) => part.trim() === '..')
  )
}

/** 실제 파일이 지정 루트 안의 일반 파일인지 확인한다. 심볼릭 링크 검사는 범위 밖이다. */
function assertInsideFile(pagesRoot, filename) {
  const relative = path.relative(path.resolve(pagesRoot), path.resolve(filename))
  assert.ok(
    relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    `pagesRoot 이탈: ${filename} (root=${pagesRoot})`
  )
  assert.ok(existsSync(filename), `파일 없음: ${filename}`)
  assert.ok(statSync(filename).isFile(), `일반 파일이 아님: ${filename}`)
}

/** 설치된 플러그인만 VM에서 실행하고 파일 존재 여부는 실제 디스크에서 판정한다. */
function createHarness(app, pagesRoot, platform) {
  const requireFromApp = createRequire(path.join(root, 'apps', app, 'package.json'))
  const entry = requireFromApp.resolve('pocketpages-plugin-ejs')
  const existsCalls = []
  const ejs = {
    compile: () => noop,
    resolveInclude: noop,
    includeFile: () => noop,
    renderFile: () => '',
  }
  const dependencies = {
    'pocketbase-ejs': ejs,
    'pocketbase-stringify': { stringify: JSON.stringify },
    // pocketbase-node는 Windows에서도 POSIX path를 제공한다.
    'pocketbase-node': {
      path: path.posix,
      fs: {
        existsSync(filename, kind) {
          existsCalls.push({ filename, kind })
          return existsSync(filename) && (kind !== 'file' || statSync(filename).isFile())
        },
      },
    },
  }
  const module = { exports: {} }
  const context = vm.createContext({
    module,
    exports: module.exports,
    process: { env: {}, platform },
    $filepath: { ext: path.posix.extname },
    dbg: noop,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `허용하지 않은 require: ${name}`)
      return dependencies[name]
    },
  })
  vm.runInContext(readFileSync(entry, 'utf8'), context, { filename: entry, timeout: 1000 })
  module.exports({ pagesRoot, dbg: noop, config: { debug: false } })
  return { ejs, existsCalls, entry }
}

/** 루트 include도 엔진에서 전달하는 isDir 분기로 해석한다. */
function resolveCall(ejs, name, filename, pagesRoot) {
  return name.startsWith('/')
    ? ejs.resolveInclude(name.slice(1), pagesRoot, true)
    : ejs.resolveInclude(name, filename, false)
}

/** 정적 조사 결과를 재실행 가능한 호출 수와 문자열별 집계로 출력한다. */
function reportAudit(t, label, audit) {
  const counts = {}
  for (const { name } of audit.literals) counts[name] = (counts[name] || 0) + 1
  t.diagnostic(
    JSON.stringify({
      scope: label,
      calls: audit.calls.length,
      fixed: audit.literals.length,
      dynamic: audit.dynamic.length,
      strings: counts,
      dynamicEvidence: audit.dynamic.map((call) => ({
        file: slash(path.relative(root, call.filename)),
        line: call.line,
        source: call.evidence,
      })),
    })
  )
  assert.equal(audit.calls.length, audit.literals.length + audit.dynamic.length)
  assert.deepEqual(
    audit.dynamic,
    [],
    '미검토 동적 include: 위 호출 근거를 확인하고 가능한 경로의 허용 목록 및 resolve 검증을 추가해야 함'
  )
  const conflicts = audit.literals.filter(({ name }) => forbiddenName(name))
  assert.deepEqual(conflicts, [], '기존 고정 include와 경로 차단 정책이 충돌함')
}

const apps = readdirSync(path.join(root, 'apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    const metadata = JSON.parse(readFileSync(path.join(root, 'apps', name, 'package.json'), 'utf8'))
    return metadata.dependencies?.pocketpages
  })
  .sort()

assert.ok(apps.length > 0, 'PocketPages 앱이 없음')

for (const app of apps) {
  const directory = path.join(root, 'apps', app, 'pb_hooks', 'pages')
  const audit = auditIncludes(directory)
  test(`${app}: 모든 EJS/JS include 호출과 차단 정책 대조`, (t) => {
    reportAudit(t, app, audit)
  })

  // Linux 운영형 slash 경로는 실제 저장소 상대 주소다. 가상 파일 목록이나 exists 모킹이 아니다.
  const modes = [
    { label: 'Linux slash 상대 경로', platform: 'linux', pagesRoot: slash(path.relative(root, directory)) },
  ]
  if (process.platform === 'win32') {
    modes.push({ label: 'Windows 실제 절대 경로', platform: 'win32', pagesRoot: directory })
  }
  for (const mode of modes) {
    test(`${app}: ${mode.label}의 모든 기존 include가 실제 내부 파일을 가리킨다`, (t) => {
      assert.equal(path.resolve('.'), path.resolve(root), '저장소 루트에서 테스트를 실행해야 함')
      const { ejs, existsCalls, entry } = createHarness(app, mode.pagesRoot, mode.platform)
      t.diagnostic(entry)
      for (const call of audit.literals) {
        const filename = mode.platform === 'linux' ? slash(path.relative(root, call.filename)) : call.filename
        const location = `${slash(path.relative(root, call.filename))}:${
          audit.calls.find((item) => item.filename === call.filename && item.offset === call.offset).line
        }`
        let resolved
        assert.doesNotThrow(
          () => {
            resolved = resolveCall(ejs, call.name, filename, mode.pagesRoot)
          },
          `${location} include(${JSON.stringify(call.name)})`
        )
        assertInsideFile(mode.pagesRoot, resolved)
        if (mode.platform === 'win32') {
          assert.match(resolved, /^[A-Za-z]:[/\\]/, '실제 Windows 드라이브 절대 경로여야 함')
          assert.ok(existsSync(slash(resolved)), `Windows slash 후보 없음: ${resolved}`)
          assert.ok(existsSync(slash(resolved).replaceAll('/', '\\')), `Windows backslash 후보 없음: ${resolved}`)
        }
        // 같은 이름의 다른 파일로 잘못 resolve하는 회귀도 잡는다.
        let current = path.dirname(call.filename)
        let expected
        if (call.name.startsWith('/')) expected = path.join(directory, call.name.slice(1))
        else {
          while (true) {
            const candidate = path.join(current, '_private', slash(call.name))
            expected = [candidate, `${candidate}.ejs`].find((value) => existsSync(value) && statSync(value).isFile())
            if (expected || current === directory) break
            current = path.dirname(current)
          }
        }
        assert.ok(expected, `${location}: 기존 탐색 규칙의 대상 파일이 없음`)
        assert.equal(path.resolve(resolved), path.resolve(expected), location)
      }
      assert.ok(existsCalls.every((call) => call.kind === 'file'))
      for (const call of existsCalls) {
        const relative = path.relative(path.resolve(mode.pagesRoot), path.resolve(call.filename))
        assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      }
      t.diagnostic(`실제 파일 resolve ${audit.literals.length}건, existsSync ${existsCalls.length}회`)
    })
  }

  test(`${app}: 설치된 resolver의 경로 차단 및 정상 이름 계약`, async (t) => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'pocketpages-include-'))
    try {
      const pages = path.join(temporary, 'pages')
      const files = [
        'catalog/detail.ejs',
        'catalog/_private/card.ejs',
        '_private/card.ejs',
        '_private/ui/card.ejs',
        '_private/...card.ejs',
        '_private/card...ejs',
        '_private/exact',
        '_private/exact.ejs',
        'outside.ejs',
      ]
      for (const file of files) {
        const filename = path.join(pages, file)
        mkdirSync(path.dirname(filename), { recursive: true })
        writeFileSync(filename, 'fixture')
      }
      // 이탈 대상도 실제로 만들어 단순한 파일 부재를 차단 성공으로 오인하지 않는다.
      writeFileSync(path.join(temporary, 'outside.ejs'), 'outside')
      const sibling = path.join(temporary, 'pages-sibling', '_private')
      mkdirSync(sibling, { recursive: true })
      writeFileSync(path.join(sibling, 'card.ejs'), 'sibling')
      const variants = [
        { platform: 'linux', pagesRoot: slash(path.relative(root, pages)) },
        ...(process.platform === 'win32' ? [{ platform: 'win32', pagesRoot: pages }] : []),
      ]
      for (const mode of variants) {
        const { ejs, existsCalls } = createHarness(app, mode.pagesRoot, mode.platform)
        const template = `${mode.pagesRoot}/catalog/detail.ejs`
        const forbidden = [
          '',
          '\0',
          'card\0.ejs',
          ':',
          'C:/outside.ejs',
          'C:\\outside.ejs',
          'C:outside.ejs',
          'card.ejs:stream',
          'https://example.test/card',
          '//server/card',
          '\\\\server\\card',
          '/\\server/card',
          '\\/server/card',
          '..',
          '../outside.ejs',
          '..\\outside.ejs',
          'ui/../card',
          'ui\\..\\card',
          '/../../outside.ejs',
          'ui//../card',
          'ui/.. /card',
          'ui/ .. /card',
        ]
        for (const name of forbidden) {
          for (const isDir of [false, true]) {
            await t.test(`${mode.platform} 거부 ${JSON.stringify(name)} isDir=${isDir}`, () => {
              existsCalls.length = 0
              assert.throws(() => ejs.resolveInclude(name, template, isDir))
              assert.equal(existsCalls.length, 0, '잘못된 이름은 디스크 탐색 전에 거부해야 함')
            })
          }
        }
        const allowed = [
          ['card', 'catalog/_private/card.ejs', false],
          ['./card', 'catalog/_private/card.ejs', false],
          ['ui/./card', '_private/ui/card.ejs', false],
          ['ui\\card', '_private/ui/card.ejs', false],
          ['...card.ejs', '_private/...card.ejs', false],
          ['card...ejs', '_private/card...ejs', false],
          ['exact', '_private/exact', false],
          ['/_private/card.ejs', '_private/card.ejs', true],
          ['_private/./card.ejs', '_private/card.ejs', true],
          ['_private\\ui\\card.ejs', '_private/ui/card.ejs', true],
        ]
        for (const [name, expected, isDir] of allowed) {
          await t.test(`${mode.platform} 허용 ${JSON.stringify(name)} isDir=${isDir}`, () => {
            const resolved = ejs.resolveInclude(name, template, isDir)
            assertInsideFile(mode.pagesRoot, resolved)
            assert.equal(path.resolve(resolved), path.resolve(pages, expected))
          })
        }
        await t.test(`${mode.platform} 이름 접두사가 같은 형제 디렉터리는 탐색하지 않는다`, () => {
          existsCalls.length = 0
          assert.throws(() => ejs.resolveInclude('card', `${mode.pagesRoot}-sibling/index.ejs`, false))
          assert.equal(existsCalls.length, 0)
        })
        await t.test(`${mode.platform} 없는 partial은 루트 안에서만 탐색한다`, () => {
          existsCalls.length = 0
          assert.throws(() => ejs.resolveInclude('missing', template, false))
          assert.ok(existsCalls.length > 0)
          for (const { filename } of existsCalls) {
            const relative = path.relative(pages, path.resolve(filename))
            assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
          }
        })
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
}

test('정적 추출: 연결식·템플릿 보간·변수 include를 누락 없이 동적으로 분류한다', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'pocketpages-include-audit-'))
  try {
    writeFileSync(
      path.join(temporary, 'calls.js'),
      [
        `include('card.ejs')`,
        `include("card.ejs", {})`,
        'include(`card.ejs`)',
        `include('card-' + kind)`,
        'include(`card-${kind}.ejs`)',
        'include(partialName)',
        `include(\n  'card.ejs'\n)`,
      ].join('\n')
    )
    const audit = auditIncludes(temporary)
    assert.equal(audit.calls.length, 7)
    assert.equal(audit.literals.length, 4)
    assert.equal(audit.dynamic.length, 3)
    assert.deepEqual(
      audit.literals.map((call) => call.name),
      Array(4).fill('card.ejs')
    )
    assert.deepEqual(
      audit.dynamic.map((call) => call.line),
      [4, 5, 6]
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('packages: 모든 EJS/JS include 호출과 고정/동적 추출 수 대조', (t) => {
  reportAudit(t, 'packages', auditIncludes(path.join(root, 'packages')))
})
