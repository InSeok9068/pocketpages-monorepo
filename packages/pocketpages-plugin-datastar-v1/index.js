'use strict'

const DatastarKey = 'datastar'
const DefaultScriptPath = '/assets/vendor/datastar.min.js'
const DefaultSseRetryDuration = 1000
const RealtimeEndpoint = '/api/realtime'
const DefaultRealtimeTopic = 'datastar'

const EventType = {
  PatchElements: 'datastar-patch-elements',
  PatchSignals: 'datastar-patch-signals',
}

const ElementPatchMode = {
  Outer: 'outer',
  Inner: 'inner',
  Remove: 'remove',
  Replace: 'replace',
  Prepend: 'prepend',
  Append: 'append',
  Before: 'before',
  After: 'after',
}

const Namespace = {
  Html: 'html',
  Svg: 'svg',
  Mathml: 'mathml',
}

const ValidPatchModes = Object.keys(ElementPatchMode).map(function (key) {
  return ElementPatchMode[key]
})

const ValidNamespaces = Object.keys(Namespace).map(function (key) {
  return Namespace[key]
})

function hasValue(value) {
  return value !== undefined && value !== null && value !== ''
}

function includes(list, value) {
  return list.indexOf(value) !== -1
}

function stringify(api, value) {
  if (typeof value === 'string') return value
  if (api && typeof api.stringify === 'function') return api.stringify(value)
  return JSON.stringify(value)
}

function escapeHtmlAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeScriptEndTag(value) {
  return String(value).replace(/<\/script/gi, '<\\/script')
}

function scriptJson(value) {
  return escapeScriptEndTag(JSON.stringify(value))
}

function splitDataLines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function addDataLines(lines, literal, value) {
  const parts = splitDataLines(value)
  for (let i = 0; i < parts.length; i += 1) {
    lines.push(literal + parts[i])
  }
}

function assertPatchMode(mode) {
  if (!includes(ValidPatchModes, mode)) {
    throw new Error('Invalid Datastar patch mode: ' + mode)
  }
}

function assertNamespace(namespace) {
  if (!includes(ValidNamespaces, namespace)) {
    throw new Error('Invalid Datastar namespace: ' + namespace)
  }
}

function normalizeSignals(api, signals) {
  if (signals === undefined) {
    throw new Error('Datastar patchSignals requires signals')
  }
  const contents = stringify(api, signals)
  if (!hasValue(contents)) {
    throw new Error('Datastar patchSignals requires non-empty signals')
  }
  return contents
}

function normalizeSignalKeys(signalKeys) {
  const keys = Array.isArray(signalKeys) ? signalKeys : [signalKeys]
  if (!keys.length) {
    throw new Error('Datastar removeSignals requires signal keys')
  }
  return keys.map(function (key) {
    if (!hasValue(key)) {
      throw new Error('Datastar removeSignals requires non-empty signal keys')
    }
    return String(key)
  })
}

function setSignalRemoval(patch, key) {
  const parts = key.split('.')
  let target = patch

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (!part) {
      throw new Error('Invalid Datastar signal key: ' + key)
    }
    if (i === parts.length - 1) {
      target[part] = null
      return
    }
    if (target[part] === null) return
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) {
      target[part] = {}
    }
    target = target[part]
  }
}

function buildSignalRemovalPatch(signalKeys) {
  const patch = {}
  const keys = normalizeSignalKeys(signalKeys)
  for (let i = 0; i < keys.length; i += 1) {
    setSignalRemoval(patch, keys[i])
  }
  return patch
}

function normalizeRawBooleanArg(args, name) {
  if (args[name] === undefined || args[name] === null || args[name] === false) {
    delete args[name]
    return
  }
  args[name] = String(args[name])
}

function normalizeRealtimePatchElementsArgs(args) {
  normalizeRawBooleanArg(args, 'useViewTransition')
  return args
}

function normalizeRealtimePatchSignalsArgs(args) {
  normalizeRawBooleanArg(args, 'onlyIfMissing')
  return args
}

function normalizeRealtimeOptions(options) {
  const source = options || {}
  const topic = hasValue(source.topic) ? String(source.topic) : DefaultRealtimeTopic
  const sendOptions = Object.assign({}, source)
  delete sendOptions.topic
  if (typeof source.filter === 'function') {
    sendOptions.filter = function (clientId, client, sendTopic, message) {
      return client && typeof client.hasSubscription === 'function' && client.hasSubscription(sendTopic) && source.filter(clientId, client, sendTopic, message)
    }
  }

  return {
    topic,
    sendOptions: Object.keys(sendOptions).length ? sendOptions : undefined,
  }
}

function buildRealtimePatchElementsPayload(api, elements, patchOptions) {
  return stringify(api, {
    type: EventType.PatchElements,
    el: null,
    argsRaw: normalizeRealtimePatchElementsArgs(Object.assign({ elements: String(elements || '') }, patchOptions || {})),
  })
}

function buildRealtimeRemoveElementsPayload(api, selector, patchOptions) {
  if (!hasValue(selector)) {
    throw new Error('Datastar removeElements requires selector')
  }

  return stringify(api, {
    type: EventType.PatchElements,
    el: null,
    argsRaw: normalizeRealtimePatchElementsArgs(Object.assign({}, patchOptions || {}, { selector: String(selector), mode: ElementPatchMode.Remove })),
  })
}

function buildRealtimePatchSignalsPayload(api, signals, patchOptions) {
  return stringify(api, {
    type: EventType.PatchSignals,
    el: null,
    argsRaw: normalizeRealtimePatchSignalsArgs(Object.assign({ signals: normalizeSignals(api, signals) }, patchOptions || {})),
  })
}

function buildRealtimeRemoveSignalsPayload(api, signalKeys, patchOptions) {
  assertNoOnlyIfMissing(patchOptions, 'realtime.removeSignals')

  return stringify(api, {
    type: EventType.PatchSignals,
    el: null,
    argsRaw: normalizeRealtimePatchSignalsArgs(Object.assign({}, patchOptions || {}, { signals: stringify(api, buildSignalRemovalPatch(signalKeys)) })),
  })
}

function sendRealtimePayload(deps, topic, payload, sendOptions) {
  const app = deps && deps.app
  const SubscriptionMessageCtor = deps && deps.SubscriptionMessage
  if (!app || typeof app.subscriptionsBroker !== 'function') {
    throw new Error('Datastar realtime sender requires app.subscriptionsBroker')
  }
  if (typeof SubscriptionMessageCtor !== 'function') {
    throw new Error('Datastar realtime sender requires SubscriptionMessage')
  }

  const message = new SubscriptionMessageCtor({
    name: topic,
    data: payload,
  })
  const clients = app.subscriptionsBroker().clients()
  const filter =
    sendOptions && typeof sendOptions.filter === 'function'
      ? sendOptions.filter
      : function (_clientId, client, sendTopic) {
          return client && typeof client.hasSubscription === 'function' && client.hasSubscription(sendTopic)
        }

  for (const clientId in clients) {
    const client = clients[clientId]
    if (filter(clientId, client, topic, payload)) {
      client.send(message)
    }
  }
}

/**
 * PocketBase realtime broker로 Datastar 패치를 보내는 헬퍼를 만듭니다.
 * @param {Record<string, any>} deps realtime 전송 의존성입니다.
 * @returns {Record<string, Function>} realtime 전송 헬퍼입니다.
 */
function createRealtimeSender(deps) {
  return {
    patchElements: function (elements, patchOptions, realtimeOptions) {
      const realtime = normalizeRealtimeOptions(realtimeOptions)
      sendRealtimePayload(deps, realtime.topic, buildRealtimePatchElementsPayload(null, elements, patchOptions), realtime.sendOptions)
    },
    removeElements: function (selector, patchOptions, realtimeOptions) {
      const realtime = normalizeRealtimeOptions(realtimeOptions)
      sendRealtimePayload(deps, realtime.topic, buildRealtimeRemoveElementsPayload(null, selector, patchOptions), realtime.sendOptions)
    },
    patchSignals: function (signals, patchOptions, realtimeOptions) {
      const realtime = normalizeRealtimeOptions(realtimeOptions)
      sendRealtimePayload(deps, realtime.topic, buildRealtimePatchSignalsPayload(null, signals, patchOptions), realtime.sendOptions)
    },
    removeSignals: function (signalKeys, patchOptions, realtimeOptions) {
      const realtime = normalizeRealtimeOptions(realtimeOptions)
      sendRealtimePayload(deps, realtime.topic, buildRealtimeRemoveSignalsPayload(null, signalKeys, patchOptions), realtime.sendOptions)
    },
  }
}

function assertNoOnlyIfMissing(options, helperName) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'onlyIfMissing')) {
    throw new Error('Datastar ' + helperName + ' does not support onlyIfMissing')
  }
}

function normalizeAttributes(attributes) {
  if (!attributes) return { html: '', names: {} }

  const names = {}
  const parts = []

  if (Array.isArray(attributes)) {
    for (let i = 0; i < attributes.length; i += 1) {
      const attr = String(attributes[i]).trim()
      if (!attr) continue
      const name = attr.split(/\s|=/)[0].toLowerCase()
      names[name] = true
      parts.push(attr)
    }
  } else {
    Object.keys(attributes).forEach(function (name) {
      const value = attributes[name]
      if (value === false || value === undefined || value === null) return
      names[String(name).toLowerCase()] = true
      if (value === true) {
        parts.push(escapeHtmlAttr(name))
      } else {
        parts.push(escapeHtmlAttr(name) + '="' + escapeHtmlAttr(value) + '"')
      }
    })
  }

  return {
    html: parts.length ? ' ' + parts.join(' ') : '',
    names,
  }
}

function isDatastarRequest(request) {
  if (!request || typeof request.header !== 'function') return false
  return String(request.header('Datastar-Request') || '').toLowerCase() === 'true'
}

function methodUsesQuery(method) {
  return method === 'GET' || method === 'DELETE'
}

function readInput(api, request) {
  const method = String(request.method || 'GET').toUpperCase()

  if (methodUsesQuery(method)) {
    const query = request.url && request.url.query ? request.url.query : {}
    const input = query[DatastarKey]
    if (!hasValue(input)) return ''
    return stringify(api, input)
  }

  const body = typeof request.body === 'function' ? request.body() : request.body
  if (!hasValue(body)) return ''
  return stringify(api, body)
}

function buildHeaders(options) {
  const opts = options || {}
  const headers = {}
  if (opts.selector) headers['Datastar-Selector'] = String(opts.selector)
  if (opts.mode) headers['Datastar-Mode'] = String(opts.mode)
  if (opts.namespace) headers['Datastar-Namespace'] = String(opts.namespace)
  if (opts.useViewTransition) headers['Datastar-Use-View-Transition'] = 'true'
  if (opts.viewTransitionSelector) {
    headers['Datastar-View-Transition-Selector'] = String(opts.viewTransitionSelector)
  }
  return headers
}

function buildLoaderScript(scriptUrl) {
  return [
    '<script type="module" defer src="' + escapeHtmlAttr(scriptUrl) + '"></script>',
    '<script>',
    '(function () {',
    '  window.patchSignals = function (signals, options) {',
    '    var opts = options || {};',
    '    var rawSignals = typeof signals === "string" ? signals : JSON.stringify(signals);',
    '    var argsRaw = { signals: rawSignals };',
    '    if (opts.onlyIfMissing) argsRaw.onlyIfMissing = "true";',
    '    document.dispatchEvent(new CustomEvent("datastar-fetch", {',
    '      detail: { type: "datastar-patch-signals", el: null, argsRaw: argsRaw }',
    '    }));',
    '  };',
    '}());',
    '</script>',
  ].join('\n')
}

function defaultScriptUrl(api) {
  if (api && typeof api.asset === 'function') {
    return api.asset(DefaultScriptPath)
  }
  return DefaultScriptPath
}

function buildNavigationScript(options) {
  const opts = options === true ? {} : options || {}
  const scope = opts.scope || 'body'
  const headers = buildHeaders({ selector: opts.selector })
  const headersJson = JSON.stringify(headers)
  const clickExpression = [
    'if(!evt.target.closest)return',
    'var link=evt.target.closest("a")',
    'if(!link)return',
    'if(evt.defaultPrevented||evt.button!==0||evt.metaKey||evt.ctrlKey||evt.shiftKey||evt.altKey)return',
    'if(link.target||link.hasAttribute("download"))return',
    'var url=new URL(link.href,document.baseURI)',
    'if(url.origin!==location.origin)return',
    'evt.preventDefault()',
    'var path=url.pathname+url.search+url.hash',
    'history.pushState({datastar:{url:path}},"",path)',
    '@get(path,{headers:' + headersJson + '})',
  ].join(';')
  const popstateExpression = ['var state=evt.state&&evt.state.datastar', 'var url=state&&state.url', 'if(!url)return', '@get(url,{headers:' + headersJson + '})'].join(';')

  return [
    '<script>',
    '(function () {',
    '  var scopeSelector = ' + scriptJson(scope) + ';',
    '  var clickExpression = ' + scriptJson(clickExpression) + ';',
    '  var popstateExpression = ' + scriptJson(popstateExpression) + ';',
    '  function addPopstateHandler() {',
    '    if (document.getElementById("__pocketpages_datastar_navigation")) return;',
    '    if (!document.body) return;',
    '    var el = document.createElement("div");',
    '    el.hidden = true;',
    '    el.id = "__pocketpages_datastar_navigation";',
    '    el.setAttribute("data-on:popstate__window", popstateExpression);',
    '    document.body.appendChild(el);',
    '  }',
    '  function bindLinks() {',
    '    var root = document.querySelector(scopeSelector);',
    '    if (!root) return;',
    '    var links = root.querySelectorAll("a[href]");',
    '    for (var i = 0; i < links.length; i += 1) {',
    '      var link = links[i];',
    '      if (link.hasAttribute("data-datastar-nav-bound")) continue;',
    '      link.setAttribute("data-on:click", clickExpression);',
    '      link.setAttribute("data-datastar-nav-bound", "");',
    '    }',
    '  }',
    '  function applyNavigation() { addPopstateHandler(); bindLinks(); }',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", applyNavigation);',
    '  } else {',
    '    applyNavigation();',
    '  }',
    '  document.addEventListener("datastar-ready", applyNavigation);',
    '  document.addEventListener("datastar-scope-children", bindLinks, true);',
    '}());',
    '</script>',
  ].join('\n')
}

function buildRealtimeScript(options) {
  const opts = options === true ? {} : options || {}
  const endpoint = opts.endpoint || RealtimeEndpoint
  const topic = opts.topic || DefaultRealtimeTopic
  const clientIdSignal = opts.clientIdSignal || 'clientId'

  return [
    '<script>',
    '(function () {',
    '  var source = new EventSource(' + scriptJson(endpoint) + ');',
    '  var topic = ' + scriptJson(topic) + ';',
    '  var clientIdSignal = ' + scriptJson(clientIdSignal) + ';',
    '  source.addEventListener("PB_CONNECT", function (event) {',
    '    var payload = JSON.parse(event.data);',
    '    var clientId = payload.clientId;',
    '    fetch(' + JSON.stringify(endpoint) + ', {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({ clientId: clientId, subscriptions: [topic] })',
    '    }).catch(console.error);',
    '    if (window.patchSignals) {',
    '      var patch = {};',
    '      patch[clientIdSignal] = clientId;',
    '      window.patchSignals(patch);',
    '    }',
    '  });',
    '  source.addEventListener(topic, function (event) {',
    '    document.dispatchEvent(new CustomEvent("datastar-fetch", {',
    '      detail: JSON.parse(event.data)',
    '    }));',
    '  });',
    '}());',
    '</script>',
  ].join('\n')
}

/**
 * PocketPages Datastar v1 플러그인을 만듭니다.
 * @param {Record<string, any>} config PocketPages 플러그인 설정입니다.
 * @param {Record<string, any>} [pluginOptions] Datastar 플러그인 옵션입니다.
 * @returns {Record<string, any>} PocketPages 플러그인 객체입니다.
 */
function datastarPluginFactory(config, pluginOptions) {
  const opts = pluginOptions || {}
  const dbg = config && typeof config.dbg === 'function' ? config.dbg : function () {}
  const configuredScriptUrl = opts.scriptUrl

  return {
    name: 'datastar-v1',
    onExtendContextApi: function (context) {
      const api = context.api
      const scriptUrl = configuredScriptUrl || defaultScriptUrl(api)

      function send(eventType, dataLines, options) {
        const sendOptions = options || {}
        dbg('datastar send', { eventType, dataLines, options: sendOptions })

        api.response.header('Content-Type', 'text/event-stream')
        api.response.header('Cache-Control', 'no-cache')
        api.response.header('Connection', 'keep-alive')

        api.echo('event: ' + eventType + '\n')
        if (sendOptions.eventId) api.echo('id: ' + sendOptions.eventId + '\n')
        if (sendOptions.retryDuration !== undefined && sendOptions.retryDuration !== null && Number(sendOptions.retryDuration) !== DefaultSseRetryDuration) {
          api.echo('retry: ' + sendOptions.retryDuration + '\n')
        }
        for (let i = 0; i < dataLines.length; i += 1) {
          api.echo('data: ' + dataLines[i] + '\n')
        }
        api.echo('\n')
      }

      function patchElements(elements, options) {
        const patchOptions = Object.assign(
          {
            eventId: '',
            retryDuration: DefaultSseRetryDuration,
            selector: '',
            mode: ElementPatchMode.Outer,
            useViewTransition: false,
            viewTransitionSelector: '',
            namespace: Namespace.Html,
          },
          options || {}
        )
        assertPatchMode(patchOptions.mode)
        assertNamespace(patchOptions.namespace)

        const dataLines = []
        if (patchOptions.selector) {
          dataLines.push('selector ' + patchOptions.selector)
        }
        if (patchOptions.mode !== ElementPatchMode.Outer) {
          dataLines.push('mode ' + patchOptions.mode)
        }
        if (patchOptions.useViewTransition) {
          dataLines.push('useViewTransition true')
        }
        if (patchOptions.viewTransitionSelector) {
          dataLines.push('viewTransitionSelector ' + patchOptions.viewTransitionSelector)
        }
        if (patchOptions.namespace !== Namespace.Html) {
          dataLines.push('namespace ' + patchOptions.namespace)
        }
        if (hasValue(elements)) {
          addDataLines(dataLines, 'elements ', elements)
        }

        send(EventType.PatchElements, dataLines, patchOptions)
      }

      function patchSignals(signals, options) {
        const patchOptions = Object.assign(
          {
            eventId: '',
            retryDuration: DefaultSseRetryDuration,
            onlyIfMissing: false,
          },
          options || {}
        )
        const contents = normalizeSignals(api, signals)
        const dataLines = []

        if (patchOptions.onlyIfMissing) {
          dataLines.push('onlyIfMissing true')
        }
        addDataLines(dataLines, 'signals ', contents)

        send(EventType.PatchSignals, dataLines, patchOptions)
      }

      function removeElements(selector, options) {
        if (!hasValue(selector)) {
          throw new Error('Datastar removeElements requires selector')
        }
        patchElements(
          '',
          Object.assign({}, options || {}, {
            selector: String(selector),
            mode: ElementPatchMode.Remove,
          })
        )
      }

      function removeSignals(signalKeys, options) {
        assertNoOnlyIfMissing(options, 'removeSignals')
        patchSignals(buildSignalRemovalPatch(signalKeys), options)
      }

      function executeScript(scriptContents, options) {
        const scriptOptions = Object.assign(
          {
            eventId: '',
            retryDuration: DefaultSseRetryDuration,
            autoRemove: true,
            attributes: [],
          },
          options || {}
        )
        const attrs = normalizeAttributes(scriptOptions.attributes)
        const autoRemove = scriptOptions.autoRemove !== false && !attrs.names['data-effect']
        const effectAttr = autoRemove ? ' data-effect="el.remove()"' : ''
        const scriptElement = '<script' + attrs.html + effectAttr + '>' + escapeScriptEndTag(scriptContents) + '</script>'

        patchElements(scriptElement, {
          selector: 'body',
          mode: ElementPatchMode.Append,
          eventId: scriptOptions.eventId,
          retryDuration: scriptOptions.retryDuration,
        })
      }

      function readSignals(request, target) {
        const input = readInput(api, request || api.request)
        const result = target || {}
        if (!input) return result

        let parsed
        try {
          parsed = JSON.parse(input)
        } catch (error) {
          throw new Error('Failed to parse Datastar signals', { cause: error })
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Datastar signals must be a JSON object')
        }

        return Object.assign(result, parsed)
      }

      api.datastar = {
        EventType,
        ElementPatchMode,
        Namespace,
        scriptUrl,
        isRequest: function (request) {
          return isDatastarRequest(request || api.request)
        },
        headers: buildHeaders,
        scripts: function (scriptOptions) {
          const scriptOpts = scriptOptions || {}
          const parts = [buildLoaderScript(scriptOpts.scriptUrl || scriptUrl)]
          const spaOptions = scriptOpts.spa || scriptOpts.navigation
          if (spaOptions) parts.push(buildNavigationScript(spaOptions))
          if (scriptOpts.realtime) parts.push(buildRealtimeScript(scriptOpts.realtime))
          return parts.join('\n')
        },
        patchElements,
        html: patchElements,
        removeElements,
        patchSignals,
        signals: patchSignals,
        removeSignals,
        executeScript,
        script: executeScript,
        readSignals,
        requestSignals: function (target) {
          return readSignals(api.request, target || {})
        },
        consoleLog: function (message, options) {
          executeScript('console.log(' + JSON.stringify(message) + ')', options)
        },
        consoleError: function (error, options) {
          const message = typeof error === 'string' ? error : error.message
          executeScript('console.error(' + JSON.stringify(message) + ')', options)
        },
        redirect: function (url, options) {
          executeScript('setTimeout(function(){ window.location.href = ' + JSON.stringify(url) + '; })', options)
        },
        replaceURL: function (url, options) {
          executeScript('window.history.replaceState({}, "", ' + JSON.stringify(url) + ')', options)
        },
        dispatchCustomEvent: function (eventName, detail, options) {
          if (!eventName) throw new Error('eventName is required')
          const eventOptions = Object.assign(
            {
              selector: 'document',
              bubbles: true,
              cancelable: true,
              composed: true,
            },
            options || {}
          )
          const targetExpression = eventOptions.selector === 'document' ? '[document]' : 'Array.prototype.slice.call(document.querySelectorAll(' + JSON.stringify(eventOptions.selector) + '))'
          const detailExpression = detail === undefined ? 'undefined' : JSON.stringify(detail)
          const js = [
            'var elements = ' + targetExpression,
            'var event = new CustomEvent(' +
              JSON.stringify(eventName) +
              ', { bubbles: ' +
              String(!!eventOptions.bubbles) +
              ', cancelable: ' +
              String(!!eventOptions.cancelable) +
              ', composed: ' +
              String(!!eventOptions.composed) +
              ', detail: ' +
              detailExpression +
              ' })',
            'elements.forEach(function (element) { element.dispatchEvent(event); })',
          ].join(';\n')
          executeScript(js, {
            eventId: eventOptions.eventId,
            retryDuration: eventOptions.retryDuration,
          })
        },
        prefetch: function (urls, options) {
          const script = JSON.stringify(
            {
              prefetch: [
                {
                  source: 'list',
                  urls,
                },
              ],
            },
            null,
            2
          )
          executeScript(
            script,
            Object.assign(
              {
                autoRemove: false,
                attributes: { type: 'speculationrules' },
              },
              options || {}
            )
          )
        },
        realtime: {
          patchElements: function (elements, patchOptions, realtimeOptions) {
            if (!api.realtime || typeof api.realtime.send !== 'function') {
              throw new Error('pocketpages-plugin-realtime is required for datastar.realtime')
            }
            const realtime = normalizeRealtimeOptions(realtimeOptions)
            api.realtime.send(realtime.topic, buildRealtimePatchElementsPayload(api, elements, patchOptions), realtime.sendOptions)
          },
          removeElements: function (selector, patchOptions, realtimeOptions) {
            if (!api.realtime || typeof api.realtime.send !== 'function') {
              throw new Error('pocketpages-plugin-realtime is required for datastar.realtime')
            }
            const realtime = normalizeRealtimeOptions(realtimeOptions)
            api.realtime.send(realtime.topic, buildRealtimeRemoveElementsPayload(api, selector, patchOptions), realtime.sendOptions)
          },
          patchSignals: function (signals, patchOptions, realtimeOptions) {
            if (!api.realtime || typeof api.realtime.send !== 'function') {
              throw new Error('pocketpages-plugin-realtime is required for datastar.realtime')
            }
            const realtime = normalizeRealtimeOptions(realtimeOptions)
            api.realtime.send(realtime.topic, buildRealtimePatchSignalsPayload(api, signals, patchOptions), realtime.sendOptions)
          },
          removeSignals: function (signalKeys, patchOptions, realtimeOptions) {
            if (!api.realtime || typeof api.realtime.send !== 'function') {
              throw new Error('pocketpages-plugin-realtime is required for datastar.realtime')
            }
            const realtime = normalizeRealtimeOptions(realtimeOptions)
            api.realtime.send(realtime.topic, buildRealtimeRemoveSignalsPayload(api, signalKeys, patchOptions), realtime.sendOptions)
          },
        },
      }
    },
    onRender: function (context) {
      const api = context.api
      if (!api.datastar || !api.datastar.isRequest()) return context.content

      const selector = api.request.header('Datastar-Selector')
      const mode = api.request.header('Datastar-Mode')
      const namespace = api.request.header('Datastar-Namespace')
      const useViewTransition = api.request.header('Datastar-Use-View-Transition')
      const viewTransitionSelector = api.request.header('Datastar-View-Transition-Selector')
      const options = {}

      if (selector) {
        options.selector = selector
        options.mode = mode || ElementPatchMode.Inner
      } else if (mode) {
        options.mode = mode
      }
      if (namespace) options.namespace = namespace
      if (String(useViewTransition || '').toLowerCase() === 'true') {
        options.useViewTransition = true
      }
      if (viewTransitionSelector) {
        options.viewTransitionSelector = viewTransitionSelector
      }

      if (!hasValue(context.content) || !String(context.content).trim()) {
        return context.content
      }

      api.datastar.patchElements(context.content, options)
      return context.content
    },
  }
}

datastarPluginFactory.realtime = {
  /**
   * element patch realtime payload를 만듭니다.
   * @param {unknown} elements patch할 element HTML입니다.
   * @param {Record<string, any>} patchOptions patch 옵션입니다.
   * @returns {Record<string, any>} realtime payload입니다.
   */
  buildPatchElementsPayload: function (elements, patchOptions) {
    return buildRealtimePatchElementsPayload(null, elements, patchOptions)
  },
  /**
   * element 제거 realtime payload를 만듭니다.
   * @param {unknown} selector 제거할 element selector입니다.
   * @param {Record<string, any>} patchOptions patch 옵션입니다.
   * @returns {Record<string, any>} realtime payload입니다.
   */
  buildRemoveElementsPayload: function (selector, patchOptions) {
    return buildRealtimeRemoveElementsPayload(null, selector, patchOptions)
  },
  /**
   * signal patch realtime payload를 만듭니다.
   * @param {unknown} signals patch할 signal 값입니다.
   * @param {Record<string, any>} patchOptions patch 옵션입니다.
   * @returns {Record<string, any>} realtime payload입니다.
   */
  buildPatchSignalsPayload: function (signals, patchOptions) {
    return buildRealtimePatchSignalsPayload(null, signals, patchOptions)
  },
  /**
   * signal 제거 realtime payload를 만듭니다.
   * @param {unknown} signalKeys 제거할 signal key입니다.
   * @param {Record<string, any>} patchOptions patch 옵션입니다.
   * @returns {Record<string, any>} realtime payload입니다.
   */
  buildRemoveSignalsPayload: function (signalKeys, patchOptions) {
    return buildRealtimeRemoveSignalsPayload(null, signalKeys, patchOptions)
  },
}
datastarPluginFactory.createRealtimeSender = createRealtimeSender

module.exports = datastarPluginFactory
