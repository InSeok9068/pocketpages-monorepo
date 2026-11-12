import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
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

/** 객체와 예외 인자를 포함해 실제 로그에 노출될 값을 수집한다. */
function logHarness() {
  const messages = []
  const capture = (...args) =>
    messages.push(args.map((value) => (typeof value === 'string' ? value : inspect(value))).join(' '))
  return {
    logger: { dbg: capture, info: capture, warn: capture, error: capture },
    assertHidden(...secrets) {
      for (const secret of secrets) {
        assert.equal(
          messages.some((message) => message.includes(secret)),
          false,
          '민감정보가 로그에 노출됨'
        )
      }
    },
    messages,
  }
}

/** 쿠키 인증과 로그인 API를 실행할 최소 환경을 만든다. */
function authHarness(entry, { rawCookie, auth, findAuthRecordByToken = () => null } = {}) {
  const logging = logHarness()
  const cookies = []
  const lookups = []
  const enrichments = []
  const creations = []
  const password = 'PASSWORDLESS_PASSWORD_SENTINEL'
  const request = {
    auth,
    event: {},
    cookies(name) {
      assert.equal(name, 'pb_auth')
      return rawCookie
    },
  }
  const response = { cookie: (...args) => cookies.push(args) }
  const globalApi = {
    ...logging.logger,
    pb: () => ({
      collection(name) {
        assert.equal(name, 'users')
        return {
          create(data) {
            creations.push(data)
            return { id: 'created-user' }
          },
        }
      },
    }),
  }
  const factory = loadDist(
    entry,
    {},
    {
      ...logging.logger,
      $app: {
        findAuthRecordByToken(...args) {
          lookups.push(args)
          return findAuthRecordByToken(...args)
        },
      },
      $apis: { enrichRecord: (...args) => enrichments.push(args) },
      $security: { randomStringWithAlphabet: () => password },
    }
  )
  const plugin = factory({ globalApi })
  const api = { ...globalApi, request, response }
  plugin.onExtendContextApi({ api })
  return { plugin, api, request, response, cookies, lookups, enrichments, creations, password, ...logging }
}

/** 쿠키를 삭제하되 요청에 인증 정보를 설정하지 않았는지 확인한다. */
function assertCookieAuthRejected(harness) {
  assert.equal(harness.request.auth, undefined)
  assert.equal(harness.request.authToken, undefined)
  assert.equal(harness.enrichments.length, 0)
  assert.equal(harness.cookies.length, 1)
  const [name, value, options] = harness.cookies[0]
  assert.equal(name, 'pb_auth')
  assert.equal(value, '')
  assert.equal(options.maxAge, 0)
}

/** 부트스트랩과 정적 응답을 실행할 최소 PocketBase 환경을 만든다. */
function coreHarness(entry, { glob = () => [], directoryExists = true, logger = log } = {}) {
  const store = new Map()
  const existsCalls = []
  const globCalls = []
  const core = loadDist(
    entry,
    {
      'pocketbase-log': logger,
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
  if (readJson(app.packageFile).dependencies?.['pocketpages-plugin-auth']) {
    test(`${app.name}: 설치된 auth 패치`, async (t) => {
      const requireFromApp = createRequire(app.packageFile)
      const installed = installedPackage(requireFromApp, 'pocketpages-plugin-auth')
      t.diagnostic(`auth ${installed.version}: ${installed.entry}`)
      await t.test('auth 버전은 0.3.0', () => assert.equal(installed.version, '0.3.0'))

      await t.test('auth 토큰으로 조회하고 enrich 후 요청에 record와 token을 설정한다', () => {
        const token = 'VALID_AUTH_TOKEN_SENTINEL'
        const record = { id: 'auth-user', email: 'AUTH_RECORD_EMAIL_SENTINEL' }
        const harness = authHarness(installed.entry, {
          rawCookie: JSON.stringify({ token, record: { id: 'untrusted-cookie-user' } }),
          findAuthRecordByToken: () => record,
        })
        harness.plugin.onRequest(harness)
        assert.deepEqual(harness.lookups, [[token, 'auth']])
        assert.equal(harness.request.auth, record)
        assert.equal(harness.request.authToken, token)
        assert.deepEqual(harness.enrichments, [[harness.request.event, record]])
        assert.equal(harness.cookies.length, 0)
        harness.assertHidden(token, record.email)
      })

      for (const type of ['file', 'verifyEmail', 'changeEmail', 'passwordReset', 'expired', 'invalid']) {
        await t.test(`${type} 토큰은 거부하고 쿠키를 삭제한다`, () => {
          const token = `${type}_TOKEN_SENTINEL`
          const harness = authHarness(installed.entry, {
            rawCookie: JSON.stringify({ token }),
            findAuthRecordByToken(value, allowedType) {
              assert.equal(value, token)
              if (type === 'invalid') return null
              if (type === 'expired' || (allowedType && allowedType !== type)) {
                throw new Error(`rejected ${token}`)
              }
              return { id: 'non-auth-token-user' }
            },
          })
          harness.plugin.onRequest(harness)
          assertCookieAuthRejected(harness)
          assert.deepEqual(harness.lookups, [[token, 'auth']])
          harness.assertHidden(token)
        })
      }

      await t.test('기존 header 인증이 있으면 쿠키 조회와 인증 조회를 건너뛴다', () => {
        const auth = { id: 'header-user' }
        const harness = authHarness(installed.entry, { auth })
        harness.request.authToken = 'HEADER_TOKEN_SENTINEL'
        harness.request.cookies = () => assert.fail('기존 인증에서 쿠키를 조회함')
        harness.plugin.onRequest(harness)
        assert.equal(harness.request.auth, auth)
        assert.equal(harness.request.authToken, 'HEADER_TOKEN_SENTINEL')
        assert.equal(harness.lookups.length, 0)
        assert.equal(harness.enrichments.length, 0)
        assert.equal(harness.cookies.length, 0)
        harness.assertHidden('HEADER_TOKEN_SENTINEL')
      })

      await t.test('signIn은 쿠키 내용을 유지하지만 토큰과 record 내용을 로그에 남기지 않는다', () => {
        const harness = authHarness(installed.entry)
        const record = { id: 'signed-in-user', email: 'SIGN_IN_RECORD_SENTINEL' }
        const token = 'SIGN_IN_TOKEN_SENTINEL'
        harness.api.signIn({ token, record })
        assert.equal(harness.cookies.length, 1)
        assert.equal(harness.cookies[0][0], 'pb_auth')
        assert.deepEqual(JSON.parse(JSON.stringify(harness.cookies[0][1])), { token, record })
        harness.assertHidden(token, record.email)
      })

      await t.test('비밀번호 없는 계정 생성은 이메일과 생성 비밀번호를 로그에 남기지 않는다', () => {
        const harness = authHarness(installed.entry)
        const email = 'PASSWORDLESS_EMAIL_SENTINEL@example.com'
        const result = harness.api.createPaswordlessUser(email, { sendVerificationEmail: false })
        assert.equal(result.password, harness.password)
        assert.equal(result.user.id, 'created-user')
        assert.equal(harness.creations.length, 1)
        assert.deepEqual(JSON.parse(JSON.stringify(harness.creations[0])), {
          email,
          password: harness.password,
          passwordConfirm: harness.password,
        })
        harness.assertHidden(email, harness.password)
      })

      await t.test('잘못된 쿠키는 삭제하고 원문을 로그에 남기지 않는다', () => {
        const rawCookie = 'MALFORMED_COOKIE_SECRET_SENTINEL{'
        const harness = authHarness(installed.entry, { rawCookie })
        harness.plugin.onRequest(harness)
        assertCookieAuthRejected(harness)
        assert.equal(harness.lookups.length, 0)
        harness.assertHidden(rawCookie)
      })

      await t.test('인증 조회 예외는 쿠키를 삭제하고 예외 내용과 토큰을 로그에 남기지 않는다', () => {
        const token = 'THROWN_AUTH_TOKEN_SENTINEL'
        const errorText = `AUTH_EXCEPTION_DETAILS_SENTINEL: ${token}`
        const harness = authHarness(installed.entry, {
          rawCookie: JSON.stringify({ token }),
          findAuthRecordByToken() {
            throw new Error(errorText)
          },
        })
        harness.plugin.onRequest(harness)
        assertCookieAuthRejected(harness)
        harness.assertHidden(token, errorText, 'AUTH_EXCEPTION_DETAILS_SENTINEL')
      })
    })

    test(`${app.name}: 설치된 SDK 인증 로그 패치`, async (t) => {
      const installed = installedPackage(createRequire(app.packageFile), 'pocketpages-plugin-js-sdk')
      t.diagnostic(`js-sdk ${installed.version}: ${installed.entry}`)
      await t.test('SDK 버전은 0.3.0', () => assert.equal(installed.version, '0.3.0'))

      for (const mode of ['request', 'generated', 'anonymous']) {
        await t.test(`${mode}: SDK 저장값과 host는 유지하고 민감정보는 로그에서 제외한다`, () => {
          const logging = logHarness()
          const clients = []
          const saved = []
          const host = 'https://sdk-test.example.com'
          const token = 'SDK_AUTH_TOKEN_SENTINEL'
          let generated = 0
          const auth = {
            id: 'sdk-user',
            email: 'SDK_FULL_AUTH_RECORD_SENTINEL@example.com',
            nested: { secret: 'SDK_NESTED_RECORD_SENTINEL' },
            newAuthToken() {
              generated++
              return token
            },
          }
          class PocketBase {
            constructor(value) {
              this.host = value
              this.authStore = { save: (...args) => saved.push(args) }
              clients.push(this)
            }
          }
          const factory = loadDist(installed.entry, { 'pocketbase-js-sdk-jsvm': PocketBase }, logging.logger)
          const globalApi = { ...logging.logger }
          factory({ globalApi })
          const options =
            mode === 'request'
              ? { host, request: { auth, authToken: token } }
              : mode === 'generated'
                ? { host, auth }
                : { host }
          const client = globalApi.pb(options)
          assert.equal(clients.length, 1)
          assert.equal(client, clients[0])
          assert.equal(client.host, host)
          assert.equal(globalApi.pb(options), client)
          assert.equal(generated, mode === 'generated' ? 1 : 0)
          if (mode === 'anonymous') {
            assert.equal(saved.length, 0)
          } else {
            assert.equal(saved.length, 1)
            assert.equal(saved[0][0], token)
            assert.deepEqual(JSON.parse(JSON.stringify(saved[0][1])), JSON.parse(JSON.stringify(auth)))
            assert.ok(logging.messages.some((message) => message.includes(auth.id)))
          }
          assert.ok(logging.messages.some((message) => message.includes(host)))
          logging.assertHidden(token, auth.email, auth.nested.secret)
        })
      }
    })
  }

  test(`${app.name}: 설치된 core 패치`, async (t) => {
    const requireFromApp = createRequire(app.packageFile)
    const corePackage = installedPackage(requireFromApp, 'pocketpages')
    t.diagnostic(`core ${corePackage.version}: ${corePackage.entry}`)

    await t.test('core 버전은 0.22.5', () => {
      assert.equal(corePackage.version, '0.22.5')
    })

    await t.test('verbose 로그는 응답 헤더와 쿠키의 이름만 남기고 실제 값은 유지한다', () => {
      const logging = logHarness()
      const { core, store } = coreHarness(corePackage.entry, { logger: logging.logger })
      const headers = new Map()
      const cookies = []
      const token = 'CORE_AUTH_TOKEN_SENTINEL'
      store.set('__pocketpages_debug', true)
      store.set('pocketpages', {
        config: {
          debug: 'verbose',
          plugins: [
            () => ({
              name: 'auth-log-test',
              onRequest({ response }) {
                response.header('Authorization', `Bearer ${token}`)
                response.cookie('pb_auth', { token }, { httpOnly: true })
              },
            }),
          ],
        },
        routes: [],
      })
      core.MiddlewareHandler({
        request: {
          method: 'GET',
          url: { string: () => 'http://localhost/no-route' },
          header: { get: () => '' },
        },
        response: {
          header: () => ({
            get: (name) => headers.get(name),
            set: (name, value) => headers.set(name, value),
            add: (name, value) => cookies.push([name, value]),
          }),
        },
        next: noop,
      })
      assert.equal(headers.get('Authorization'), `Bearer ${token}`)
      assert.equal(cookies.length, 1)
      assert.equal(cookies[0][0], 'Set-Cookie')
      assert.ok(cookies[0][1].includes(token))
      assert.ok(cookies[0][1].includes('HttpOnly'))
      assert.ok(logging.messages.some((message) => message.includes('header: Authorization')))
      assert.ok(logging.messages.some((message) => message.includes('cookie: pb_auth')))
      logging.assertHidden(token)
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
