const { normalizeIsoDate, normalizeText, parseJsonSafely, parseNumber } = require('./photofolio-asset-utils')

const FRED_OBSERVATIONS_URL = 'https://api.stlouisfed.org/fred/series/observations'
const FRED_SERIES_META = {
  usdkrw: {
    key: 'usdkrw',
    seriesId: 'DEXKOUS',
    label: '원/달러 환율',
    unit: 'KRW',
  },
  treasury2y: {
    key: 'treasury2y',
    seriesId: 'DGS2',
    label: '미국 2년물',
    unit: '%',
  },
  treasury10y: {
    key: 'treasury10y',
    seriesId: 'DGS10',
    label: '미국 10년물',
    unit: '%',
  },
}
const TREND_RANGE_META = {
  '3m': { code: '3m', label: '3개월', days: 92 },
  '6m': { code: '6m', label: '6개월', days: 183 },
  '1y': { code: '1y', label: '1년', days: 366 },
  '3y': { code: '3y', label: '3년', days: 1096 },
}

function createEmptyLogger() {
  return {
    dbg: function () {},
    info: function () {},
    warn: function () {},
    error: function () {},
  }
}

/**
 * FRED API 키를 읽습니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {string} FRED API 키입니다.
 */
function readFredApiKey(envGetter) {
  return String(
    envGetter('FRED_APIKEY') ||
      envGetter('FRED_API_KEY') ||
      envGetter('FRED_KEY') ||
      envGetter('FRED_API_TOKEN') ||
      ''
  ).trim()
}

/**
 * 추이 조회 범위를 정리합니다.
 * @param {any} value 원본 범위 코드입니다.
 * @returns {{ code: types.PhotofolioTrendRangeCode, label: string, days: number }} 정규화된 범위 정보입니다.
 */
function normalizeTrendRange(value) {
  const normalized = normalizeText(value, 10).toLowerCase()

  if (TREND_RANGE_META[normalized]) {
    return TREND_RANGE_META[normalized]
  }

  return TREND_RANGE_META['1y']
}

/**
 * Date를 YYYY-MM-DD 문자열로 바꿉니다.
 * @param {Date} date 기준 날짜입니다.
 * @returns {string} ISO 날짜 문자열입니다.
 */
function formatIsoDate(date) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/**
 * 범위 시작일을 계산합니다.
 * @param {{ days: number }} rangeMeta 추이 범위 정보입니다.
 * @returns {string} 조회 시작일입니다.
 */
function buildObservationStart(rangeMeta) {
  const startDate = new Date()

  startDate.setDate(startDate.getDate() - Number(rangeMeta.days || 0))
  return formatIsoDate(startDate)
}

/**
 * FRED 관측치 조회 URL을 만듭니다.
 * @param {{ apiKey: string, seriesId: string, observationStart: string }} input 조회 입력입니다.
 * @returns {string} 호출 URL입니다.
 */
function buildObservationsUrl(input) {
  const query = [
    ['api_key', input.apiKey],
    ['file_type', 'json'],
    ['series_id', input.seriesId],
    ['sort_order', 'asc'],
    ['observation_start', input.observationStart],
  ]

  return (
    FRED_OBSERVATIONS_URL +
    '?' +
    query
      .map(function (entry) {
        return encodeURIComponent(entry[0]) + '=' + encodeURIComponent(entry[1])
      })
      .join('&')
  )
}

/**
 * FRED 관측치 배열을 정규화합니다.
 * @param {any[]} rawObservations 원본 관측치 목록입니다.
 * @returns {types.PhotofolioTrendPoint[]} 정규화된 시계열 점 목록입니다.
 */
function normalizeObservations(rawObservations) {
  const normalizedPoints = []

  for (let index = 0; index < rawObservations.length; index += 1) {
    const observation = rawObservations[index] && typeof rawObservations[index] === 'object' ? rawObservations[index] : {}
    const date = normalizeIsoDate(observation.date)
    const value = parseNumber(observation.value)

    if (!date || value === null) {
      continue
    }

    normalizedPoints.push({
      date: date,
      value: value,
    })
  }

  return normalizedPoints
}

/**
 * 개별 FRED 시리즈를 조회합니다.
 * @param {{ envGetter: (key: string) => string, seriesMeta: { key: string, seriesId: string, label: string, unit: string }, observationStart: string, logger?: { dbg?: Function, info?: Function, warn?: Function, error?: Function } }} input 조회 입력입니다.
 * @returns {types.PhotofolioTrendSeries} 정규화된 시리즈 정보입니다.
 */
function fetchTrendSeries(input) {
  const logger = input && input.logger ? input.logger : createEmptyLogger()
  const apiKey = readFredApiKey(input.envGetter)

  if (!apiKey) {
    throw new Error('FRED API 키가 설정되지 않았습니다.')
  }

  const url = buildObservationsUrl({
    apiKey: apiKey,
    seriesId: input.seriesMeta.seriesId,
    observationStart: input.observationStart,
  })

  logger.info('photofolio/fred:series:start', {
    seriesId: input.seriesMeta.seriesId,
    observationStart: input.observationStart,
  })

  const response = $http.send({
    url: url,
    method: 'GET',
    timeout: 20,
    headers: {
      accept: 'application/json',
    },
  })
  const statusCode = Number(response.statusCode || 0)
  const responseBody = toString(response.body)

  logger.info('photofolio/fred:series:done', {
    seriesId: input.seriesMeta.seriesId,
    statusCode: statusCode,
  })

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('FRED 시계열 데이터를 불러오지 못했습니다.')
  }

  const responseJson = parseJsonSafely(responseBody, {})
  const observations = Array.isArray(responseJson.observations) ? responseJson.observations : []
  const points = normalizeObservations(observations)
  const latestPoint = points.length ? points[points.length - 1] : null
  const previousPoint = points.length > 1 ? points[points.length - 2] : latestPoint
  const startPoint = points.length ? points[0] : null

  return {
    key: input.seriesMeta.key,
    series_id: input.seriesMeta.seriesId,
    label: input.seriesMeta.label,
    unit: input.seriesMeta.unit,
    points: points,
    latest_value: latestPoint ? latestPoint.value : null,
    previous_value: previousPoint ? previousPoint.value : null,
    start_value: startPoint ? startPoint.value : null,
    latest_date: latestPoint ? latestPoint.date : '',
  }
}

/**
 * 추이 대시보드용 주요 시리즈를 한 번에 조회합니다.
 * @param {{ envGetter: (key: string) => string, rangeCode?: any, logger?: { dbg?: Function, info?: Function, warn?: Function, error?: Function } }} input 조회 입력입니다.
 * @returns {{ range_meta: { code: types.PhotofolioTrendRangeCode, label: string, days: number }, observation_start: string, series_list: types.PhotofolioTrendSeries[], latest_date: string }} 추이 대시보드 데이터입니다.
 */
function buildTrendDashboard(input) {
  const logger = input && input.logger ? input.logger : createEmptyLogger()
  const rangeMeta = normalizeTrendRange(input.rangeCode)
  const observationStart = buildObservationStart(rangeMeta)
  const seriesList = [
    fetchTrendSeries({
      envGetter: input.envGetter,
      seriesMeta: FRED_SERIES_META.usdkrw,
      observationStart: observationStart,
      logger: logger,
    }),
    fetchTrendSeries({
      envGetter: input.envGetter,
      seriesMeta: FRED_SERIES_META.treasury2y,
      observationStart: observationStart,
      logger: logger,
    }),
    fetchTrendSeries({
      envGetter: input.envGetter,
      seriesMeta: FRED_SERIES_META.treasury10y,
      observationStart: observationStart,
      logger: logger,
    }),
  ]
  let latestDate = ''

  for (let index = 0; index < seriesList.length; index += 1) {
    const latestSeriesDate = String(seriesList[index].latest_date || '')
    if (latestSeriesDate && latestSeriesDate > latestDate) {
      latestDate = latestSeriesDate
    }
  }

  return {
    range_meta: rangeMeta,
    observation_start: observationStart,
    series_list: seriesList,
    latest_date: latestDate,
  }
}

module.exports = {
  buildTrendDashboard,
  normalizeTrendRange,
  readFredApiKey,
}
