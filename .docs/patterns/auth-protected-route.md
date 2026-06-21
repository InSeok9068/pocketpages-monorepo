# Auth Protected Route

로그인이 필요한 page, xapi, api route에 사용한다. 응답 형식에 맞게 auth 실패 처리를 다르게 한다.

## Rules

- full page 또는 xapi fallback은 `/sign-in` redirect를 사용한다.
- JSON API는 `401` JSON을 반환한다.
- Datastar 요청은 `datastar.redirect('/sign-in')` 또는 signal patch를 사용한다.
- redirect 전에는 `dbg(...)`를 남긴다.
- 도메인 role 판단은 `_private/roles/*`에 둘 수 있지만, role module 안에 DB write나 redirect를 숨기지 않는다.

## Page Or XAPI

```ejs
<script server>
  if (!request.auth) {
    dbg('page/items:redirect', {
      status: 303,
      redirectTo: '/sign-in',
      message: '로그인이 필요합니다.',
    })
    redirect('/sign-in', {
      status: 303,
      message: '로그인이 필요합니다.',
    })
    return
  }
</script>
```

## JSON API

```ejs
<script server>
  if (!request.auth) {
    response.json(401, {
      ok: false,
      message: '로그인이 필요합니다.',
    })
    return
  }
</script>
```

## Datastar

```ejs
<script server>
  if (!request.auth) {
    if (datastar.isRequest(request)) {
      dbg('xapi/items/save:datastar-redirect', {
        redirectTo: '/sign-in',
        message: '로그인이 필요합니다.',
      })
      datastar.redirect('/sign-in')
      return
    }

    dbg('xapi/items/save:redirect', {
      status: 303,
      redirectTo: '/sign-in',
      message: '로그인이 필요합니다.',
    })
    redirect('/sign-in', {
      status: 303,
      message: '로그인이 필요합니다.',
    })
    return
  }
</script>
```

## Check

- `./task.sh index <service> --section routeLinks`
- `./task.sh lint <service>`
