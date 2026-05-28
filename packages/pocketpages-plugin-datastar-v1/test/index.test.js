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
