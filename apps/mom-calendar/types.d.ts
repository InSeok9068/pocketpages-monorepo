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
}
