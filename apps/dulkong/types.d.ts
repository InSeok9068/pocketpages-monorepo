declare namespace types {
  type CoupleDataApp = Pick<PocketBase, 'findFirstRecordByFilter' | 'findRecordsByFilter'>

  type CoupleProfile = {
    id: string
    profileKey: string
    name: string
    emoji: string
    colorClass: string
    lastReadAt: string
    pushEnabled: boolean
    chatMuted: boolean
  }

  type CoupleProfiles = {
    current: CoupleProfile
    partner: CoupleProfile
  }

  type AnniversaryItem = {
    id: string
    kind: string
    title: string
    eventDate: string
    dateLabel: string
    recurrence: string
    emoji: string
    isPinned: boolean
    dayLabel: string
    difference: number
  }

  type PlanItem = {
    id: string
    createdById: string
    kind: string
    kindLabel: string
    title: string
    startDate: string
    endDate: string
    startTime: string
    locationName: string
    note: string
    dateLabel: string
    timeLabel: string
    difference: number
  }

  type PhotoItem = {
    id: string
    uploaderId: string
    caption: string
    locationName: string
    takenAt: string
    dateLabel: string
    monthLabel: string
    isFavorite: boolean
    isChatBackground: boolean
    imageUrl: string
  }

  type MessageItem = {
    id: string
    senderId: string
    body: string
    lines: string[]
    createdAt: string
    mine: boolean
    showReadReceipt: boolean
    timeLabel: string
    dateLabel: string
  }

  type MessagePageOptions = {
    limit?: number
    beforeCreated?: string
    beforeId?: string
    partnerLastReadAt?: string
  }

  type MessagePage = {
    messages: MessageItem[]
    hasMore: boolean
  }
}
