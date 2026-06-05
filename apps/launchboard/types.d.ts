declare namespace types {
  interface PocketBaseRecord {
    get(field: string): unknown
  }

  interface ProjectCard {
    id: string
    nameKo: string
    nameEn: string
    slug: string
    href: string
    tasksHref: string
    status: string
    domainUrl: string
    faviconUrls: string[]
    repoUrl: string
    description: string
    priority: string
    priorityLabel: string
    priorityTone: string
    showPriority: boolean
    isPinned: boolean
    startedAt: string
    launchedAt: string
    discardedAt: string
    updatedAt: string
  }

  interface ProjectStatusColumn {
    value: string
    label: string
    tone: string
    icon: string
    iconTone: string
    surface: string
  }

  interface ProjectBoardState {
    statusColumns: ProjectStatusColumn[]
    projectsByStatus: Record<string, ProjectCard[]>
    projectCount: number
  }

  interface ProjectTaskCard {
    id: string
    title: string
    description: string
    status: string
    priority: string
    priorityLabel: string
    priorityTone: string
    showPriority: boolean
    type: string
    typeLabel: string
    isPinned: boolean
    dueAt: string
    updatedAt: string
  }

  interface ProjectTaskStatusColumn {
    value: string
    label: string
    icon: string
    iconTone: string
    surface: string
  }

  interface ProjectTaskBoardState {
    statusColumns: ProjectTaskStatusColumn[]
    tasksByStatus: Record<string, ProjectTaskCard[]>
    taskCount: number
  }
}
