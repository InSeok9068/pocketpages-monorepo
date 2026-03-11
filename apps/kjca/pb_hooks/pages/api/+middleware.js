/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ request, response, resolve }, next) {
  const kjcaService = resolve('kjca-service');
  const authState = kjcaService.readAuthState(request);

  if (request.method !== 'POST') {
    return response.json(405, {
      ok: false,
      message: 'Method not allowed.',
    });
  }

  if (!authState.isSuperuser) {
    return response.json(401, {
      ok: false,
      message: 'PocketBase 슈퍼유저 로그인이 필요합니다.',
    });
  }

  next();
};
