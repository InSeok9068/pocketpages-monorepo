declare namespace DatastarV1 {
  type ElementPatchMode =
    | 'outer'
    | 'inner'
    | 'remove'
    | 'replace'
    | 'prepend'
    | 'append'
    | 'before'
    | 'after'

  type Namespace = 'html' | 'svg' | 'mathml'

  interface PluginOptions {
    scriptUrl?: string
  }

  interface HeaderOptions {
    selector?: string
    mode?: ElementPatchMode
    namespace?: Namespace
    useViewTransition?: boolean
  }

  interface ScriptOptions {
    scriptUrl?: string
    spa?: boolean | SpaOptions
    navigation?: boolean | SpaOptions
    realtime?: boolean | RealtimeScriptOptions
  }

  interface SpaOptions {
    scope?: string
    selector?: string
  }

  interface RealtimeScriptOptions {
    endpoint?: string
    topic?: string
    clientIdSignal?: string
  }

  interface PatchElementsOptions {
    selector?: string
    mode?: ElementPatchMode
    namespace?: Namespace
    useViewTransition?: boolean
    eventId?: string
    retryDuration?: number
  }

  interface PatchSignalsOptions {
    onlyIfMissing?: boolean
    eventId?: string
    retryDuration?: number
  }

  interface ExecuteScriptOptions {
    autoRemove?: boolean
    attributes?: string[] | Record<string, string | boolean | number | null | undefined>
    eventId?: string
    retryDuration?: number
  }

  interface DispatchCustomEventOptions extends ExecuteScriptOptions {
    selector?: string
    bubbles?: boolean
    cancelable?: boolean
    composed?: boolean
  }

  interface DatastarApi {
    EventType: {
      PatchElements: 'datastar-patch-elements'
      PatchSignals: 'datastar-patch-signals'
    }
    ElementPatchMode: Record<string, ElementPatchMode>
    Namespace: Record<string, Namespace>
    scriptUrl: string
    isRequest(request?: any): boolean
    headers(options?: HeaderOptions): Record<string, string>
    scripts(options?: ScriptOptions): string
    patchElements(elements: string, options?: PatchElementsOptions): void
    html(elements: string, options?: PatchElementsOptions): void
    patchSignals(signals: string | Record<string, any>, options?: PatchSignalsOptions): void
    signals(signals: string | Record<string, any>, options?: PatchSignalsOptions): void
    executeScript(script: string, options?: ExecuteScriptOptions): void
    script(script: string, options?: ExecuteScriptOptions): void
    readSignals<T extends object>(request: any, target?: T): T
    requestSignals<T extends object>(target?: T): T
    consoleLog(message: string, options?: ExecuteScriptOptions): void
    consoleError(error: Error | string, options?: ExecuteScriptOptions): void
    redirect(url: string, options?: ExecuteScriptOptions): void
    replaceURL(url: string, options?: ExecuteScriptOptions): void
    dispatchCustomEvent(
      eventName: string,
      detail?: any,
      options?: DispatchCustomEventOptions
    ): void
    prefetch(urls: string[], options?: ExecuteScriptOptions): void
    realtime: {
      patchElements(
        elements: string,
        patchOptions?: PatchElementsOptions,
        realtimeOptions?: any
      ): void
      patchSignals(
        signals: string | Record<string, any>,
        patchOptions?: PatchSignalsOptions,
        realtimeOptions?: any
      ): void
    }
  }
}

declare function datastarV1PluginFactory(
  config: any,
  options?: DatastarV1.PluginOptions
): any

export = datastarV1PluginFactory
