/********** dateutil start **********/

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
  /** 자주 쓰는 날짜 포맷 문자열입니다. */
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
  /**
   * KST 기준으로 해석한 Date 객체를 반환합니다.
   *
   * Date 객체가 필요한 계산에서만 사용하고, 표시 문자열은 formatDate()를 사용합니다.
   */
  toDate(value: DateutilInput): Date
  /** 날짜 값을 KST 기준 문자열로 포맷합니다. */
  formatDate(value: DateutilInput, pattern?: DateutilFormat | string): string
  /**
   * KST 기준 날짜-only 값을 PB date 저장용 ISO 문자열로 바꿉니다.
   *
   * 날짜 라벨을 보존하기 위해 YYYY-MM-DDT00:00:00.000Z 형태로 저장합니다.
   * 실제 발생 시각 저장에는 사용하지 않습니다.
   */
  toDateOnlyIso(value: DateutilInput): string
  /** 날짜에 일 수를 더한 뒤 KST 기준 Date 객체를 반환합니다. */
  addDays(value: DateutilInput, amount: number): Date
  /**
   * KST 기준 해당 일자의 시작 시각을 반환합니다.
   *
   * 날짜 단위 검색의 시작 ISO를 만들 때 사용합니다.
   */
  startOfDay(value: DateutilInput): Date
  /**
   * KST 기준 해당 일자의 끝 시각을 반환합니다.
   *
   * 날짜 단위 검색의 종료 ISO를 만들 때 사용합니다.
   */
  endOfDay(value: DateutilInput): Date
  /** 두 날짜가 KST 기준으로 같은 날짜인지 확인합니다. */
  isSameDay(left: DateutilInput, right: DateutilInput): boolean
}

/********** dateutil end **********/

/********** store-cache start **********/

interface StoreCacheOptions {
  /** namespace 안에 남길 최대 entry 수입니다. 오래된 entry부터 정리합니다. */
  maxEntries?: number
}

interface StoreCacheWriteOptions extends StoreCacheOptions {
  /** cache entry가 유지될 millisecond입니다. 양수여야 합니다. */
  ttlMs: number
}

interface StoreCacheRememberOptions extends StoreCacheWriteOptions {
  /** cache miss 때 호출할 동기 loader입니다. */
  load(): any
}

interface StoreCacheApi {
  /**
   * namespace/key로 저장된 TTL cache 값을 읽습니다.
   *
   * 내부에서 PocketBase `$app.store()` runtime store를 사용합니다.
   */
  get(namespace: string, key: string, options?: StoreCacheOptions): any | undefined
  /**
   * namespace/key에 TTL cache 값을 저장합니다.
   *
   * 외부 API 응답이나 계산 결과처럼 재생성 가능한 JSON 값을 저장할 때 사용합니다.
   */
  set(namespace: string, key: string, value: any, options: StoreCacheWriteOptions): any
  /**
   * cache 값이 있으면 반환하고, 없거나 만료되었으면 load 결과를 저장 후 반환합니다.
   *
   * JSVM 제약에 맞춰 loader는 동기 함수여야 합니다.
   */
  remember(namespace: string, key: string, options: StoreCacheRememberOptions): any
  /** namespace/key에 저장된 cache 값을 삭제합니다. */
  remove(namespace: string, key: string): boolean
  /** namespace 안의 만료 entry를 정리하고 남은 entry 수를 반환합니다. */
  cleanup(namespace: string, options?: StoreCacheOptions): number
}

/********** store-cache end **********/

declare const pocketpagesUtils: {
  dateutil: DateutilApi
  storeCache: StoreCacheApi
}

export = pocketpagesUtils
