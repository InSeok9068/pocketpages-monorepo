import type { MiddlewareNextFunc, PagesGlobalContext, PagesRequestContext, PagesResponse } from 'pocketpages'

// Editor-only mirror for globals injected by PocketPages core and plugins in
// `pb_hooks/pages/+config.js`.

type PocketPagesEditorResponse = Omit<PagesResponse, 'cookie'> & {
  // PocketPages 0.22.3 returns the serialized cookie value at runtime.
  cookie: <T>(name: string, value: T, options?: Parameters<PagesResponse['cookie']>[2]) => string
}
type PocketPagesEditorApi<TData = any> = Omit<PagesRequestContext<TData>, 'formData' | 'response'> & {
  formData: () => Record<string, any>
  response: PocketPagesEditorResponse
}

declare module 'pocketpages' {
  export const globalApi: PagesGlobalContext
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
