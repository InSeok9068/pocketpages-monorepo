/** @type {PocketPagesNextMiddlewareFunc} */
module.exports = function ({ dbg, redirect, request }, next) {
  if (!request.auth) {
    dbg('page/lab:auth:private:guard', {
      status: 303,
      redirectTo: '/lab/auth',
      message: 'Sign in required.',
    })
    return redirect('/lab/auth', {
      status: 303,
      message: 'Sign in required.',
    })
  }

  next({ authEmail: String(request.auth.get('email') || '') })
}
