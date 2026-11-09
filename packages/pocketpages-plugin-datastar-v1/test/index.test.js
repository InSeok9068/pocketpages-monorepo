'use strict'

const assert = require('assert')
const vm = require('vm')
const datastarPluginFactory = require('..')

function createHarness(requestHeaders) {
  const output = []
  const responseHeaders = {}
  const realtimeMessages = []
  const plugin = datastarPluginFactory({ dbg: function () {} })
  const api = {
    response: {
      header: function (name, value) {
        if (value !== undefined) responseHeaders[name] = value
        return responseHeaders[name]
      },
    },
    echo: function (value) {
      output.push(String(value))
    },
    stringify: JSON.stringify,
    asset: function (path) {
      return path
    },
    request: {
      method: 'GET',
      url: { query: {} },
      header: function (name) {
        return requestHeaders && requestHeaders[name]
      },
    },
    realtime: {
      send: function (topic, message, options) {
        realtimeMessages.push({ topic, message, options })
      },
    },
  }

  plugin.onExtendContextApi({ api })

  return {
    api,
    plugin,
    responseHeaders,
    realtimeMessages,
    output: function () {
      return output.join('')
    },
  }
}

function createRealtimeSenderHarness() {
  const sentMessages = []
  function SubscriptionMessage(input) {
    this.name = input.name
    this.data = input.data
  }
  function createClient(id, subscribed) {
    return {
      hasSubscription: function (topic) {
        return subscribed.indexOf(topic) !== -1
      },
      send: function (message) {
        sentMessages.push({ id, message })
      },
    }
  }
  const clients = {
    allowed: createClient('allowed', ['dashboard']),
    blocked: createClient('blocked', ['dashboard']),
    unrelated: createClient('unrelated', []),
  }
  const sender = datastarPluginFactory.createRealtimeSender({
    app: {
      subscriptionsBroker: function () {
        return {
          clients: function () {
            return clients
          },
        }
      },
    },
    SubscriptionMessage,
  })

  return {
    sender,
    sentMessages,
  }
}

function test(name, fn) {
  fn()
  console.log('ok - ' + name)
}

test('removeElements emits a remove element patch', function () {
  const harness = createHarness()

  harness.api.datastar.removeElements('#toast')

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-elements\n' + 'data: selector #toast\n' + 'data: mode remove\n' + '\n'
  )
  assert.strictEqual(harness.responseHeaders['Content-Type'], 'text/event-stream')
})

test('patchElements emits view transition selector options', function () {
  const harness = createHarness()

  harness.api.datastar.patchElements('<div id="modal">Updated</div>', {
    selector: '#modal',
    useViewTransition: true,
    viewTransitionSelector: '#shell',
  })

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-elements\n'
      + 'data: selector #modal\n'
      + 'data: useViewTransition true\n'
      + 'data: viewTransitionSelector #shell\n'
      + 'data: elements <div id="modal">Updated</div>\n'
      + '\n'
  )
})

test('removeSignals emits a null signal patch for one key', function () {
  const harness = createHarness()

  harness.api.datastar.removeSignals('draft')

  assert.strictEqual(harness.output(), 'event: datastar-patch-signals\n' + 'data: signals {"draft":null}\n' + '\n')
})

test('removeSignals emits nested null patches for dotted keys', function () {
  const harness = createHarness()

  harness.api.datastar.removeSignals(['draft.title', 'draft.body'])

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-signals\n' + 'data: signals {"draft":{"title":null,"body":null}}\n' + '\n'
  )
})

test('removeSignals lets parent removal win over nested keys', function () {
  const harness = createHarness()

  harness.api.datastar.removeSignals(['draft', 'draft.title'])

  assert.strictEqual(harness.output(), 'event: datastar-patch-signals\n' + 'data: signals {"draft":null}\n' + '\n')
})

test('removeSignals rejects onlyIfMissing because removal must be explicit', function () {
  const harness = createHarness()

  assert.throws(function () {
    harness.api.datastar.removeSignals('draft', { onlyIfMissing: true })
  }, /removeSignals does not support onlyIfMissing/)
})

test('realtime remove helpers send Datastar watcher payloads', function () {
  const harness = createHarness()

  harness.api.datastar.realtime.removeElements('#notice')
  harness.api.datastar.realtime.removeSignals(['notice.title', 'notice.body'])

  assert.deepStrictEqual(harness.realtimeMessages, [
    {
      topic: 'datastar',
      message: JSON.stringify({
        type: 'datastar-patch-elements',
        el: null,
        argsRaw: {
          selector: '#notice',
          mode: 'remove',
        },
      }),
      options: undefined,
    },
    {
      topic: 'datastar',
      message: JSON.stringify({
        type: 'datastar-patch-signals',
        el: null,
        argsRaw: {
          signals: JSON.stringify({
            notice: {
              title: null,
              body: null,
            },
          }),
        },
      }),
      options: undefined,
    },
  ])
})

test('realtime helpers normalize Datastar boolean args as raw strings', function () {
  const harness = createHarness()

  harness.api.datastar.realtime.patchElements('<div></div>', {
    selector: '#notice',
    useViewTransition: true,
    viewTransitionSelector: '#shell',
  })
  harness.api.datastar.realtime.patchSignals(
    { ready: true },
    {
      onlyIfMissing: true,
    }
  )

  assert.deepStrictEqual(harness.realtimeMessages, [
    {
      topic: 'datastar',
      message: JSON.stringify({
        type: 'datastar-patch-elements',
        el: null,
        argsRaw: {
          elements: '<div></div>',
          selector: '#notice',
          useViewTransition: 'true',
          viewTransitionSelector: '#shell',
        },
      }),
      options: undefined,
    },
    {
      topic: 'datastar',
      message: JSON.stringify({
        type: 'datastar-patch-signals',
        el: null,
        argsRaw: {
          signals: JSON.stringify({ ready: true }),
          onlyIfMissing: 'true',
        },
      }),
      options: undefined,
    },
  ])
})

test('realtime helpers send custom topics without leaking topic into send options', function () {
  const harness = createHarness()
  const filter = function (clientId) {
    return clientId !== 'blocked'
  }

  harness.api.datastar.realtime.patchSignals({ ready: true }, undefined, { topic: 'chat:conversation-1', filter })

  assert.strictEqual(harness.realtimeMessages.length, 1)

  const message = harness.realtimeMessages[0]
  assert.strictEqual(message.topic, 'chat:conversation-1')
  assert.deepStrictEqual(JSON.parse(message.message), {
    type: 'datastar-patch-signals',
    el: null,
    argsRaw: {
      signals: JSON.stringify({ ready: true }),
    },
  })
  assert.strictEqual(Object.prototype.hasOwnProperty.call(message.options, 'topic'), false)
  assert.strictEqual(typeof message.options.filter, 'function')
  assert.strictEqual(
    message.options.filter(
      'client-1',
      {
        hasSubscription: function () {
          return true
        },
      },
      'chat:conversation-1',
      '{}'
    ),
    true
  )
  assert.strictEqual(
    message.options.filter(
      'blocked',
      {
        hasSubscription: function () {
          return true
        },
      },
      'chat:conversation-1',
      '{}'
    ),
    false
  )
  assert.strictEqual(
    message.options.filter(
      'client-1',
      {
        hasSubscription: function () {
          return false
        },
      },
      'chat:conversation-1',
      '{}'
    ),
    false
  )
})

test('realtime payload builders create PocketBase realtime Datastar messages', function () {
  assert.deepStrictEqual(
    JSON.parse(
      datastarPluginFactory.realtime.buildPatchElementsPayload('<div id="notice">Updated</div>', {
        selector: '#notice',
        mode: 'outer',
      })
    ),
    {
      type: 'datastar-patch-elements',
      el: null,
      argsRaw: {
        elements: '<div id="notice">Updated</div>',
        selector: '#notice',
        mode: 'outer',
      },
    }
  )

  assert.deepStrictEqual(
    JSON.parse(
      datastarPluginFactory.realtime.buildPatchSignalsPayload({
        status: 'ready',
      })
    ),
    {
      type: 'datastar-patch-signals',
      el: null,
      argsRaw: {
        signals: JSON.stringify({ status: 'ready' }),
      },
    }
  )
})

test('realtime sender works outside PocketPages request context', function () {
  const harness = createRealtimeSenderHarness()

  harness.sender.patchSignals({ status: 'ready' }, undefined, {
    topic: 'dashboard',
    filter: function (clientId) {
      return clientId !== 'blocked'
    },
  })

  assert.deepStrictEqual(
    harness.sentMessages.map(function (entry) {
      return entry.id
    }),
    ['allowed']
  )
  assert.strictEqual(harness.sentMessages[0].message.name, 'dashboard')
  assert.deepStrictEqual(JSON.parse(harness.sentMessages[0].message.data), {
    type: 'datastar-patch-signals',
    el: null,
    argsRaw: {
      signals: JSON.stringify({ status: 'ready' }),
    },
  })
})

test('realtime removeSignals rejects onlyIfMissing because removal must be explicit', function () {
  const harness = createHarness()

  assert.throws(function () {
    harness.api.datastar.realtime.removeSignals('draft', {
      onlyIfMissing: true,
    })
  }, /realtime\.removeSignals does not support onlyIfMissing/)
})

test('scripts closes navigation and realtime script tags in raw HTML', function () {
  const harness = createHarness()

  const html = harness.api.datastar.scripts({
    spa: {
      scope: 'nav',
      selector: '#main',
    },
    realtime: true,
  })

  assert.ok(html.includes('var source = new EventSource(endpoint)'))
  assert.ok(html.includes('data-on:click'))
  assert.ok(html.includes('requestCancellation:controller'))
  assert.ok(html.includes('navigation.controller.abort()'))
  assert.ok(html.includes('document.addEventListener("datastar-scope-children", bindLinks, true);'))
  assert.ok(html.includes('state.source.close()'))
  assert.ok(html.includes('window.addEventListener("pagehide", handlePageHide)'))
  assert.ok(html.includes('window.addEventListener("pageshow", handlePageShow)'))
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 4)
  assert.strictEqual(html.includes('<\\/script>'), false)
})

function createNavigationHarness() {
  const html = createHarness().api.datastar.scripts({ spa: true })
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), function (match) {
    return match[1]
  })
  const attributes = {}
  const listeners = {}
  const requests = []
  const scrolls = []
  const timers = new Map()
  let timerId = 0
  const history = {
    state: { existing: true },
    replaceState: function (state) {
      this.state = state
    },
    pushState: function (state) {
      this.previousState = this.state
      this.state = state
    },
  }
  const context = {
    history,
    location: { pathname: '/first', search: '?page=1', hash: '#list', origin: 'https://example.test' },
    URL,
    AbortController,
    setTimeout: function (callback) {
      timers.set(++timerId, callback)
      return timerId
    },
    clearTimeout: function (id) {
      timers.delete(id)
    },
    document: {
      readyState: 'complete',
      baseURI: 'https://example.test/first',
      body: { appendChild: function () {} },
      getElementById: function () {
        return attributes['data-on:popstate__window'] ? {} : null
      },
      createElement: function () {
        return {
          setAttribute: function (name, value) {
            attributes[name] = value
          },
        }
      },
      querySelector: function () {
        return {
          querySelectorAll: function () {
            return [
              {
                hasAttribute: function () {
                  return false
                },
                setAttribute: function (name, value) {
                  attributes[name] = value
                },
              },
            ]
          },
        }
      },
      addEventListener: function () {},
    },
    get: function (url, options) {
      const request = { url, options }
      requests.push(request)
      return {
        then: function (callback) {
          request.complete = callback
        },
      }
    },
  }
  context.window = {
    scrollY: 120,
    addEventListener: function (name, callback) {
      listeners[name] = callback
    },
    scrollTo: function (options) {
      scrolls.push(options.top)
    },
  }
  vm.createContext(context)
  const script = scripts[scripts.length - 1]
  vm.runInContext(script, context)
  return {
    context,
    history,
    listeners,
    requests,
    scrolls,
    timers,
    rerun: function () {
      vm.runInContext(script, context)
    },
    click: function (path) {
      context.evt = {
        target: {
          closest: function () {
            return {
              href: 'https://example.test' + path,
              hasAttribute: function () {
                return false
              },
            }
          },
        },
        button: 0,
        preventDefault: function () {},
      }
      vm.runInContext('(function(){' + attributes['data-on:click'].replace('@get(', 'get(') + '})()', context)
    },
    pop: function (state) {
      history.state = state
      context.evt = { state }
      vm.runInContext(
        '(function(){' + attributes['data-on:popstate__window'].replace('@get(', 'get(') + '})()',
        context
      )
    },
  }
}

test('scripts without SPA do not change history or scroll handling', function () {
  const html = createHarness().api.datastar.scripts()
  assert.strictEqual(html.includes('history.scrollRestoration'), false)
  assert.strictEqual(html.includes('__pocketpagesDatastarNavigation'), false)
})

test('SPA registers the landing page and preserves history state on repeated setup', function () {
  const nav = createNavigationHarness()
  assert.strictEqual(nav.history.scrollRestoration, 'manual')
  assert.strictEqual(nav.history.state.existing, true)
  assert.strictEqual(nav.history.state.datastar.url, '/first?page=1#list')
  assert.strictEqual(nav.history.state.scrollY, 120)
  const scrollListener = nav.listeners.scroll
  nav.rerun()
  assert.strictEqual(nav.listeners.scroll, scrollListener)
  nav.context.window.scrollY = 240
  nav.listeners.scroll()
  nav.timers.forEach(function (callback) {
    callback()
  })
  assert.strictEqual(nav.history.state.scrollY, 240)
})

test('SPA saves scroll before navigation and restores it only after the active request completes', function () {
  const nav = createNavigationHarness()
  nav.listeners.scroll()
  const landing = nav.history.state
  nav.context.window.scrollY = 360
  nav.click('/second')
  assert.strictEqual(nav.timers.size, 0)
  assert.strictEqual(nav.history.previousState.scrollY, 360)
  assert.strictEqual(nav.history.previousState.existing, true)
  assert.strictEqual(nav.history.state.scrollY, 0)
  assert.strictEqual(nav.scrolls.length, 0)
  nav.requests[0].complete()
  assert.deepStrictEqual(nav.scrolls, [0])
  nav.pop(Object.assign({}, landing, { scrollY: 360 }))
  assert.strictEqual(nav.requests[0].options.requestCancellation.signal.aborted, true)
  assert.strictEqual(nav.requests[1].url, '/first?page=1#list')
  assert.deepStrictEqual(nav.scrolls, [0])
  nav.requests[1].complete()
  assert.deepStrictEqual(nav.scrolls, [0, 360])
  nav.click('/third')
  nav.click('/fourth')
  nav.requests[2].complete()
  assert.deepStrictEqual(nav.scrolls, [0, 360])
  nav.requests[3].complete()
  assert.deepStrictEqual(nav.scrolls, [0, 360, 0])
  nav.listeners.pagehide()
  assert.strictEqual(nav.requests[3].options.requestCancellation.signal.aborted, true)
})

test('scripts subscribes realtime clients to custom topics', function () {
  const harness = createHarness()

  const html = harness.api.datastar.scripts({
    realtime: {
      topic: 'chat:conversation-1',
      clientIdSignal: 'chatClientId',
    },
  })

  assert.ok(html.includes('var topic = "chat:conversation-1";'))
  assert.ok(html.includes('var clientIdSignal = "chatClientId";'))
  assert.ok(html.includes('subscriptions: [topic]'))
  assert.ok(html.includes('source.addEventListener(topic'))
})

test('realtime browser script keeps one connection and reconnects after page restore', function () {
  const harness = createHarness()
  const html = harness.api.datastar.scripts({ realtime: true })
  const inlineScripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), function (match) {
    return match[1]
  })
  const realtimeScript = inlineScripts[inlineScripts.length - 1]
  const windowListeners = {}
  const sources = []

  function EventSource() {
    this.readyState = EventSource.OPEN
    this.listeners = {}
    sources.push(this)
  }
  EventSource.OPEN = 1
  EventSource.CLOSED = 2
  EventSource.prototype.addEventListener = function (name, listener) {
    this.listeners[name] = listener
  }
  EventSource.prototype.close = function () {
    this.readyState = EventSource.CLOSED
  }

  const context = {
    console,
    CustomEvent: function (name, options) {
      this.type = name
      this.detail = options.detail
    },
    document: {
      hidden: false,
      dispatchEvent: function () {},
    },
    EventSource,
    fetch: function () {
      return { catch: function () {} }
    },
    window: {
      addEventListener: function (name, listener) {
        windowListeners[name] = listener
      },
      removeEventListener: function (name, listener) {
        if (windowListeners[name] === listener) delete windowListeners[name]
      },
    },
  }

  vm.runInNewContext(realtimeScript, context)
  vm.runInNewContext(realtimeScript, context)
  assert.strictEqual(sources.length, 1)

  windowListeners.pagehide()
  assert.strictEqual(sources[0].readyState, EventSource.CLOSED)

  windowListeners.pageshow()
  assert.strictEqual(sources.length, 2)
  assert.strictEqual(sources[1].readyState, EventSource.OPEN)
})

test('Datastar page render skips empty automatic element patches', function () {
  const harness = createHarness({
    'Datastar-Request': 'true',
  })

  harness.api.datastar.patchSignals({ ready: true })
  harness.plugin.onRender({ api: harness.api, content: '\n\n' })

  assert.strictEqual(harness.output(), 'event: datastar-patch-signals\n' + 'data: signals {"ready":true}\n' + '\n')
})

test('Datastar page render still emits an inner patch for selectors', function () {
  const harness = createHarness({
    'Datastar-Request': 'true',
    'Datastar-Selector': '#main',
  })

  harness.plugin.onRender({ api: harness.api, content: '<h1>Hello</h1>' })

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-elements\n'
      + 'data: selector #main\n'
      + 'data: mode inner\n'
      + 'data: elements <h1>Hello</h1>\n'
      + '\n'
  )
})

test('Datastar page render forwards view transition selector headers', function () {
  const harness = createHarness({
    'Datastar-Request': 'true',
    'Datastar-Selector': '#main',
    'Datastar-Use-View-Transition': 'true',
    'Datastar-View-Transition-Selector': '#shell',
  })

  harness.plugin.onRender({ api: harness.api, content: '<h1>Hello</h1>' })

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-elements\n'
      + 'data: selector #main\n'
      + 'data: mode inner\n'
      + 'data: useViewTransition true\n'
      + 'data: viewTransitionSelector #shell\n'
      + 'data: elements <h1>Hello</h1>\n'
      + '\n'
  )
})
