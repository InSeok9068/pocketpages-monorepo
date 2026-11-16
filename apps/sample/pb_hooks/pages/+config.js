const labRenderProbePlugin = require('./_private/lab-render-probe-plugin.js')

module.exports = function (api) {
  const appEnv = String(api.env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'
  const debugMode = String(api.env('PP_DEBUG') || '').trim() === 'verbose' ? 'verbose' : isDevelopment
  const sdkHost = String(api.env('PB_SDK_HOST') || 'http://localhost:8090').trim()

  return {
    plugins: [
      'pocketpages-plugin-ejs',
      'pocketpages-plugin-datastar-v1',
      'pocketpages-plugin-realtime',
      { name: 'pocketpages-plugin-js-sdk', host: sdkHost },
      'pocketpages-plugin-auth',
      { fn: labRenderProbePlugin },
    ],
    debug: debugMode,
  }
}
