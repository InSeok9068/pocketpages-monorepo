declare namespace DatastarV1 {
  type ElementPatchMode = 'outer' | 'inner' | 'remove' | 'replace' | 'prepend' | 'append' | 'before' | 'after'

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

  type RemoveSignalsOptions = Omit<PatchSignalsOptions, 'onlyIfMissing'>

  type SignalKeyInput = string | string[]

  interface ExecuteScriptOptions {
    autoRemove?: boolean
    attributes?: string[] | Record<string, string | boolean | number | null | undefined>
    eventId?: string
    retryDuration?: number
  }

  interface DispatchCustomEventOptions {
    eventId?: string
    retryDuration?: number
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
    ElementPatchMode: {
      Outer: 'outer'
      Inner: 'inner'
      Remove: 'remove'
      Replace: 'replace'
      Prepend: 'prepend'
      Append: 'append'
      Before: 'before'
      After: 'after'
    }
    Namespace: {
      Html: 'html'
      Svg: 'svg'
      Mathml: 'mathml'
    }
    scriptUrl: string
    isRequest(request?: any): boolean
    headers(options?: HeaderOptions): Record<string, string>
    scripts(options?: ScriptOptions): string
    patchElements(elements: string, options?: PatchElementsOptions): void
    html(elements: string, options?: PatchElementsOptions): void
    removeElements(selector: string, options?: Omit<PatchElementsOptions, 'selector' | 'mode'>): void
    patchSignals(signals: string | Record<string, any>, options?: PatchSignalsOptions): void
    signals(signals: string | Record<string, any>, options?: PatchSignalsOptions): void
    removeSignals(signalKeys: SignalKeyInput, options?: RemoveSignalsOptions): void
    executeScript(script: string, options?: ExecuteScriptOptions): void
    script(script: string, options?: ExecuteScriptOptions): void
    readSignals<T extends object>(request: any, target?: T): T
    requestSignals<T extends object>(target?: T): T
    consoleLog(message: string, options?: ExecuteScriptOptions): void
    consoleError(error: Error | string, options?: ExecuteScriptOptions): void
    redirect(url: string, options?: ExecuteScriptOptions): void
    replaceURL(url: string, options?: ExecuteScriptOptions): void
    dispatchCustomEvent(eventName: string, detail?: any, options?: DispatchCustomEventOptions): void
    prefetch(urls: string[], options?: ExecuteScriptOptions): void
    realtime: {
      patchElements(elements: string, patchOptions?: PatchElementsOptions, realtimeOptions?: any): void
      removeElements(selector: string, patchOptions?: Omit<PatchElementsOptions, 'selector' | 'mode'>, realtimeOptions?: any): void
      patchSignals(signals: string | Record<string, any>, patchOptions?: PatchSignalsOptions, realtimeOptions?: any): void
      removeSignals(signalKeys: SignalKeyInput, patchOptions?: RemoveSignalsOptions, realtimeOptions?: any): void
    }
  }
}

declare namespace datastarV1PluginFactory {
  export type ElementPatchMode = DatastarV1.ElementPatchMode
  export type Namespace = DatastarV1.Namespace
  export interface PluginOptions extends DatastarV1.PluginOptions {}
  export interface HeaderOptions extends DatastarV1.HeaderOptions {}
  export interface ScriptOptions extends DatastarV1.ScriptOptions {}
  export interface SpaOptions extends DatastarV1.SpaOptions {}
  export interface RealtimeScriptOptions extends DatastarV1.RealtimeScriptOptions {}
  export interface PatchElementsOptions extends DatastarV1.PatchElementsOptions {}
  export interface PatchSignalsOptions extends DatastarV1.PatchSignalsOptions {}
  export type RemoveSignalsOptions = DatastarV1.RemoveSignalsOptions
  export type SignalKeyInput = DatastarV1.SignalKeyInput
  export interface ExecuteScriptOptions extends DatastarV1.ExecuteScriptOptions {}
  export interface DispatchCustomEventOptions extends DatastarV1.DispatchCustomEventOptions {}
  export interface DatastarApi extends DatastarV1.DatastarApi {}
}

declare function datastarV1PluginFactory(config: any, options?: datastarV1PluginFactory.PluginOptions): any

export = datastarV1PluginFactory
