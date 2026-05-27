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

Patch signals with an object:

```js
datastar.patchSignals({
  saved: true,
  form: {
    title: '',
  },
})
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
```

The browser helper subscribes to the `datastar` realtime topic and dispatches received payloads through Datastar's `datastar-fetch` event.
