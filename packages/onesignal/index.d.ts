declare namespace pocketpagesOneSignal {
  type JsonObject = Record<string, any>
  type OneSignalChannel = 'push' | 'email' | 'sms'
  type OneSignalLanguageMap = Record<string, string>

  interface OneSignalClientOptions {
    appId?: string
    apiKey?: string
    baseUrl?: string
    timeoutSeconds?: number
  }

  interface OneSignalAliasTarget {
    external_id?: string[]
    onesignal_id?: string[]
    [aliasLabel: string]: string[] | undefined
  }

  interface OneSignalFilterOperator {
    operator: 'AND' | 'OR'
  }

  interface OneSignalTagFilter {
    field: 'tag'
    key: string
    relation: '=' | '!=' | 'exists' | 'not_exists' | 'in_array' | 'not_in_array' | '>' | '<' | 'time_elapsed_gt' | 'time_elapsed_lt'
    value?: string
  }

  interface OneSignalSessionFilter {
    field: 'last_session' | 'first_session'
    relation: '>' | '<'
    hours_ago: string | number
  }

  interface OneSignalValueFilter {
    field: 'country' | 'language' | 'app_version' | 'session_count' | 'session_time'
    relation: '=' | '!=' | 'in_array' | 'not_in_array' | '>' | '<'
    value: string | number
  }

  interface OneSignalLocationFilter {
    field: 'location'
    radius: string | number
    lat: string | number
    long: string | number
  }

  type OneSignalFilter =
    | OneSignalFilterOperator
    | OneSignalTagFilter
    | OneSignalSessionFilter
    | OneSignalValueFilter
    | OneSignalLocationFilter
    | JsonObject

  interface OneSignalButton {
    id: string
    text: string
    icon?: string
    url?: string
  }

  interface OneSignalNotification {
    payload?: JsonObject
    timeoutSeconds?: number

    app_id?: string
    target_channel?: OneSignalChannel
    channel_for_external_user_ids?: OneSignalChannel
    include_aliases?: OneSignalAliasTarget
    include_subscription_ids?: string[]
    included_segments?: string[]
    excluded_segments?: string[]
    filters?: OneSignalFilter[]
    email_to?: string[]
    include_phone_numbers?: string[]

    headings?: OneSignalLanguageMap
    contents?: OneSignalLanguageMap
    subtitle?: OneSignalLanguageMap
    template_id?: string
    email_subject?: string
    email_body?: string
    email_preheader?: string
    email_from_name?: string
    email_reply_to?: string
    sms_from?: string
    sms_media_urls?: string[]
    url?: string
    data?: JsonObject
    buttons?: OneSignalButton[]

    isAnyWeb?: boolean
    isAndroid?: boolean
    isIos?: boolean
    isHuawei?: boolean
    big_picture?: string
    chrome_web_image?: string
    small_icon?: string
    large_icon?: string
    ios_attachments?: JsonObject
    android_channel_id?: string
    priority?: number
    ios_interruption_level?: 'passive' | 'active' | 'time_sensitive' | 'critical'
    collapse_id?: string

    send_after?: string
    delayed_option?: 'timezone' | 'last-active'
    delivery_time_of_day?: string
    throttle_rate_per_minute?: number
    idempotency_key?: string
  }

  interface OneSignalResult {
    ok: boolean
    statusCode: number
    notificationId: string
    responseBody: string
    responseJson: Record<string, any>
    errors: unknown[]
    headers: Record<string, any>
    elapsedMs: number
    transportError: string
    errorMessage: string
    noSubscribedRecipients: boolean
  }

  interface OneSignalClient {
    createNotification(notification: OneSignalNotification): OneSignalResult
  }
}

declare const pocketpagesOneSignal: {
  createOneSignalClient(options?: pocketpagesOneSignal.OneSignalClientOptions): pocketpagesOneSignal.OneSignalClient
}

export = pocketpagesOneSignal
