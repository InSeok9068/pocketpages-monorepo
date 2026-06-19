# XAPI Partial

HTMX 요청처럼 화면 일부만 갱신할 때 사용한다. `xapi/*`는 layout HTML을 반환하지 않고 partial HTML 또는 redirect만 반환한다.

## File Shape

- `(site)/**/*.ejs`: partial을 받을 target과 `hx-*` 속성
- `xapi/**/*.ejs`: partial에 필요한 데이터 조회
- `_private/*.ejs`: 실제 partial markup

## Rules

- partial에는 필요한 props만 넘긴다.
- `request`, `response`, `api`, `resolve`, `params`, `data` 전체를 partial에 넘기지 않는다.
- GET partial은 `request.url.query`, POST partial은 `body()`를 기본으로 사용한다.
- 오류도 가능하면 같은 partial shape로 표시한다.
- layout HTML을 반환하지 않는다.

## Skeleton

```ejs
<script server>
  const form = request.method === 'POST' ? body() : request.url.query
  const userId = request.auth ? String(request.auth.get('id') || '') : ''
  let errorMessage = ''
  let items = []

  dbg('xapi/items/list:start', {
    userId,
    hasForm: !!form,
  })

  try {
    // items = findItems(...)
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    warn('xapi/items/list:load-failed', {
      userId,
      error: errorMessage,
    })
  }

  dbg('xapi/items/list:response', {
    userId,
    count: items.length,
    error: errorMessage || '',
  })
</script>
<%- include('item-list.ejs', {
  items,
  error: errorMessage,
}) %>
```

## Check

- `./task.sh index <service> --section partials`
- `./task.sh lint <service>`
