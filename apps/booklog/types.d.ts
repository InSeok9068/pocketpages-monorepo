declare namespace types {
  /** `$app`과 트랜잭션 `txApp`을 모두 받는 DB 앱입니다. */
  type BooklogApp = PocketBase | core.App

  interface BookAudioSettings {
    provider: string
    model: string
    voice: string
    style: string
    pipelineVersion: string
    configHash: string
  }

  interface BookAudioSection {
    sectionIndex: number
    chunks: string[]
  }

  interface BookAudioModelOption {
    model: string
    label: string
    disabled: boolean
    busyBookTitle: string
  }

  interface BookAudioJobRequestResult {
    job: core.Record | null
    message: string
  }

  interface BookAudioGenerationResult {
    ok: boolean
    statusCode: number
    /** Gemini 정책 필터 차단 여부. 이 구간만 미루고 작업은 계속합니다. */
    blocked: boolean
    /** 반복 차단으로 구간을 조각 2개로 나눴는지 여부 */
    split: boolean
    error: string
    /** 실패 시 Gemini 오류 응답 본문(JSON, 최대 4,000자) */
    detail: string
  }

  interface BookAudioPartView {
    /** 생성 완료 조각의 음성 주소. 대체 조각이면 빈 문자열 */
    audioUrl: string
    /** 생성에 끝내 실패해 기기 음성으로 읽을 원문. 생성 완료 조각이면 빈 문자열 */
    fallbackText: string
    /** 아직 생성 전이라 기기 음성으로 대신 읽는 조각인지 여부. 생성에 끝내 실패한 조각은 false */
    pending: boolean
    /** 낭독 원문. 리더에서 듣는 위치를 찾을 때 씁니다 */
    text: string
    /** 재생 길이(초). 대체 조각은 글자 수로 추정 */
    durationSeconds: number
  }

  interface BookAudioChunkView {
    chunkId: string
    configHash: string
    chunkCount: number
    nextSectionIndex: number
    /** 음성 구간이 있는 이전 챕터 spine 순서, 없으면 -1 */
    previousSectionIndex: number
    /** 낭독 구간이 있는 챕터 중 몇 번째인지(1부터) */
    chapterNumber: number
    /** 낭독 구간이 있는 챕터 수 */
    chapterTotal: number
    /** 챕터 재생 바용 구간별 길이(초). 음성이 없는 구간은 글자 수로 추정 */
    timeline: number[]
    /** 재생 순서의 조각. 나누지 않은 구간은 1개 */
    parts: BookAudioPartView[]
  }

  interface BookAudioJobCounts {
    total: number
    ready: number
    failed: number
    blocked: number
  }

  interface BookAudioJobView {
    status: string
    totalChunks: number
    readyChunks: number
    failedChunks: number
    percent: number
    statusLabel: string
    nextRunLabel: string
    errorMessage: string
    canStart: boolean
    canPause: boolean
  }

  interface BooklogOneSignalPushInput {
    externalIds: string[]
    title: string
    contents: string
    timeout?: number
  }

  interface BooklogOneSignalResponse {
    id?: string
    [key: string]: any
  }

  interface BooklogPushSendLogInput {
    userId: string
    notificationKey: string
    channel: string
    sendStatus: string
    dedupeKey?: string
    bookId?: string
    shelfId?: string
    highlightId?: string
    title?: string
    bodyText?: string
    providerMessageId?: string
    errorMessage?: string
    sentAt?: string
    payloadJson?: Record<string, any>
  }

  interface BooklogReadingSessionGroupMap {
    [key: string]: any[]
  }

  interface EpubReadingMetrics {
    textCharCount: number
    chapterCount: number
    estimatedPageCount: number
    pageDivisor: number
    pageRule: string
  }

  interface ReaderSettings {
    theme: string
    fontSizePercent: number
    fontFamily: string
    lineHeight: string
    pageMargin: string
  }

  interface BookSearchScoreDetails {
    titleExact: boolean
    titlePartial: boolean
    authorExact: boolean
    authorPartial: boolean
    translatorExact: boolean
    translatorPartial: boolean
    publisherExact: boolean
    publisherPartial: boolean
    isbnExact: boolean
    hasIsbn13: boolean
    titleScore: number
    authorScore: number
    translatorScore: number
    publisherScore: number
    isbnScore: number
    bonusScore: number
    score: number
  }
}
