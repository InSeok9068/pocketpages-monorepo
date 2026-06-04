declare namespace types {
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
