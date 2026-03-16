module.exports = function (api) {
  const appEnv = String(api.env('APP_ENV') || 'development').trim();
  const isDevelopment = appEnv === 'development';

  return {
    plugins: ['pocketpages-plugin-js-sdk', 'pocketpages-plugin-auth', 'pocketpages-plugin-ejs', 'pocketpages-plugin-realtime'],
    debug: isDevelopment,
  };
};
