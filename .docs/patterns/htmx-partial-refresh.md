# HTMX Partial Refresh

사용자의 scroll, focus, open panel, list position을 유지할 가치가 있을 때 HTMX partial refresh를 사용한다. 단순 저장 후 전체 화면 갱신이면 PRG를 우선한다.

## File Shape

- `(site)/**/*.ejs`: `hx-*` trigger와 target
- `xapi/**/*.ejs`: partial HTML 응답
- `_private/*.ejs`: target에 들어갈 markup

## Rules

- `hx-target`은 구체적인 element를 가리킨다.
- `hx-swap`은 필요한 동작만 명시한다.
- xapi 응답은 partial HTML 또는 redirect만 반환한다.
- partial은 최소 props만 받는다.
- mutation이 포함되면 POST를 사용한다.

## Skeleton

```ejs
<form
  method="post"
  action="/xapi/items/create"
  hx-post="/xapi/items/create"
  hx-target="#item-list"
  hx-swap="outerHTML">
  <input
    name="title"
    required />
  <button type="submit">저장</button>
</form>

<div id="item-list">
  <%- include('item-list.ejs', { items, error: '' }) %>
</div>
```

```ejs
<script server>
  const form = body()
  let errorMessage = ''
  let items = []

  try {
    // mutate
    // items = reloadItems()
  } catch (exception) {
    errorMessage = String(exception.message || exception)
  }
</script>
<%- include('item-list.ejs', {
  items,
  error: errorMessage,
}) %>
```

## Check

- `./task.sh index <service> --section routeLinks`
- `./task.sh index <service> --section partials`
- `./task.sh lint <service>`
