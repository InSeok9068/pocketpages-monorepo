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
    type: string
    typeLabel: string
    isPinned: boolean
    projectId: string
    projectName: string
    href: string
    dueAt: string
    dueBadge: ProjectTaskBadge | null
    signalBadges: ProjectTaskBadge[]
    updatedAt: string
  }

  interface ProjectTaskBadge {
    label: string
    tone: string
    icon: string
  }

  interface ProjectTaskProject {
    id: string
    nameKo: string
    nameEn?: string
    slug: string
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

  interface ProjectTaskAiItem {
    title: string
    status: string
    statusLabel: string
    priority: string
    priorityLabel: string
    type: string
    typeLabel: string
    projectName: string
    dueAt: string
    signals: string[]
    description: string
    updatedAt: string
    isPinned: boolean
  }

  interface ProjectTaskAiStatus {
    status: string
    label: string
    count: number
    tasks: ProjectTaskAiItem[]
  }

  interface ProjectTaskAiContext {
    title: string
    scope: string
    scopeLabel: string
    generatedAt: string
    project: ProjectTaskProject | null
    taskCount: number
    statuses: ProjectTaskAiStatus[]
  }

  interface ProjectTaskAiCopyInput {
    boardState: ProjectTaskBoardState
    title?: string
    scope?: string
    scopeLabel?: string
    project?: ProjectTaskProject | null
  }

  interface ProjectTaskAiCopyResult {
    markdown: string
    jsonText: string
  }
}
