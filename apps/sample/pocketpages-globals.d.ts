import type { MiddlewareNextFunc, PagesGlobalContext, PagesRequestContext, PagesResponse } from 'pocketpages'
import type DatastarPlugin = require('pocketpages-plugin-datastar-v1')
import type { Client, ClientId, RealtimeOptions } from 'pocketpages-plugin-realtime'

// Editor-only mirror for globals injected by PocketPages core and plugins in
// `pb_hooks/pages/+config.js`.

type PocketPagesDatastarApi = DatastarPlugin.DatastarApi
type PocketPagesRealtimeApi = {
  getClientById: (clientId: ClientId) => Client | undefined
  send: (topic: string, message: string, options?: RealtimeOptions) => void
}
type PocketPagesEditorResponse = Omit<PagesResponse, 'cookie'> & {
  // PocketPages 0.22.3 returns the serialized cookie value at runtime.
  cookie: <T>(name: string, value: T, options?: Parameters<PagesResponse['cookie']>[2]) => string
}
type PocketPagesEditorApi<TData = any> = Omit<PagesRequestContext<TData>, 'formData' | 'response'> & {
  datastar: PocketPagesDatastarApi
} & { realtime: PocketPagesRealtimeApi } & {
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

  // `pocketpages-plugin-realtime` runtime helper
  const realtime: PocketPagesRealtimeApi
}

export {}
