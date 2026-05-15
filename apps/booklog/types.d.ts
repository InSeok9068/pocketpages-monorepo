declare namespace types {
  interface BooklogOneSignalPushInput {
    externalIds: string[]
    title: string
    contents: string
    timeout?: number
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
