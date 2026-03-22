declare function require(moduleName: string): any;

declare namespace types {
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
