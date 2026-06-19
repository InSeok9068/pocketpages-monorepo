# PRG Mutation

POST 후 상태를 변경하고 전체 페이지로 돌아갈 때 사용한다. 성공과 실패 모두 redirect로 끝내고, 화면 메시지는 `redirect(..., { message })`와 `params.__flash`를 통해 표시한다.

## File Shape

- `(site)/**/*.ejs`: form과 현재 상태 렌더링
- `xapi/**/*.ejs`: POST mutation 처리
- `_private/flash-alert.ejs`: PRG flash 표시
- `_private/**/*-service.js`: 여러 route에서 공유되는 도메인 로직

## Rules

- mutation은 기본적으로 `POST`를 사용한다.
- redirect 전에는 `dbg(...)`를 남긴다.
- redirect option은 `message`를 사용한다.
- flash query를 직접 만들지 않는다.
- page와 xapi는 request flow를 드러내고, 반복되는 도메인 로직만 `_private` service로 뺀다.

## Skeleton

```ejs
<script server>
  if (request.method !== 'POST') {
    dbg('xapi/items/create:redirect', {
      status: 303,
      redirectTo: '/',
      flash: '잘못된 요청입니다.',
    })
    redirect('/', {
      status: 303,
      message: '잘못된 요청입니다.',
    })
    return
  }

  const form = body()
  let errorMessage = ''

  dbg('xapi/items/create:start', {
    hasForm: !!form,
  })

  try {
    // validate
    // mutate

    dbg('xapi/items/create:redirect', {
      status: 303,
      redirectTo: '/',
      flash: '저장했습니다.',
    })
    redirect('/', {
      status: 303,
      message: '저장했습니다.',
    })
    return
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    error('xapi/items/create:failed', {
      error: errorMessage,
    })
  }

  dbg('xapi/items/create:redirect', {
    status: 303,
    redirectTo: '/',
    flash: errorMessage || '저장에 실패했습니다.',
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
