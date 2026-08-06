module.exports = function (api) {
  const appEnv = String(api.env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'

  return {
    plugins: ['pocketpages-plugin-ejs'],
    debug: isDevelopment,
  }
}
