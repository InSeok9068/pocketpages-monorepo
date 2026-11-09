import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

// 실행: node --test scripts/pocketpages-patches.test.mjs
// dist는 변형하지 않고 로드하며, PocketBase 런타임과 외부 의존성만 대체한다.
const root = fileURLToPath(new URL('../', import.meta.url))
const pagesRoot = '/app/pb_hooks/pages'
const noop = () => {}
const log = { dbg: noop, info: noop, warn: noop, error: noop }

/** JSON 파일을 읽는다. */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 호출 위치에서 실제 설치된 패키지를 해석한다. */
function installedPackage(requireFrom, name) {
  const entry = requireFrom.resolve(name)
  const metadata = readJson(path.resolve(path.dirname(entry), '../package.json'))
  return { entry, version: metadata.version }
}

/** 독립 VM에서 설치된 CommonJS dist 전체를 실행한다. */
function loadDist(entry, dependencies, globals = {}) {
  const module = { exports: {} }
  const context = vm.createContext({
    module,
    exports: module.exports,
    process: { env: {}, platform: 'linux' },
    dbg: noop,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `허용하지 않은 require: ${name}`)
      return dependencies[name]
    },
    ...globals,
  })
  vm.runInContext(readFileSync(entry, 'utf8'), context, {
    filename: entry,
    timeout: 1000,
  })
  return module.exports
}

/** 부트스트랩과 정적 응답을 실행할 최소 PocketBase 환경을 만든다. */
function coreHarness(entry, { glob = () => [], directoryExists = true } = {}) {
  const store = new Map()
  const existsCalls = []
  const globCalls = []
  const core = loadDist(
    entry,
    {
      'pocketbase-log': log,
      'pocketbase-stringify': { stringify: JSON.stringify },
      'pocketbase-node': {
        path: path.posix,
        fs: {
          existsSync(file, kind) {
            existsCalls.push([file, kind])
            if (file === pagesRoot) return directoryExists
            return false
          },
        },
      },
      'pocketpages-plugin-ejs': () => ({
        name: 'ejs',
        handles: ({ filePath }) => filePath.endsWith('.ejs'),
      }),
    },
    {
      __hooks: '/app/pb_hooks',
      $app: { store: () => store },
      $filepath: {
        join: path.posix.join,
        dir: path.posix.dirname,
        base: path.posix.basename,
        ext: path.posix.extname,
        toSlash: (file) => file.replaceAll('\\', '/'),
        walkDir(_directory, visit) {
          visit(`${pagesRoot}/nested/index.ejs`, { isDir: () => false }, null)
        },
        glob(pattern) {
          globCalls.push(pattern)
          return glob(pattern)
        },
      },
      $os: { readFile: () => 'template', dirFS: (directory) => directory },
      $security: { sha256: () => 'abc123' },
      toString: (value) => String(value),
    }
  )
  return { core, store, existsCalls, globCalls }
}

/** 실제 middleware를 통과시켜 정적 파일 응답과 헤더를 수집한다. */
function serveStatic(entry, { debug, pathname, fingerprint = 'abc123' }) {
  const { core, store } = coreHarness(entry)
  store.set('pocketpages', {
    config: { debug, plugins: [] },
    routes: [
      {
        relativePath: 'assets/app.css',
        absolutePath: `${pagesRoot}/assets/app.css`,
        segments: [{ nodeName: 'assets' }, { nodeName: 'app.css' }],
        fingerprint,
        isStatic: true,
        middlewares: [],
        layouts: [],
        loaders: {},
      },
    ],
  })
  const headers = new Map()
  const files = []
  core.MiddlewareHandler({
    request: {
      method: 'GET',
      url: { string: () => `http://localhost${pathname}` },
      header: { get: () => '' },
    },
    response: {
      header: () => ({
        get: (name) => headers.get(name),
        set: (name, value) => headers.set(name, value),
      }),
    },
    fileFS: (directory, file) => files.push([directory, file]),
    next: () => assert.fail('정적 파일이 next()로 빠짐'),
    html: (status, content) => assert.fail(`예상하지 않은 HTML ${status}: ${content}`),
  })
  assert.deepEqual(files, [[`${pagesRoot}/assets`, 'app.css']])
  return headers
}

/** EJS 플러그인의 include 해석기와 렌더 옵션을 관찰한다. */
function ejsHarness(entry, { platform = 'linux', root = pagesRoot, files = [], debug } = {}) {
  const existsCalls = []
  const renders = []
  const ejs = {
    compile: () => noop,
    resolveInclude: noop,
    includeFile: () => () => 'partial',
    renderFile(file, data, options) {
      renders.push({ file, data, options })
      return 'rendered'
    },
  }
  const factory = loadDist(
    entry,
    {
      'pocketbase-ejs': ejs,
      'pocketbase-stringify': { stringify: JSON.stringify },
      // pocketbase-node의 path는 Windows에서도 POSIX 경로 함수다.
      'pocketbase-node': {
        path: path.posix,
        fs: {
          existsSync(file, kind) {
            existsCalls.push([file, kind])
            return kind === 'file' && files.includes(file)
          },
        },
      },
    },
    {
      process: { env: {}, platform },
      $filepath: { ext: path.posix.extname },
    }
  )
  const plugin = factory({ pagesRoot: root, dbg: noop, config: { debug } })
  return { ejs, plugin, existsCalls, renders }
}

/** 파일 접근과 자식 프로세스 없이 패치 실행 스크립트의 오류 분기를 재현한다. */
function patchRunnerHarness({ entryError, detailsError, childError } = {}) {
  const entry = path.join(root, 'scripts/run-patch-package.js')
  const cwd = path.join(root, 'apps/sample')
  const globalPatches = path.join(root, 'scripts/patches')
  const patchEntry = path.join(cwd, 'node_modules/patch-package/dist/index.js')
  const detailsEntry = path.join(cwd, 'node_modules/patch-package/dist/PackageDetails.js')
  const exits = []
  const exitSignal = Symbol('process.exit')
  const messages = []
  const children = []
  const dependencies = {
    fs: {
      existsSync: (file) => file === globalPatches || file === path.join(cwd, 'node_modules/pocketpages'),
      readdirSync: () => ['pocketpages+0.22.5.patch'],
      copyFileSync: noop,
      rmSync: noop,
      mkdirSync: noop,
    },
    path,
    child_process: {
      execFileSync(...args) {
        children.push(args)
        throw childError
      },
    },
    [detailsEntry]: {
      getPackageDetailsFromPatchFilename: () => ({ path: 'node_modules/pocketpages', pathSpecifier: 'pocketpages' }),
    },
  }
  const requireStub = Object.assign(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `허용하지 않은 require: ${name}`)
      return dependencies[name]
    },
    {
      resolve(name) {
        if (name === 'patch-package/dist/index.js') {
          if (entryError) throw entryError
          return patchEntry
        }
        assert.equal(name, 'patch-package/dist/PackageDetails.js')
        if (detailsError) throw detailsError
        return detailsEntry
      },
    }
  )
  return {
    exits,
    messages,
    children,
    run() {
      try {
        loadDist(
          entry,
          {},
          {
            __dirname: path.dirname(entry),
            require: requireStub,
            console: { log: (message) => messages.push(message) },
            process: {
              cwd: () => cwd,
              execPath: '/stub/node',
              exit(status) {
                exits.push(status)
                // 실제 process.exit처럼 이후 코드를 실행하지 않는다.
                throw exitSignal
              },
            },
          }
        )
      } catch (error) {
        if (error !== exitSignal) throw error
      }
    },
  }
}

test('patch runner: 진짜 entry MODULE_NOT_FOUND만 성공으로 건너뛴다', () => {
  const entryError = Object.assign(new Error("Cannot find module 'patch-package/dist/index.js'"), {
    code: 'MODULE_NOT_FOUND',
  })
  const harness = patchRunnerHarness({ entryError })
  harness.run()
  assert.deepEqual(harness.exits, [0])
  assert.deepEqual(harness.messages, ['patch-package not installed, skip'])
  assert.equal(harness.children.length, 0)
})

test('patch runner: patch-package 자식 프로세스 status 1을 숨기지 않는다', () => {
  const childError = Object.assign(new Error("Command failed: node 'patch-package/dist/index.js'"), { status: 1 })
  const harness = patchRunnerHarness({ childError })
  assert.throws(harness.run, (error) => error === childError && error.status === 1)
  assert.deepEqual(harness.exits, [])
  assert.equal(harness.messages.includes('patch-package not installed, skip'), false)
  assert.equal(harness.children.length, 1)
})

test('patch runner: 다른 모듈의 MODULE_NOT_FOUND를 숨기지 않는다', () => {
  const detailsError = Object.assign(new Error("Cannot find module 'patch-package/dist/PackageDetails.js'"), {
    code: 'MODULE_NOT_FOUND',
  })
  const harness = patchRunnerHarness({ detailsError })
  assert.throws(harness.run, (error) => error === detailsError)
  assert.deepEqual(harness.exits, [])
  assert.equal(harness.messages.includes('patch-package not installed, skip'), false)
  assert.equal(harness.children.length, 0)
})

const apps = readdirSync(path.join(root, 'apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    packageFile: path.join(root, 'apps', entry.name, 'package.json'),
  }))
  .filter(({ packageFile }) => readJson(packageFile).dependencies?.pocketpages)
assert.ok(apps.length > 0, 'PocketPages 앱이 없음')

for (const app of apps) {
  test(`${app.name}: 설치된 core 패치`, async (t) => {
    const requireFromApp = createRequire(app.packageFile)
    const corePackage = installedPackage(requireFromApp, 'pocketpages')
    t.diagnostic(`core ${corePackage.version}: ${corePackage.entry}`)

    await t.test('core 버전은 0.22.5', () => {
      assert.equal(corePackage.version, '0.22.5')
    })

    await t.test('pagesRoot를 dir 종류로 확인한다', () => {
      const harness = coreHarness(corePackage.entry)
      harness.core.AfterBootstrapHandler({})
      assert.deepEqual(harness.existsCalls[0], [pagesRoot, 'dir'])
      assert.equal(harness.store.get('pocketpages').routes.length, 1)
    })

    await t.test('pagesRoot 디렉터리가 없으면 실패한다', () => {
      const harness = coreHarness(corePackage.entry, { directoryExists: false })
      assert.throws(() => harness.core.AfterBootstrapHandler({}), /must exist/)
      assert.deepEqual(harness.existsCalls[0], [pagesRoot, 'dir'])
      assert.equal(harness.store.has('pocketpages'), false)
    })

    for (const [name, glob] of [
      ['빈 배열', () => []],
      ['null', () => null],
      ['undefined', () => undefined],
      [
        '예외',
        () => {
          throw new Error('glob: no matches')
        },
      ],
    ]) {
      await t.test(`layout glob ${name}이면 상위 디렉터리까지 계속 탐색한다`, () => {
        const harness = coreHarness(corePackage.entry, { glob })
        harness.core.AfterBootstrapHandler({})
        assert.deepEqual(harness.globCalls, [`${pagesRoot}/nested/+layout.*`, `${pagesRoot}/+layout.*`])
        assert.equal(harness.store.get('pocketpages').routes[0].layouts.length, 0)
      })
    }

    await t.test('layout 하나는 적용하고 중복 layout은 여전히 거부한다', () => {
      const layout = `${pagesRoot}/+layout.ejs`
      const one = coreHarness(corePackage.entry, {
        glob: (pattern) => (pattern === `${pagesRoot}/+layout.*` ? [layout] : []),
      })
      one.core.AfterBootstrapHandler({})
      assert.deepEqual(Array.from(one.store.get('pocketpages').routes[0].layouts), [layout])
      const multiple = coreHarness(corePackage.entry, { glob: () => [layout, `${layout}.html`] })
      assert.throws(() => multiple.core.AfterBootstrapHandler({}), /Multiple layouts found/)
    })

    for (const scenario of [
      { name: 'production fingerprint', debug: false, pathname: '/assets/app.abc123.css', cached: true },
      { name: 'production fingerprint + query', debug: false, pathname: '/assets/app.abc123.css?v=1', cached: true },
      { name: 'debug fingerprint', debug: true, pathname: '/assets/app.abc123.css', cached: false },
      { name: 'verbose debug fingerprint', debug: 'verbose', pathname: '/assets/app.abc123.css', cached: false },
      { name: 'production 원본 이름', debug: false, pathname: '/assets/app.css', cached: false },
      {
        name: 'production fingerprint 없음',
        debug: false,
        pathname: '/assets/app.css',
        fingerprint: '',
        cached: false,
      },
    ]) {
      await t.test(`static cache: ${scenario.name}`, () => {
        const headers = serveStatic(corePackage.entry, scenario)
        assert.equal(headers.get('Cache-Control'), scenario.cached ? 'public, max-age=31536000, immutable' : undefined)
      })
    }
  })

  test(`${app.name}: 설치된 EJS 패치`, async (t) => {
    const requireFromApp = createRequire(app.packageFile)
    const coreEntry = requireFromApp.resolve('pocketpages')
    const packages = [
      ['app', installedPackage(requireFromApp, 'pocketpages-plugin-ejs')],
      ['core', installedPackage(createRequire(coreEntry), 'pocketpages-plugin-ejs')],
    ]
    const seen = new Set()
    for (const [origin, installed] of packages) {
      if (seen.has(installed.entry)) continue
      seen.add(installed.entry)
      await t.test(`${origin} EJS ${installed.version}`, async (t) => {
        t.diagnostic(installed.entry)
        await t.test('EJS 버전은 0.2.0', () => assert.equal(installed.version, '0.2.0'))

        for (const format of ['slash', 'backslash']) {
          await t.test(`Windows ${format} 파일 후보와 상위 _private를 찾는다`, () => {
            const root = 'C:\\app\\pb_hooks\\pages'
            const expected =
              format === 'slash'
                ? 'C:/app/pb_hooks/pages/_private/ui/card.ejs'
                : 'C:\\app\\pb_hooks\\pages\\_private\\ui\\card.ejs'
            const { ejs, existsCalls } = ejsHarness(installed.entry, {
              platform: 'win32',
              root,
              files: [expected],
            })
            assert.equal(ejs.resolveInclude('ui\\card', `${root}\\books\\detail.ejs`, false), expected)
            assert.ok(existsCalls.every(([, kind]) => kind === 'file'))
          })
        }

        await t.test('Windows isDir include의 역슬래시를 정규화한다', () => {
          const { ejs } = ejsHarness(installed.entry, {
            platform: 'win32',
            root: 'C:\\app\\pb_hooks\\pages',
          })
          assert.equal(ejs.resolveInclude('_private\\card.ejs', '', true), 'C:/app/pb_hooks/pages/_private/card.ejs')
        })

        await t.test('Linux에서 가까운 _private가 루트보다 우선한다', () => {
          const nearest = `${pagesRoot}/books/_private/card.ejs`
          const { ejs } = ejsHarness(installed.entry, {
            files: [nearest, `${pagesRoot}/_private/card.ejs`],
          })
          assert.equal(ejs.resolveInclude('card', `${pagesRoot}/books/detail.ejs`, false), nearest)
        })

        await t.test('Linux에서 루트 _private까지 탐색하고 정확한 파일명을 우선한다', () => {
          const exact = `${pagesRoot}/_private/card`
          const { ejs, existsCalls } = ejsHarness(installed.entry, {
            files: [exact, `${exact}.ejs`],
          })
          assert.equal(ejs.resolveInclude('card', `${pagesRoot}/books/deep/detail.ejs`, false), exact)
          assert.ok(existsCalls.some(([file]) => file === `${pagesRoot}/books/_private/card.ejs`))
        })

        await t.test('없는 partial은 루트 밖을 탐색하지 않고 실패한다', () => {
          const { ejs, existsCalls } = ejsHarness(installed.entry)
          assert.throws(
            () => ejs.resolveInclude('missing', `${pagesRoot}/books/detail.ejs`, false),
            /No partial 'missing'.*Tried:/
          )
          assert.ok(existsCalls.length > 0)
          assert.ok(existsCalls.every(([file]) => file.startsWith(`${pagesRoot}/`)))
        })

        for (const [debug, expected] of [
          [undefined, true],
          [false, true],
          [true, false],
          ['verbose', false],
        ]) {
          await t.test(`template cache: debug=${String(debug)} -> ${expected}`, () => {
            const { plugin, renders } = ejsHarness(installed.entry, { debug })
            for (let index = 0; index < 2; index++) {
              assert.equal(
                plugin.onRender({
                  api: {},
                  filePath: `${pagesRoot}/index.ejs`,
                  plugins: [plugin],
                }),
                'rendered'
              )
            }
            assert.equal(renders.length, 2)
            for (const { options } of renders) {
              assert.equal(options.cache, expected)
              assert.equal(options.async, false)
              assert.equal(options.root, pagesRoot)
            }
          })
        }
      })
    }
  })
}
