declare namespace types {
  interface PocketBaseRecord {
    get(name: string): any
  }

  interface HomeItemFilters {
    section: 'task' | 'purchase' | 'grocery' | 'storage'
    keyword: string
    status: 'open' | 'done'
    tag: string
  }

  interface HomeItemCard {
    id: string
    title: string
    note: string
    section: 'task' | 'purchase' | 'grocery' | 'storage'
    channel: 'offline' | 'online' | 'fridge' | 'freezer' | ''
    status: 'open' | 'done'
    repeatFrequency: 'none' | 'weekly' | 'monthly'
    repeatInterval: number
    repeatWeekdays: string[]
    repeatDayOfMonth: number
    nextDueDate: string
    nextDueLabel: string
  }
}
