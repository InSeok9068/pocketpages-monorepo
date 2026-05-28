'use strict';

const assert = require('assert');
const datastarPluginFactory = require('..');

function createHarness(requestHeaders) {
  const output = [];
  const responseHeaders = {};
  const realtimeMessages = [];
  const plugin = datastarPluginFactory({ dbg: function () {} });
  const api = {
    response: {
      header: function (name, value) {
        if (value !== undefined) responseHeaders[name] = value;
        return responseHeaders[name];
      },
    },
    echo: function (value) {
      output.push(String(value));
    },
    stringify: JSON.stringify,
    asset: function (path) {
      return path;
    },
    request: {
      method: 'GET',
      url: { query: {} },
      header: function (name) {
        return requestHeaders && requestHeaders[name];
      },
    },
    realtime: {
      send: function (topic, message, options) {
        realtimeMessages.push({ topic, message, options });
      },
    },
  };

  plugin.onExtendContextApi({ api });

  return {
    api,
    plugin,
    responseHeaders,
    realtimeMessages,
    output: function () {
      return output.join('');
    },
  };
}

function createRealtimeSenderHarness() {
  const sentMessages = [];
  function SubscriptionMessage(input) {
    this.name = input.name;
    this.data = input.data;
  }
  function createClient(id, subscribed) {
    return {
      hasSubscription: function (topic) {
        return subscribed.indexOf(topic) !== -1;
      },
      send: function (message) {
        sentMessages.push({ id, message });
      },
    };
  }
  const clients = {
    allowed: createClient('allowed', ['dashboard']),
    blocked: createClient('blocked', ['dashboard']),
    unrelated: createClient('unrelated', []),
  };
  const sender = datastarPluginFactory.createRealtimeSender({
    app: {
      subscriptionsBroker: function () {
        return {
          clients: function () {
            return clients;
          },
        };
      },
    },
    SubscriptionMessage,
  });

  return {
    sender,
    sentMessages,
  };
}

function test(name, fn) {
  fn();
  console.log('ok - ' + name);
}

test('removeElements emits a remove element patch', function () {
  const harness = createHarness();

  harness.api.datastar.removeElements('#toast');

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-elements\n' +
      'data: selector #toast\n' +
      'data: mode remove\n' +
      '\n'
  );
  assert.strictEqual(harness.responseHeaders['Content-Type'], 'text/event-stream');
});

test('removeSignals emits a null signal patch for one key', function () {
  const harness = createHarness();

  harness.api.datastar.removeSignals('draft');

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-signals\n' +
      'data: signals {"draft":null}\n' +
      '\n'
  );
});

test('removeSignals emits nested null patches for dotted keys', function () {
  const harness = createHarness();

  harness.api.datastar.removeSignals(['draft.title', 'draft.body']);

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-signals\n' +
      'data: signals {"draft":{"title":null,"body":null}}\n' +
      '\n'
  );
});

test('removeSignals lets parent removal win over nested keys', function () {
  const harness = createHarness();

  harness.api.datastar.removeSignals(['draft', 'draft.title']);

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-signals\n' +
      'data: signals {"draft":null}\n' +
      '\n'
  );
});

test('removeSignals rejects onlyIfMissing because removal must be explicit', function () {
  const harness = createHarness();

  assert.throws(
    function () {
      harness.api.datastar.removeSignals('draft', { onlyIfMissing: true });
    },
    /removeSignals does not support onlyIfMissing/
  );
});

test('realtime remove helpers send Datastar watcher payloads', function () {
  const harness = createHarness();

  harness.api.datastar.realtime.removeElements('#notice');
  harness.api.datastar.realtime.removeSignals(['notice.title', 'notice.body']);

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
  ]);
});

test('realtime helpers normalize Datastar boolean args as raw strings', function () {
  const harness = createHarness();

  harness.api.datastar.realtime.patchElements('<div></div>', {
    selector: '#notice',
    useViewTransition: true,
  });
  harness.api.datastar.realtime.patchSignals({ ready: true }, {
    onlyIfMissing: true,
  });

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
  ]);
});

test('realtime helpers send custom topics without leaking topic into send options', function () {
  const harness = createHarness();
  const filter = function (clientId) {
    return clientId !== 'blocked';
  };

  harness.api.datastar.realtime.patchSignals(
    { ready: true },
    undefined,
    { topic: 'chat:conversation-1', filter }
  );

  assert.strictEqual(harness.realtimeMessages.length, 1);

  const message = harness.realtimeMessages[0];
  assert.strictEqual(message.topic, 'chat:conversation-1');
  assert.deepStrictEqual(JSON.parse(message.message), {
    type: 'datastar-patch-signals',
    el: null,
    argsRaw: {
      signals: JSON.stringify({ ready: true }),
    },
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(message.options, 'topic'),
    false
  );
  assert.strictEqual(typeof message.options.filter, 'function');
  assert.strictEqual(
    message.options.filter(
      'client-1',
      {
        hasSubscription: function () {
          return true;
        },
      },
      'chat:conversation-1',
      '{}'
    ),
    true
  );
  assert.strictEqual(
    message.options.filter(
      'blocked',
      {
        hasSubscription: function () {
          return true;
        },
      },
      'chat:conversation-1',
      '{}'
    ),
    false
  );
  assert.strictEqual(
    message.options.filter(
      'client-1',
      {
        hasSubscription: function () {
          return false;
        },
      },
      'chat:conversation-1',
      '{}'
    ),
    false
  );
});

test('realtime payload builders create PocketBase realtime Datastar messages', function () {
  assert.deepStrictEqual(
    JSON.parse(
      datastarPluginFactory.realtime.buildPatchElementsPayload(
        '<div id="notice">Updated</div>',
        { selector: '#notice', mode: 'outer' }
      )
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
  );

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
  );
});

test('realtime sender works outside PocketPages request context', function () {
  const harness = createRealtimeSenderHarness();

  harness.sender.patchSignals(
    { status: 'ready' },
    undefined,
    {
      topic: 'dashboard',
      filter: function (clientId) {
        return clientId !== 'blocked';
      },
    }
  );

  assert.deepStrictEqual(
    harness.sentMessages.map(function (entry) {
      return entry.id;
    }),
    ['allowed']
  );
  assert.strictEqual(harness.sentMessages[0].message.name, 'dashboard');
  assert.deepStrictEqual(JSON.parse(harness.sentMessages[0].message.data), {
    type: 'datastar-patch-signals',
    el: null,
    argsRaw: {
      signals: JSON.stringify({ status: 'ready' }),
    },
  });
});

test('realtime removeSignals rejects onlyIfMissing because removal must be explicit', function () {
  const harness = createHarness();

  assert.throws(
    function () {
      harness.api.datastar.realtime.removeSignals('draft', {
        onlyIfMissing: true,
      });
    },
    /realtime\.removeSignals does not support onlyIfMissing/
  );
});

test('scripts closes navigation and realtime script tags in raw HTML', function () {
  const harness = createHarness();

  const html = harness.api.datastar.scripts({
    spa: {
      scope: 'nav',
      selector: '#main',
    },
    realtime: true,
  });

  assert.ok(html.includes('new EventSource("/api/realtime")'));
  assert.ok(html.includes('data-on:click'));
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 4);
  assert.strictEqual(html.includes('<\\/script>'), false);
});

test('scripts subscribes realtime clients to custom topics', function () {
  const harness = createHarness();

  const html = harness.api.datastar.scripts({
    realtime: {
      topic: 'chat:conversation-1',
      clientIdSignal: 'chatClientId',
    },
  });

  assert.ok(html.includes('var topic = "chat:conversation-1";'));
  assert.ok(html.includes('var clientIdSignal = "chatClientId";'));
  assert.ok(html.includes('subscriptions: [topic]'));
  assert.ok(html.includes('source.addEventListener(topic'));
});

test('Datastar page render skips empty automatic element patches', function () {
  const harness = createHarness({
    'Datastar-Request': 'true',
  });

  harness.api.datastar.patchSignals({ ready: true });
  harness.plugin.onRender({ api: harness.api, content: '\n\n' });

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-signals\n' +
      'data: signals {"ready":true}\n' +
      '\n'
  );
});

test('Datastar page render still emits an inner patch for selectors', function () {
  const harness = createHarness({
    'Datastar-Request': 'true',
    'Datastar-Selector': '#main',
  });

  harness.plugin.onRender({ api: harness.api, content: '<h1>Hello</h1>' });

  assert.strictEqual(
    harness.output(),
    'event: datastar-patch-elements\n' +
      'data: selector #main\n' +
      'data: mode inner\n' +
      'data: elements <h1>Hello</h1>\n' +
      '\n'
  );
});
