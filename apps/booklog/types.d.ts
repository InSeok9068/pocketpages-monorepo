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

  type BookAudioModelName = 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts'

  interface BookAudioModelEntry {
    model: BookAudioModelName
    label: string
    isDefault: boolean
  }

  interface BookAudioVoiceEntry {
    /** Gemini 목소리 이름 */
    voice: string
    description: string
    isDefault: boolean
  }

  interface BookAudioStyleEntry {
    /** 요청 폼에서 고르는 값 */
    key: string
    label: string
    /** Gemini에 보내고 작업에 저장하는 스타일 문구 */
    text: string
    isDefault: boolean
  }

  interface BookAudioModelOption {
    model: BookAudioModelName
    label: string
    isDefault: boolean
    disabled: boolean
    busyBookTitle: string
  }

  interface BookAudioFailedChunkView {
    id: string
    /** `챕터:구간.조각` 형식의 위치 */
    position: string
    textLength: number
    preview: string
    /** 실패 종류와 재생성 시 나눌 수 있는지 */
    reasonLabel: string
    regenerateRequested: boolean
    /** 정책 차단이 아닌 실패의 오류 내용 */
    errorMessage: string
    /** PocketBase 관리자 화면의 레코드 조회 경로 */
    adminHref: string
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

  interface PopularBook {
    isbn13: string
    title: string
    author: string
    publisher: string
    publicationYear: string
    coverUrl: string
    detailUrl: string
    loanCount: number
    loanCountText: string
    rankChange: number
  }

  interface PopularBooksDeps {
    data4libraryService: { getPopularLoanBooks: Function; getHotTrendBooks: Function }
    config: { apiKey: string; timeout?: number }
  }

  interface BookAudioJobCounts {
    total: number
    ready: number
    failed: number
    blocked: number
  }

  interface BookAudioDuration {
    /** 만든 음성의 실제 길이(초) */
    readySeconds: number
    /** 만든 음성 + 남은 본문 추정 길이(초) */
    totalSeconds: number
    /** 반복 차단으로 기기 음성으로 읽는 부분의 추정 길이(초) */
    deviceSeconds: number
  }

  interface BookAudioArchive {
    /** 보관 파일을 만든 임시 작업 폴더 */
    directory: string
    archiveName: string
    /** 브라우저에 내려줄 파일 이름 */
    downloadName: string
    chunkCount: number
    audioCount: number
  }

  interface BookAudioArchiveRestoreResult {
    jobId: string
    status: string
    readyChunks: number
    /** 본문이 달라졌거나 음성이 없어 다시 생성할 구간 수 */
    queuedChunks: number
    /** 현재 본문과 맞지 않아 쓰지 않은 보관 음성 수 */
    discardedAudio: number
    progress: number
  }

  interface BookAudioJobView {
    status: string
    totalChunks: number
    readyChunks: number
    failedChunks: number
    /** 음성 길이 기준 진행률, 길이 정보가 없으면 구간 수 기준 */
    percent: number
    statusLabel: string
    /** 구간 수·실패 수 보조 표시, 길이 정보가 없으면 빈 값 */
    chunkLabel: string
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
