# Datastar Mutation

Datastar 요청에서 server-driven signal 또는 element patch를 반환할 때 사용한다. 같은 route가 non-Datastar fallback도 처리할 수 있어야 한다.

## File Shape

- `(site)/**/*.ejs`: `data-*` directive와 signal scope
- `xapi/**/*.ejs`: Datastar mutation
- `_private/*.ejs`: patch할 markup이 복잡할 때 사용

## Rules

- 서비스 `+config.js`에 `pocketpages-plugin-datastar-v1`이 있어야 한다.
- layout head에 `<%- datastar.scripts() %>`가 있어야 한다.
- Datastar 요청 여부는 `datastar.isRequest(request)`로 확인한다.
- Datastar 요청이면 `datastar.patchSignals`, `datastar.patchElements`, `datastar.redirect`를 사용한다.
- non-Datastar fallback redirect 전에는 `dbg(...)`를 남긴다.
- 전역 `message` signal은 충돌할 수 있으므로 화면 범위가 커지면 구체적인 signal 이름을 사용한다.

## Skeleton

```ejs
<script server>
  function patchMessage(message) {
    datastar.patchSignals({
      itemMessage: message,
    })
  }

  if (request.method !== 'POST') {
    if (datastar.isRequest(request)) {
      patchMessage('잘못된 요청입니다.')
      return
    }

    dbg('xapi/items/save:redirect', {
      status: 303,
      redirectTo: '/',
      message: '잘못된 요청입니다.',
    })
    redirect('/', {
      status: 303,
      message: '잘못된 요청입니다.',
    })
    return
  }

  const form = datastar.isRequest(request) ? datastar.requestSignals({}) : body()
  let errorMessage = ''

  try {
    // validate
    // mutate

    if (datastar.isRequest(request)) {
      patchMessage('')
      return
    }

    dbg('xapi/items/save:redirect', {
      status: 303,
      redirectTo: '/',
    })
    redirect('/', {
      status: 303,
    })
    return
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    error('xapi/items/save:failed', {
      error: errorMessage,
    })
  }

  if (datastar.isRequest(request)) {
    patchMessage(errorMessage || '저장에 실패했습니다.')
    return
  }

  dbg('xapi/items/save:redirect', {
    status: 303,
    redirectTo: '/',
    message: errorMessage || '저장에 실패했습니다.',
  })
  redirect('/', {
    status: 303,
    message: errorMessage || '저장에 실패했습니다.',
  })
  return
</script>
```

## Check

- `./task.sh index <service> --section routeLinks`
- `./task.sh lint <service>`
