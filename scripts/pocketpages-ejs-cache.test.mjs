import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// 실행: node --test scripts/pocketpages-ejs-cache.test.mjs
const root = fileURLToPath(new URL('../', import.meta.url))
const pagesRoot = '/app/pb_hooks/pages'
const page = `${pagesRoot}/catalog/detail.ejs`
const card = `${pagesRoot}/catalog/_private/card.ejs`
const noop = () => {}

/** 설치된 플러그인과 엔진을 메모리 파일 시스템 위에서 실행한다. */
function createHarness(requireFromApp, templates) {
  const pluginEntry = requireFromApp.resolve('pocketpages-plugin-ejs')
  const engineEntry = createRequire(pluginEntry).resolve('pocketbase-ejs')
  const files = new Map(Object.entries(templates))
  const modules = new Map()
  const compilations = []
  const memoryNode = {
    path: path.posix,
    fs: {
      existsSync(filename, kind) {
        return (kind === undefined || kind === 'file') && files.has(filename)
      },
      readFileSync(filename) {
        assert.ok(files.has(filename), `메모리 템플릿이 없음: ${filename}`)
        return files.get(filename)
      },
    },
  }
  const context = vm.createContext({
    process: { env: {}, platform: 'linux' },
    $filepath: { ext: path.posix.extname },
    dbg: noop,
  })

  // 상대 경로 utils.js도 같은 VM과 CommonJS 캐시에서 실제 설치본으로 로드한다.
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    const requireFromModule = createRequire(filename)
    const requireInVm = (name) => {
      if (name === 'pocketbase-node') return memoryNode
      if (name === 'pocketbase-stringify') return { stringify: JSON.stringify }
      if (name === 'pocketbase-ejs' || name.startsWith('.')) {
        return load(requireFromModule.resolve(name))
      }
      assert.fail(`허용하지 않은 require: ${name} (${filename})`)
    }
    const wrapper = vm.runInContext(
      `(function (exports, require, module, __filename, __dirname) {\n${readFileSync(filename, 'utf8')}\n})`,
      context,
      { filename, timeout: 1000 }
    )
    wrapper(module.exports, requireInVm, module, filename, path.dirname(filename))
    return module.exports
  }

  const ejs = load(engineEntry)
  const originalCompile = ejs.compile
  // factory가 compile을 재설정하므로 플러그인의 oldCompile 캡처 전에 계측한다.
  ejs.compile = function (source, options) {
    compilations.push({ filename: options.filename, includeFile: options.includeFile })
    return originalCompile.call(this, source, options)
  }
  const factory = load(pluginEntry)
  assert.strictEqual(load(engineEntry), ejs)

  return {
    ejs,
    compilations,
    pluginEntry,
    engineEntry,
    plugin(debug = false) {
      return factory({ pagesRoot, dbg: noop, config: { debug } })
    },
  }
}

/** 요청별 플러그인 호출과 include 데이터를 기록한다. */
function createRequest(plugin, id, transform = (context) => context.content) {
  const calls = []
  const request = { id }
  const routes = [{ relativePath: `/${id}`, marker: id }]
  const api = { value: `${id}-value`, request, localOnly: 'page-local' }
  const observer = {
    name: `observer-${id}`,
    onRender(context) {
      calls.push(context)
      return transform(context)
    },
  }
  const context = {
    api,
    request,
    routes,
    route: routes[0],
    plugins: [plugin, observer],
    filePath: page,
    content: `unrendered-${id}`,
  }
  return { calls, context, render: () => plugin.onRender(context) }
}

/** 후처리기가 현재 요청과 include locals를 받았는지 검증한다. */
function assertInclude(call, current, filename, value, localOnly = 'include-local') {
  assert.equal(call.filePath, filename)
  for (const key of ['request', 'routes', 'route', 'plugins']) {
    assert.strictEqual(call[key], current.context[key], `${key}는 현재 요청이어야 함`)
  }
  assert.equal(call.api.value, value)
  assert.equal(call.api.localOnly, localOnly)
  assert.strictEqual(call.api.request, current.context.request)
  assert.strictEqual(call.api.api, current.context.api)
}

const basicTemplates = {
  [page]:
    '<script server>const label = value + "-local";</script>page:<%- include("card", { value: label, localOnly: "include-local" }) %>',
  [card]: '<%= value %>|<%= localOnly %>|<%= request.id %>|<%= api.request.id %>',
}

const apps = readdirSync(path.join(root, 'apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    requireFromApp: createRequire(path.join(root, 'apps', entry.name, 'package.json')),
    packageFile: path.join(root, 'apps', entry.name, 'package.json'),
  }))
  .filter(({ packageFile }) => JSON.parse(readFileSync(packageFile, 'utf8')).dependencies?.pocketpages)

assert.ok(apps.length > 0, 'PocketPages 앱이 없음')

for (const app of apps) {
  test(`${app.name}: 설치된 EJS 캐시와 요청 컨텍스트`, async (t) => {
    const requireFromApp = app.requireFromApp
    t.diagnostic(requireFromApp.resolve('pocketpages-plugin-ejs'))
    t.diagnostic(createRequire(requireFromApp.resolve('pocketpages-plugin-ejs')).resolve('pocketbase-ejs'))

    await t.test('debug=false: factory A/B의 현재 요청과 locals만 사용한다', () => {
      const harness = createHarness(requireFromApp, basicTemplates)
      const a = createRequest(harness.plugin(), 'A', (context) => `[A:${context.content}]`)
      assert.equal(a.render(), 'page:[A:A-value-local|include-local|A|A]')
      assert.equal(a.calls.length, 1)
      assertInclude(a.calls[0], a, card, 'A-value-local')

      const b = createRequest(harness.plugin(), 'B', (context) => `[B:${context.content}]`)
      assert.equal(b.render(), 'page:[B:B-value-local|include-local|B|B]')
      assert.equal(a.calls.length, 1, 'B 렌더가 A의 플러그인을 호출하면 안 됨')
      assert.equal(b.calls.length, 1)
      assertInclude(b.calls[0], b, card, 'B-value-local')
    })

    await t.test('debug=false: factory가 달라도 page와 partial 컴파일 함수를 재사용한다', () => {
      const harness = createHarness(requireFromApp, basicTemplates)
      createRequest(harness.plugin(), 'A').render()
      const cachedPage = harness.ejs.cache.get(page)
      const cachedCard = harness.ejs.cache.get(card)
      assert.equal(typeof cachedPage, 'function')
      assert.equal(typeof cachedCard, 'function')
      assert.deepEqual(
        harness.compilations.map((item) => item.filename),
        [page, card]
      )

      createRequest(harness.plugin(), 'B').render()
      assert.strictEqual(harness.ejs.cache.get(page), cachedPage)
      assert.strictEqual(harness.ejs.cache.get(card), cachedCard)
      assert.deepEqual(
        harness.compilations.map((item) => item.filename),
        [page, card]
      )
    })

    await t.test('debug=true: page와 partial을 매번 다시 컴파일한다', () => {
      const harness = createHarness(requireFromApp, basicTemplates)
      const a = createRequest(harness.plugin(true), 'A')
      const b = createRequest(harness.plugin(true), 'B')
      assert.equal(a.render(), 'page:A-value-local|include-local|A|A')
      assert.equal(b.render(), 'page:B-value-local|include-local|B|B')
      assert.deepEqual(
        harness.compilations.map((item) => item.filename),
        [page, card, page, card]
      )
      assert.equal(harness.ejs.cache.get(page), undefined)
      assert.equal(harness.ejs.cache.get(card), undefined)
      assertInclude(b.calls[0], b, card, 'B-value-local')
    })

    await t.test('중첩 include는 바로 위 partial의 _private 경로와 데이터를 사용한다', () => {
      const badge = `${pagesRoot}/catalog/_private/_private/badge.ejs`
      const harness = createHarness(requireFromApp, {
        [page]: '<%- include("card", { value: value + "-card", localOnly: "include-local" }) %>',
        [card]: 'card:<%- include("badge", { value: value + "-badge" }) %>',
        [badge]: '<%= value %>|<%= request.id %>',
        [`${pagesRoot}/catalog/_private/badge.ejs`]: 'WRONG PAGE PARENT',
        [`${pagesRoot}/_private/badge.ejs`]: 'WRONG ROOT PARENT',
      })
      for (const id of ['A', 'B']) {
        const current = createRequest(harness.plugin(), id)
        assert.equal(current.render(), `card:${id}-value-card-badge|${id}`)
        assert.equal(current.calls.length, 2)
        assertInclude(current.calls[0], current, badge, `${id}-value-card-badge`)
        assertInclude(current.calls[1], current, card, `${id}-value-card`)
      }
      assert.deepEqual(
        harness.compilations.map((item) => item.filename),
        [page, card, badge]
      )
    })

    await t.test('절대 include의 메타데이터도 root 기준으로 해석한다', () => {
      const absolute = `${pagesRoot}/_private/root-card.ejs`
      const harness = createHarness(requireFromApp, {
        [page]: '<%- include("/_private/root-card.ejs", { value: value + "-root", localOnly: "include-local" }) %>',
        [absolute]: '<%= value %>|<%= request.id %>',
      })
      for (const id of ['A', 'B']) {
        const current = createRequest(harness.plugin(), id)
        assert.equal(current.render(), `${id}-value-root|${id}`)
        assert.equal(current.calls.length, 1)
        assertInclude(current.calls[0], current, absolute, `${id}-value-root`)
      }
    })

    await t.test('예외 후 요청 컨텍스트를 정리하고 다음 캐시 렌더를 안전하게 처리한다', () => {
      for (const failure of ['template', 'postprocessor']) {
        const harness = createHarness(requireFromApp, {
          [page]: '<%- include("card", { localOnly: "include-local" }) %>',
          [card]: '<% if (request.id === "A" && request.failTemplate) throw new Error("template boom"); %><%= value %>',
        })
        const a = createRequest(harness.plugin(), 'A', () => {
          throw new Error('postprocessor boom')
        })
        a.context.request.failTemplate = failure === 'template'
        assert.throws(a.render, new RegExp(`${failure} boom`))
        const callsAfterFailure = a.calls.length

        // onRender 밖에서 엔진을 직접 호출해 실패한 요청이 남지 않았는지 확인한다.
        // 활성 컨텍스트가 없으면 훅이 명시적으로 거절하거나 후처리 없이 렌더할 수 있다.
        try {
          harness.ejs.renderFile(
            page,
            {
              value: 'outside',
              request: { id: 'outside' },
              api: {},
            },
            { cache: true, root: pagesRoot }
          )
        } catch (error) {
          assert.match(error.message, /context/i)
        }
        assert.equal(a.calls.length, callsAfterFailure, '예외 후 A 컨텍스트가 남으면 안 됨')

        const b = createRequest(harness.plugin(), 'B')
        assert.equal(b.render(), 'B-value')
        assert.equal(a.calls.length, callsAfterFailure)
        assert.equal(b.calls.length, 1)
        assertInclude(b.calls[0], b, card, 'B-value')
      }
    })

    for (const throws of [false, true]) {
      await t.test(`동기 재진입 ${throws ? '예외' : '반환'} 후 바깥 A 컨텍스트를 복원한다`, () => {
        const second = `${pagesRoot}/catalog/_private/second.ejs`
        const inner = `${pagesRoot}/inner.ejs`
        const innerPart = `${pagesRoot}/_private/inner-part.ejs`
        const harness = createHarness(requireFromApp, {
          [page]:
            '<%- include("card", { localOnly: "include-local" }) %>/<%- include("second", { localOnly: "include-local" }) %>',
          [card]: 'first:<%= request.id %>',
          [second]: 'second:<%= request.id %>',
          [inner]: '<%- include("inner-part", { localOnly: "include-local" }) %>',
          [innerPart]: 'inner:<%= request.id %>',
        })
        let nestedResult
        const b = createRequest(harness.plugin(), 'B', (context) => {
          if (throws) throw new Error('nested boom')
          return `B[${context.content}]`
        })
        b.context.filePath = inner
        const a = createRequest(harness.plugin(), 'A', (context) => {
          if (context.filePath === card) {
            if (throws) assert.throws(b.render, /nested boom/)
            else nestedResult = b.render()
          }
          return `A[${context.content}]`
        })
        assert.equal(a.render(), 'A[first:A]/A[second:A]')
        if (!throws) assert.equal(nestedResult, 'B[inner:B]')
        assert.equal(a.calls.length, 2)
        assert.equal(b.calls.length, 1)
        assertInclude(a.calls[0], a, card, 'A-value')
        assertInclude(a.calls[1], a, second, 'A-value')
        assertInclude(b.calls[0], b, innerPart, 'B-value')
        const hooks = harness.compilations.map((item) => item.includeFile)
        assert.equal(typeof hooks[0], 'function')
        assert.ok(
          hooks.every((hook) => hook === hooks[0]),
          '컴파일 캐시에는 모듈 공통 include 훅만 저장해야 함'
        )
      })
    }

    await t.test('include 없는 일반 출력과 API 별칭을 유지한다', () => {
      const harness = createHarness(requireFromApp, {
        [page]: '<script server>echo("plain", { ok: true });</script>|<%= value %>|<%= api.value %>',
      })
      for (const id of ['A', 'B']) {
        const current = createRequest(harness.plugin(), id)
        assert.equal(current.render(), `plain {"ok":true}|${id}-value|${id}-value`)
        assert.equal(current.calls.length, 0)
      }
      assert.deepEqual(
        harness.compilations.map((item) => item.filename),
        [page]
      )
    })
  })
}
