# API JSON

JSON을 반환하는 `api/*` endpoint에 사용한다. 화면 조각이 아니라 data/API 응답이 목적일 때 선택한다.

## File Shape

- `api/**/*.ejs`: JSON endpoint
- `_private/**/*-service.js`: 재사용되는 조회, 검증, 변환 로직
- `types.d.ts`: 공유 input/output shape

## Rules

- JSON 응답은 `response.json(status, payload)`로 끝낸다.
- POST/PUT/PATCH는 `body()`, GET은 `request.url.query`를 사용한다.
- 성공 응답에는 `ok: true`, 실패 응답에는 `ok: false`를 둔다.
- 캐시가 애매하면 `Cache-Control: no-store`를 명시한다.
- auth 실패는 redirect가 아니라 `401` JSON을 반환한다.

## Skeleton

```ejs
<script server>
  if (request.method !== 'POST') {
    response.json(405, {
      ok: false,
      message: '잘못된 요청입니다.',
    })
    return
  }

  if (!request.auth) {
    response.json(401, {
      ok: false,
      message: '로그인이 필요합니다.',
    })
    return
  }

  const form = body()
  const userId = String(request.auth.get('id') || '')

  dbg('api/items/create:start', {
    userId,
    hasForm: !!form,
  })

  try {
    const payload = {
      ok: true,
      message: '처리했습니다.',
    }

    response.header('Cache-Control', 'no-store')
    response.json(200, payload)
    return
  } catch (exception) {
    const errorMessage = String(exception.message || exception)
    error('api/items/create:failed', {
      userId,
      error: errorMessage,
    })
    response.json(400, {
      ok: false,
      message: errorMessage || '처리에 실패했습니다.',
    })
    return
  }
</script>
```

## Check

- `./task.sh index <service> --section routes`
- `./task.sh lint <service>`
