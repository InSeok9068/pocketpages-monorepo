module.exports = function (api) {
  const appEnv = String(api.env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'
  const sdkHost = String(api.env('PB_SDK_HOST') || 'http://localhost:8090').trim()

  return {
    plugins: [
      'pocketpages-plugin-ejs',
      'pocketpages-plugin-datastar-v1',
      'pocketpages-plugin-realtime',
      { name: 'pocketpages-plugin-js-sdk', host: sdkHost },
      'pocketpages-plugin-auth',
    ],
    debug: isDevelopment,
  }
}
