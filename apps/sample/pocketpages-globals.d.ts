import type { PagesGlobalContext, PagesRequestContext, PagesResponse } from 'pocketpages'
import type { Client, ClientId, RealtimeOptions } from 'pocketpages-plugin-realtime'

type PocketPagesEditorApi<TData = any> = PagesRequestContext<TData>
type PocketPagesEditorResponse = PagesResponse & {
  // Repo code uses response.status(...) inside <script server>.
  status: (status: number) => void
}
type PocketPagesRealtimeApi = {
  getClientById: (clientId: ClientId) => Client | undefined
  send: (topic: string, message: string, options?: RealtimeOptions) => void
}

declare global {
  const api: PocketPagesEditorApi<any>
  const asset: PocketPagesEditorApi<any>['asset']
  const auth: PocketPagesEditorApi<any>['auth']
  const data: PocketPagesEditorApi<any>['data']
  const echo: PocketPagesEditorApi<any>['echo']
  const formData: PocketPagesEditorApi<any>['formData']
  const body: PocketPagesEditorApi<any>['body']
  const meta: PocketPagesEditorApi<any>['meta']
  const params: PocketPagesEditorApi<any>['params']
  const redirect: PocketPagesEditorApi<any>['redirect']
  const request: PocketPagesEditorApi<any>['request']
  const resolve: PocketPagesEditorApi<any>['resolve']
  const response: PocketPagesEditorResponse
  const slot: PocketPagesEditorApi<any>['slot']
  const slots: PocketPagesEditorApi<any>['slots']

  const url: PagesGlobalContext['url']
  const stringify: PagesGlobalContext['stringify']
  const env: PagesGlobalContext['env']
  const store: PagesGlobalContext['store']
  const dbg: PagesGlobalContext['dbg']
  const info: PagesGlobalContext['info']
  const warn: PagesGlobalContext['warn']
  const error: PagesGlobalContext['error']

  const include: (path: string, data?: Record<string, any>) => string
  const realtime: PocketPagesRealtimeApi
}

export {}
