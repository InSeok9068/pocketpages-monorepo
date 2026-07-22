declare namespace types {
  interface PocketBaseRecord {
    get(field: string): unknown
  }

  type DeveloperOption = {
    id: string
    name: string
  }

  type WorkStateOption = {
    value: string
    label: string
    iconClass: string
    badgeClass: string
  }

  type WorkCard = {
    id: string
    title: string
    content: string
    done: boolean
    doneDate: string
    dueDate: string
    dueDateLabel: string
    createdLabel: string
    state: string
    stateLabel: string
    stateIconClass: string
    stateBadgeClass: string
    developerId: string
    developerName: string
    sort: number
    redmine: string
    joplin: string
    file: string
    originalFileName: string
    isUrgent: boolean
  }

  type RedmineUpdateInput = {
    id: string
    startDate?: string
    dueDate?: string
    doneRatio?: number
    notes?: string
    watchers?: string[]
  }
}
