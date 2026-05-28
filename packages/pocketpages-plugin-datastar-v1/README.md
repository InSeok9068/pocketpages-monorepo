# pocketpages-plugin-datastar-v1

Datastar 1.x adapter plugin for PocketPages.

This package keeps the server side thin: it loads a local Datastar browser bundle, exposes Datastar SSE helpers on the PocketPages context, and converts `Datastar-Request: true` page renders into `datastar-patch-elements` SSE responses.

## 추가 보강

Compared to the original PocketPages Datastar plugin, this package adds a few Datastar 1.x focused helpers while keeping the adapter thin:

- Vendors the Datastar `v1.0.1` browser bundle for local asset usage.
- Uses Datastar 1.x attribute syntax in the SPA helper, such as `data-on:click`.
- Keeps `spa` as the public navigation helper option for PocketPages layouts.
- Supports `Datastar-Selector`, `Datastar-Mode`, `Datastar-Namespace`, and `Datastar-Use-View-Transition` headers.
- Supports `namespace`, `eventId`, `retryDuration`, and view-transition options in SSE patch helpers.
- Adds `removeElements()` and `removeSignals()` conveniences for common removal patches.
- Reads signals from the query string for `GET` and `DELETE`, and from the request body for other methods.
- Adds optional realtime bridge helpers for `pocketpages-plugin-realtime`.

## Install

For this monorepo, add it to an app with a file dependency:

```json
{
  "dependencies": {
    "pocketpages-plugin-datastar-v1": "file:../../packages/pocketpages-plugin-datastar-v1"
  }
}
```

Then add it after the EJS plugin in `pb_hooks/pages/+config.js`:

```js
module.exports = function () {
  return {
    plugins: [
      'pocketpages-plugin-ejs',
      'pocketpages-plugin-datastar-v1',
      'pocketpages-plugin-realtime',
    ],
  }
}
```

`pocketpages-plugin-realtime` is only required when using `datastar.scripts({ realtime: true })` or `datastar.realtime.*`.

Copy the vendored Datastar bundle into the app's static assets:

```text
packages/pocketpages-plugin-datastar-v1/assets/vendor/datastar.min.js
-> apps/<service>/pb_hooks/pages/assets/vendor/datastar.min.js
```

## Scripts

Add Datastar to a layout head:

```ejs
<head>
  <%- datastar.scripts() %>
</head>
```

The default browser bundle is loaded from the app asset path:

```text
/assets/vendor/datastar.min.js
```

When PocketPages provides `asset()`, `datastar.scripts()` resolves that path through `api.asset()` for normal asset URL handling.

## Editor Types

For editor autocomplete, add the plugin dependency first, then connect the exported API type in the app's `pocketpages-globals.d.ts`:

```ts
import type DatastarPlugin = require('pocketpages-plugin-datastar-v1')

type PocketPagesDatastarApi = DatastarPlugin.DatastarApi

declare global {
  const datastar: PocketPagesDatastarApi
}
```

If you also want `api.datastar` autocomplete, intersect it with the app's editor API type:

```ts
type PocketPagesEditorApi<TData = any> = PagesRequestContext<TData> & {
  datastar: PocketPagesDatastarApi
}
```

SPA and realtime helpers are opt-in:

```ejs
<%- datastar.scripts({
  spa: {
    scope: 'nav',
    selector: '#main'
  },
  realtime: true
}) %>
```

`spa.selector` is sent as the `Datastar-Selector` request header, so rendered page content is patched into that selector with `mode: inner`.

## Server Helpers

Patch HTML elements:

```js
datastar.patchElements('<div id="message">Saved</div>')
```

Patch a selector:

```js
datastar.patchElements('<li>New item</li>', {
  selector: '#items',
  mode: 'append',
})
```

Remove elements:

```js
datastar.removeElements('#toast')
```

Patch signals with an object:

```js
datastar.patchSignals({
  saved: true,
  form: {
    title: '',
  },
})
```

Remove signals:

```js
datastar.removeSignals('draft')
datastar.removeSignals(['draft.title', 'draft.body'])
```

Read signals:

```js
const form = datastar.readSignals(request, {
  title: '',
  body: '',
})
```

For the current request:

```js
const form = datastar.requestSignals({
  title: '',
  body: '',
})
```

## Headers

For manual Datastar actions, send headers when you want PocketPages-rendered HTML to patch into a selector:

```html
<button data-on:click="@get('/posts', {headers: {'Datastar-Selector': '#main'}})">
  Reload
</button>
```

In EJS, `datastar.headers()` can build those headers:

```ejs
<button data-on:click="@get('/posts', {headers: <%- stringify(datastar.headers({ selector: '#main' })) %>})">
  Reload
</button>
```

Supported render headers:

- `Datastar-Selector`
- `Datastar-Mode`
- `Datastar-Namespace`
- `Datastar-Use-View-Transition`

## Realtime

With `pocketpages-plugin-realtime` configured:

```js
datastar.realtime.patchElements('<div id="notice">Updated</div>')
datastar.realtime.patchSignals({ count: 3 })
datastar.realtime.removeElements('#notice')
datastar.realtime.removeSignals(['notice.title', 'notice.body'])
```

The browser helper subscribes to the `datastar` realtime topic and dispatches received payloads through Datastar's `datastar-fetch` event.

Use a custom topic when the page subscribes to a scoped stream:

```ejs
<%- datastar.scripts({ realtime: { topic: 'dashboard' } }) %>
```

```js
datastar.realtime.patchSignals(
  { status: 'ready' },
  undefined,
  { topic: 'dashboard' }
)
```

## Background jobs

PocketBase jobs do not run inside a PocketPages request context, so the route
global `datastar` is not available there. Create a realtime sender with the
PocketBase globals instead:

```js
const datastarV1 = require('pocketpages-plugin-datastar-v1')

const datastarRealtime = datastarV1.createRealtimeSender({
  app: $app,
  SubscriptionMessage: SubscriptionMessage,
})

datastarRealtime.patchSignals(
  {
    status: 'ready',
    checkedAt: new Date().toISOString(),
  },
  undefined,
  { topic: 'dashboard' }
)
```

Payload builders are also available when you want to send through
`$app.subscriptionsBroker()` directly:

```js
const payload = datastarV1.realtime.buildPatchSignalsPayload({
  status: 'ready',
})
```
