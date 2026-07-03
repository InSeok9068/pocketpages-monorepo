import type { MiddlewareNextFunc, PagesGlobalContext, PagesRequestContext, PagesResponse } from 'pocketpages'
import type DatastarPlugin = require('pocketpages-plugin-datastar-v1')

// Editor-only mirror for globals injected by PocketPages core and plugins in
// `pb_hooks/pages/+config.js`.

type PocketPagesDatastarApi = DatastarPlugin.DatastarApi
type PocketPagesEditorApi<TData = any> = PagesRequestContext<TData> & {
  datastar: PocketPagesDatastarApi
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
type PocketPagesAuthData = {
  token: string
  record: core.Record
}
type PocketPagesRegisterAuthData = {
  token: string
  user: core.Record
  record?: core.Record
}
type PocketPagesAnonymousUserData = {
  email: string
  password: string
  user: core.Record
}
type PocketPagesPasswordlessUserData = {
  password: string
  user: core.Record
}
type PocketPagesOtpRequestData = {
  otpId: string
}
type PocketPagesPocketBasePasswordAuthResult = {
  token: string
  record: any
}
type PocketPagesPocketBaseClient = {
  collection: (name: string) => {
    authWithPassword: (email: string, password: string) => PocketPagesPocketBasePasswordAuthResult
  }
}
type PocketPagesPocketBaseCtor = new (baseUrl?: string, authStore?: any, lang?: string) => PocketPagesPocketBaseClient

type PocketPagesEditorResponse = PagesResponse & {
  // Repo code uses response.status(...) inside <script server>.
  status: (status: number) => void
}

declare module 'pocketpages' {
  export const globalApi: PagesGlobalContext
}

declare module 'pocketbase-js-sdk-jsvm' {
  const PocketBase: PocketPagesPocketBaseCtor
  export = PocketBase
}


declare global {
  const process: {
    env: Record<string, string | undefined>
  }
  interface PocketPagesRouteParams {}
  type PocketPagesNextMiddlewareFunc<TData = any> = (api: PagesRequestContext<TData>, next: MiddlewareNextFunc) => void

  // `pocketpages` core request/context globals
  const api: PocketPagesEditorApi<any>
  const asset: PocketPagesEditorApi<any>['asset']
  const auth: PocketPagesEditorApi<any>['auth']
  const data: PocketPagesEditorApi<any>['data']
  const echo: PocketPagesEditorApi<any>['echo']
  const formData: () => any
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
  const createUser: (email: string, password: string, options?: PocketPagesAuthVerificationOptions) => core.Record
  const createAnonymousUser: (options?: PocketPagesAuthOptions) => PocketPagesAnonymousUserData
  const createPasswordlessUser: (email: string, options?: PocketPagesAuthVerificationOptions) => PocketPagesPasswordlessUserData
  const signInWithPassword: (email: string, password: string, options?: PocketPagesAuthOptions) => PocketPagesAuthData
  const registerWithPassword: (email: string, password: string, options?: PocketPagesAuthVerificationOptions) => PocketPagesRegisterAuthData
  const signInAnonymously: (options?: PocketPagesAuthOptions) => PocketPagesAuthData
  const requestOTP: (email: string, options?: PocketPagesAuthOptions) => PocketPagesOtpRequestData
  const signInWithOTP: (otpId: string, password: string, options?: PocketPagesAuthOptions) => PocketPagesAuthData
  const signInWithToken: (token: string) => void
  const requestOAuth2Login: (providerName: string, options?: PocketPagesOAuth2RequestOptions) => string
  const signInWithOAuth2: (state: string, code: string, options?: PocketPagesOAuth2ConfirmOptions) => PocketPagesAuthData
  const signOut: () => void
  const requestVerification: (email: string, options?: PocketPagesAuthOptions) => void
  const confirmVerification: (token: string, options?: PocketPagesAuthOptions) => void

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

  // `pocketpages-plugin-datastar-v1` runtime helper
  const datastar: PocketPagesDatastarApi
}

export {}
