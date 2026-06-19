# Realtime Broadcast

서버에서 여러 client로 같은 topic의 업데이트를 보내야 할 때 사용한다. UI framework에 따라 HTML, signal, 또는 일반 message를 보낸다.

## File Shape

- `api/**/*.ejs` 또는 `xapi/**/*.ejs`: broadcast trigger
- `_private/*.ejs`: HTML payload가 복잡할 때 partial로 작성
- `(site)/**/*.ejs`: subscription 또는 client-side listener

## Rules

- 서비스 `+config.js`에 `pocketpages-plugin-realtime`이 있어야 한다.
- HTMX SSE를 쓰면 `pocketbase-htmx-ext-sse-0.0.3.js`와 `hx-ext="sse"`를 함께 사용한다.
- Datastar realtime을 쓰면 `datastar.scripts({ realtime: true })`가 필요하다.
- topic 이름은 도메인 의미가 드러나게 정한다.
- broadcast 전에 `info(...)` 또는 `dbg(...)`로 topic과 payload 범위를 남긴다.
- 사용자별 권한이 필요한 경우 filter를 둔다.

## Skeleton

```ejs
<script server>
  const topic = 'items'
  const message = stringify({
    type: 'updated',
    id: String(params.id || ''),
  })

  info('api/items/broadcast:send', {
    topic,
    id: String(params.id || ''),
  })

  realtime.send(topic, message)

  response.json(200, {
    ok: true,
  })
  return
</script>
```

## Datastar Realtime

```ejs
<script server>
  datastar.realtime.patchSignals(
    {
      itemMessage: '변경되었습니다.',
    },
    undefined,
    {
      topic: 'items',
    }
  )
  return
</script>
```

## Check

- `./task.sh index <service> --section routeLinks`
- `./task.sh lint <service>`
