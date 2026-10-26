// 기본 32MB에서 128MB로 상향하고, 오디오북 보관 파일 복원만 2GB까지 받습니다.
// 같은 ID로 등록해 PocketBase 기본 한도 미들웨어를 대신합니다.
routerUse(
  new Middleware(
    function (e) {
      const limit = e.request.url.path === '/xapi/books/audio-archive' ? 2048 * 1024 * 1024 : 128 * 1024 * 1024
      return $apis.bodyLimit(limit).func(e)
    },
    -990,
    'pbBodyLimit'
  )
)
