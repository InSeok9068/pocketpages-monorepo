type DateutilInput = Date | string | number | import('dayjs').Dayjs

type DateutilFormat =
  | 'YYYY-MM-DD'
  | 'YYYY년 MM월 DD일'
  | 'YYYY-MM-DD HH:mm:ss'
  | 'YYYY-MM-DD HH:mm'
  | 'HH:mm:ss'
  | 'HH:mm'
  | 'YYYY-MM'
  | 'YYYY년 MM월'
  | 'YYYYMMDD'
  | 'YYYYMMDDHHmmss'

interface DateutilApi {
  FORMATS: {
    DATE: 'YYYY-MM-DD'
    DATE_KR: 'YYYY년 MM월 DD일'
    DATE_TIME: 'YYYY-MM-DD HH:mm:ss'
    DATE_TIME_MINUTES: 'YYYY-MM-DD HH:mm'
    TIME: 'HH:mm:ss'
    TIME_MINUTES: 'HH:mm'
    MONTH: 'YYYY-MM'
    MONTH_KR: 'YYYY년 MM월'
    COMPACT_DATE: 'YYYYMMDD'
    COMPACT_DATE_TIME: 'YYYYMMDDHHmmss'
  }
  toDate(value: DateutilInput): Date
  formatDate(value: DateutilInput, pattern?: DateutilFormat | string): string
  toDateOnlyIso(value: DateutilInput): string
  addDays(value: DateutilInput, amount: number): Date
  startOfDay(value: DateutilInput): Date
  endOfDay(value: DateutilInput): Date
  isSameDay(left: DateutilInput, right: DateutilInput): boolean
}

declare const pocketpagesUtils: {
  dateutil: DateutilApi
}

export = pocketpagesUtils
