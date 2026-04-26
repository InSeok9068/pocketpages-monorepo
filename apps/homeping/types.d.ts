declare namespace types {
  type HomepingRegion = {
    slug: string
    label: string
    searchText: string
  }

  type HomepingNotice = {
    id: string
    sourceCode: string
    sourceLabel: string
    categoryLabel: string
    name: string
    address: string
    areaName: string
    businessOwner: string
    phone: string
    detailUrl: string
    recruitDate: string
    recruitDateLabel: string
    applyStartDate: string
    applyEndDate: string
    applyDateLabel: string
    winnerDateLabel: string
    moveInLabel: string
    householdCountLabel: string
    statusLabel: string
    statusCode: string
  }

  type HomepingEndpointSummary = {
    code: string
    label: string
    count: number
    error: string
  }

  type HomepingSearchInput = {
    regionSlug?: string
    includeClosed?: boolean
  }

  type HomepingSearchResult = {
    region: HomepingRegion
    notices: HomepingNotice[]
    summaries: HomepingEndpointSummary[]
    errors: string[]
  }
}
