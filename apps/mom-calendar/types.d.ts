declare namespace types {
  type Workplace = {
    id: string
    name: string
    dailyPay: number
    overtimeHourlyPay: number
    mealAllowance: number
    defaultMealAllowancePaid: boolean
    memo: string
    createdAt: string
    updatedAt: string
  }

  type WorkLog = {
    date: string
    workplaceId: string
    workplaceNameSnapshot: string
    dailyPaySnapshot: number
    overtimeHourlyPaySnapshot: number
    mealAllowanceSnapshot: number
    overtimeHours: number
    mealAllowancePaid: boolean
    memo: string
    createdAt: string
    updatedAt: string
  }

  type BackupMeta = {
    backupId: string
    lastBackupAt: string
    lastRestoreAt: string
  }

  type MomCalendarBackup = {
    app: 'mom-calendar'
    version: number
    backupId: string
    createdAt: string
    data: {
      workplaces: Workplace[]
      workLogs: WorkLog[]
    }
  }
}
