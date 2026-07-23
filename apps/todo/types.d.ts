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
    dueDayLabel: string
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

  type WorkCardFilters = {
    done?: boolean
    developerId?: string
    keyword?: string
    state?: string
    createdFrom?: string
    createdTo?: string
    updatedFrom?: string
    updatedTo?: string
    dueFrom?: string
    dueTo?: string
    sort?: string
    limit?: number
  }

  type RedmineUpdateInput = {
    id: string
    startDate?: string
    dueDate?: string
    doneRatio?: number
    statusId?: number
    assignedToId?: number
    notes?: string
    watchers?: string[]
  }

  type RedmineConfig = {
    host: string
    apiKey: string
    projectId?: string
    trackerId?: number
  }

  type RedmineCreateInput = {
    subject: string
    description?: string
    startDate?: string
    dueDate?: string
    watcherGroups?: string[]
  }

  type RedmineStatusOption = {
    id: number
    name: string
    isClosed: boolean
  }

  type RedmineAssigneeOption = {
    id: number
    name: string
  }

  type RedmineApiNamedValue = {
    id?: number | string
    name?: string
    is_closed?: boolean
  }

  type RedmineApiIssue = {
    id?: number | string
    subject?: string
    project?: RedmineApiNamedValue
    tracker?: RedmineApiNamedValue
    status?: RedmineApiNamedValue
    assigned_to?: RedmineApiNamedValue
    start_date?: string
    due_date?: string
    done_ratio?: number | string
    allowed_statuses?: RedmineApiNamedValue[]
    assignable_users?: RedmineApiNamedValue[]
  }

  type RedmineIssueView = {
    id: string
    subject: string
    projectName: string
    trackerName: string
    statusId: number
    statusName: string
    assignedToId: number
    assignedToName: string
    startDate: string
    dueDate: string
    doneRatio: number
    url: string
    allowedStatuses: RedmineStatusOption[]
    allowedAssignees: RedmineAssigneeOption[]
  }
}
