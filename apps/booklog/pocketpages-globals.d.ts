import type { MiddlewareNextFunc, PagesGlobalContext, PagesRequestContext, PagesResponse } from 'pocketpages'
import type PocketBase from 'pocketbase-js-sdk-jsvm'
import type { AuthData as PocketPagesAuthData, User as PocketPagesAuthUser } from 'pocketpages-plugin-auth'
import type { PocketBaseClientOptions } from 'pocketpages-plugin-js-sdk'

// Editor-only mirror for globals injected by PocketPages core and plugins in
// `pb_hooks/pages/+config.js`.

type PocketPagesEditorResponse = Omit<PagesResponse, 'cookie'> & {
  // PocketPages 0.22.3 returns the serialized cookie value at runtime.
  cookie: <T>(name: string, value: T, options?: Parameters<PagesResponse['cookie']>[2]) => string
}
type PocketPagesAuthOptions = {
  collection?: string
}
type PocketPagesAuthVerificationOptions = {
  collection?: string
  sendVerificationEmail?: boolean
}
type PocketPagesOAuth2RequestOptions = {
  collection?: string
  cookieName?: string
  redirectPath?: string
  autoRedirect?: boolean
}
type PocketPagesOAuth2ConfirmOptions = {
  collection?: string
  cookieName?: string
}
type PocketPagesAnonymousUserData = {
  email: string
  password: string
  user: PocketPagesAuthUser
}
type PocketPagesPasswordlessUserData = {
  password: string
  user: PocketPagesAuthUser
}
type PocketPagesOtpRequestData = {
  otpId: string
}

type PocketPagesAuthGlobalApi = {
  createUser: (email: string, password: string, options?: PocketPagesAuthVerificationOptions) => PocketPagesAuthUser
  createAnonymousUser: (options?: PocketPagesAuthOptions) => PocketPagesAnonymousUserData
  // Runtime name is misspelled in pocketpages-plugin-auth 0.2.2.
  createPaswordlessUser: (
    email: string,
    options?: PocketPagesAuthVerificationOptions
  ) => PocketPagesPasswordlessUserData
  requestOTP: (email: string, options?: PocketPagesAuthOptions) => PocketPagesOtpRequestData
  requestVerification: (email: string, options?: PocketPagesAuthOptions) => void
  confirmVerification: (token: string, options?: PocketPagesAuthOptions) => void
}
type PocketPagesAuthRequestApi = {
  signInWithPassword: (email: string, password: string, options?: PocketPagesAuthOptions) => PocketPagesAuthData
  registerWithPassword: (
    email: string,
    password: string,
    options?: PocketPagesAuthVerificationOptions
  ) => PocketPagesAuthData
  signInAnonymously: (options?: PocketPagesAuthOptions) => PocketPagesAuthData
  signInWithOTP: (otpId: string, password: string, options?: PocketPagesAuthOptions) => PocketPagesAuthData
  requestOAuth2Login: (providerName: string, options?: PocketPagesOAuth2RequestOptions) => string
  signInWithOAuth2: (state: string, code: string, options?: PocketPagesOAuth2ConfirmOptions) => PocketPagesAuthData
  signOut: () => void
}
type PocketPagesAuthApi = PocketPagesAuthGlobalApi & PocketPagesAuthRequestApi
type PocketPagesJsSdkApi = {
  pb: (options?: Partial<PocketBaseClientOptions>) => PocketBase
}
type PocketPagesEditorApi<TData = any> = Omit<PagesRequestContext<TData>, 'formData' | 'response'>
  & PocketPagesAuthApi
  & PocketPagesJsSdkApi & {
    formData: () => Record<string, any>
    response: PocketPagesEditorResponse
  }

declare module 'pocketpages' {
  export const globalApi: PagesGlobalContext & PocketPagesAuthGlobalApi & PocketPagesJsSdkApi
}

declare global {
  const process: {
    env: Record<string, string | undefined>
  }
  interface PocketPagesRouteParams {}
  type PocketPagesNextMiddlewareFunc<TData = any> = (api: PocketPagesEditorApi<TData>, next: MiddlewareNextFunc) => void

  // `pocketpages` core request/context globals
  const api: PocketPagesEditorApi<any>
  const asset: PocketPagesEditorApi<any>['asset']
  const auth: PocketPagesEditorApi<any>['auth']
  const data: PocketPagesEditorApi<any>['data']
  const echo: PocketPagesEditorApi<any>['echo']
  // Raw request payload is normalized per route, so editor typing stays loose here.
  const formData: PocketPagesEditorApi<any>['formData']
  const body: () => any
  const meta: PocketPagesEditorApi<any>['meta']
  const params: PocketPagesEditorApi<any>['params'] & PocketPagesRouteParams
  const redirect: PocketPagesEditorApi<any>['redirect']
  const request: PocketPagesEditorApi<any>['request']
  const resolve: PocketPagesEditorApi<any>['resolve']
  const response: PocketPagesEditorResponse
  const slot: PocketPagesEditorApi<any>['slot']
  const slots: PocketPagesEditorApi<any>['slots']

  // `pocketpages-plugin-auth` auth helpers
  const createUser: PocketPagesAuthApi['createUser']
  const createAnonymousUser: PocketPagesAuthApi['createAnonymousUser']
  const createPaswordlessUser: PocketPagesAuthApi['createPaswordlessUser']
  const signInWithPassword: PocketPagesAuthApi['signInWithPassword']
  const registerWithPassword: PocketPagesAuthApi['registerWithPassword']
  const signInAnonymously: PocketPagesAuthApi['signInAnonymously']
  const requestOTP: PocketPagesAuthApi['requestOTP']
  const signInWithOTP: PocketPagesAuthApi['signInWithOTP']
  const requestOAuth2Login: PocketPagesAuthApi['requestOAuth2Login']
  const signInWithOAuth2: PocketPagesAuthApi['signInWithOAuth2']
  const signOut: PocketPagesAuthApi['signOut']
  const requestVerification: PocketPagesAuthApi['requestVerification']
  const confirmVerification: PocketPagesAuthApi['confirmVerification']

  // `pocketpages-plugin-js-sdk` runtime helper
  const pb: PocketPagesJsSdkApi['pb']

  // `pocketpages` core global helpers
  const url: PagesGlobalContext['url']
  const stringify: PagesGlobalContext['stringify']
  const env: PagesGlobalContext['env']
  const store: PagesGlobalContext['store']
  const dbg: PagesGlobalContext['dbg']
  const info: PagesGlobalContext['info']
  const warn: PagesGlobalContext['warn']
  const error: PagesGlobalContext['error']

  // `pocketpages-plugin-ejs` template helper
  const include: (path: string, data?: Record<string, any>) => string
}

export {}
