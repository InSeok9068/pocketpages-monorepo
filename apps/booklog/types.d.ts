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

  interface BookAudioGenerationResult {
    ok: boolean
    statusCode: number
    error: string
  }

  interface BookAudioChunkView {
    chunkId: string
    configHash: string
    chunkCount: number
    nextSectionIndex: number
    audioUrl: string
  }

  interface BookAudioJobCounts {
    total: number
    ready: number
    failed: number
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
