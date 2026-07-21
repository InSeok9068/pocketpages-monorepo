declare namespace types {
  type CoupleDataApp = Pick<PocketBase, 'findFirstRecordByFilter' | 'findRecordsByFilter'>

  type CoupleProfile = {
    id: string
    profileKey: string
    name: string
    emoji: string
    colorClass: string
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

  type PhotoItem = {
    id: string
    uploaderId: string
    caption: string
    locationName: string
    takenAt: string
    dateLabel: string
    monthLabel: string
    isFavorite: boolean
    imageUrl: string
  }

  type MessageItem = {
    id: string
    senderId: string
    body: string
    lines: string[]
    mine: boolean
    timeLabel: string
    dateLabel: string
  }
}
