declare namespace pocketpagesOneSignal {
  type JsonObject = Record<string, any>
  type OneSignalChannel = 'push' | 'email' | 'sms'
  type OneSignalLanguageMap = Record<string, string>

  /** OneSignal 클라이언트 공통 옵션입니다. 생략한 값은 환경 변수를 우선 사용합니다. */
  interface OneSignalClientOptions {
    /** OneSignal App ID입니다. 생략하면 `ONESIGNAL_APPID`를 사용합니다. */
    appId?: string
    /** OneSignal REST API Key입니다. 생략하면 `ONESIGNAL_APIKEY`를 사용합니다. */
    apiKey?: string
    /** OneSignal API base URL입니다. 생략하면 `ONESIGNAL_APIURL` 또는 기본 URL을 사용합니다. */
    baseUrl?: string
    /** 요청 제한 시간입니다. */
    timeoutSeconds?: number
  }

  /** alias 기반 발송 대상입니다. 주로 external_id를 사용합니다. */
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

  type OneSignalFilter = OneSignalFilterOperator | OneSignalTagFilter | OneSignalSessionFilter | OneSignalValueFilter | OneSignalLocationFilter | JsonObject

  interface OneSignalButton {
    id: string
    text: string
    icon?: string
    url?: string
  }

  /** OneSignal 알림 생성 요청입니다. 원본 payload를 직접 넘기거나 typed 필드를 사용할 수 있습니다. */
  interface OneSignalNotification {
    /** OneSignal 원본 payload를 그대로 넘길 때 사용합니다. */
    payload?: JsonObject
    /** 요청 단위 제한 시간입니다. */
    timeoutSeconds?: number

    /** OneSignal App ID입니다. 보통 클라이언트 옵션이나 환경 변수로 주입합니다. */
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

  /** OneSignal 알림 생성 호출 결과입니다. 실패해도 throw 대신 이 객체로 반환합니다. */
  interface OneSignalResult {
    /** HTTP 성공, notification id 수신, 오류 없음 여부입니다. */
    ok: boolean
    /** OneSignal HTTP status code입니다. 전송 실패면 0입니다. */
    statusCode: number
    /** OneSignal notification id입니다. 수신자가 없거나 실패하면 빈 문자열입니다. */
    notificationId: string
    /** OneSignal 원본 JSON 응답입니다. */
    responseJson: Record<string, any>
    /** OneSignal 응답의 errors 값을 배열로 정리한 값입니다. */
    errors: unknown[]
    /** 실패 사유 문자열입니다. 성공하면 빈 문자열입니다. */
    errorMessage: string
    /** 요청은 성공했지만 수신 가능한 구독자가 없는 경우입니다. */
    noSubscribedRecipients: boolean
  }

  /** PocketBase JSVM용 OneSignal 클라이언트입니다. */
  interface OneSignalClient {
    /** OneSignal notifications API를 호출합니다. */
    createNotification(notification: OneSignalNotification): OneSignalResult
  }
}

declare const pocketpagesOneSignal: {
  /** PocketBase JSVM용 OneSignal 클라이언트를 만듭니다. */
  createOneSignalClient(options?: pocketpagesOneSignal.OneSignalClientOptions): pocketpagesOneSignal.OneSignalClient
}

export = pocketpagesOneSignal
