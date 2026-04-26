const applyhomeService = require('../pages/_private/applyhome-service')
const notifiedNoticeService = require('./notified-notice-service')
const oneSignalService = require('./onesignal-service')

const REGION_SLUGS = ['anyang', 'uiwang', 'gwacheon']
const DEFAULT_PER_PAGE = 50

/**
 * DATAGOKR API 키를 읽습니다.
 * @returns {string} API 키
 */
function getRequiredDataApiKey() {
  const apiKey = String(process.env.DATAGOKR_APIKEY || '').trim()

  if (!apiKey) {
    throw new Error('DATAGOKR_APIKEY 환경변수가 필요합니다.')
  }

  return apiKey
}

/**
 * 알림 클릭 시 열 URL을 읽습니다.
 * @returns {string} 공개 URL
 */
function getPublicUrl() {
  return String(process.env.HOMEPING_PUBLIC_URL || process.env.APP_URL || '')
    .trim()
    .replace(/\/+$/, '')
}

/**
 * 공고 이름과 보조 정보를 합쳐 본문 한 줄을 만듭니다.
 * @param {types.HomepingNotice} notice 공고
 * @returns {string} 알림 본문
 */
function formatNoticeLine(notice) {
  const name = String(notice && notice.name ? notice.name : '신규 공고').trim()
  const address = String(notice && notice.address ? notice.address : '').trim()
  const category = String(notice && notice.categoryLabel ? notice.categoryLabel : '').trim()
  const suffix = address || category

  return suffix ? name + ' · ' + suffix : name
}

/**
 * 신규 공고 수에 맞는 푸시 제목을 만듭니다.
 * @param {{ notice: types.HomepingNotice, noticeKey: string }[]} entries 신규 공고 목록
 * @returns {string} 푸시 제목
 */
function createNotificationTitle(entries) {
  const count = Array.isArray(entries) ? entries.length : 0

  if (count <= 1) {
    return 'Homeping 신규 공고'
  }

  return 'Homeping 신규 공고 ' + count + '건'
}

/**
 * 신규 공고 수에 맞는 푸시 본문을 만듭니다.
 * @param {{ notice: types.HomepingNotice, noticeKey: string }[]} entries 신규 공고 목록
 * @returns {string} 푸시 본문
 */
function createNotificationContents(entries) {
  const list = Array.isArray(entries) ? entries : []

  if (list.length === 0) {
    return '새 공고가 등록되었습니다.'
  }

  if (list.length === 1) {
    return formatNoticeLine(list[0].notice)
  }

  return formatNoticeLine(list[0].notice) + ' 외 ' + String(list.length - 1) + '건'
}

/**
 * 푸시 클릭 URL을 정합니다.
 * @param {{ notice: types.HomepingNotice, noticeKey: string }[]} entries 신규 공고 목록
 * @returns {string} URL
 */
function createNotificationUrl(entries) {
  const publicUrl = getPublicUrl()
  const list = Array.isArray(entries) ? entries : []

  if (publicUrl) {
    return publicUrl
  }

  if (list.length === 1) {
    return String(list[0].notice && list[0].notice.detailUrl ? list[0].notice.detailUrl : '').trim()
  }

  return ''
}

/**
 * 공고 목록에 중복 없이 추가합니다.
 * @param {{ notice: types.HomepingNotice, noticeKey: string }[]} entries 누적 목록
 * @param {{ [key: string]: boolean }} seen 중복 맵
 * @param {types.HomepingNotice} notice 공고
 */
function pushUniqueNotice(entries, seen, notice) {
  const noticeKey = notifiedNoticeService.getNoticeKey(notice)

  if (!noticeKey || seen[noticeKey]) {
    return
  }

  seen[noticeKey] = true
  entries.push({
    notice: notice,
    noticeKey: noticeKey,
  })
}

/**
 * 세 지역의 현재 유효 공고를 합쳐 조회합니다.
 * @param {object} service 청약 공고 조회 서비스
 * @param {{ apiKey: string, perPage?: number, timeout?: number, regionSlugs?: string[] }} options 조회 옵션
 * @returns {{ entries: { notice: types.HomepingNotice, noticeKey: string }[], errorCount: number }} 조회 결과
 */
function collectCurrentNoticeEntries(service, options) {
  const regionSlugs = options && Array.isArray(options.regionSlugs) && options.regionSlugs.length > 0 ? options.regionSlugs : REGION_SLUGS
  /** @type {{ [key: string]: boolean }} */
  const seen = {}
  const entries = []
  let errorCount = 0

  for (let index = 0; index < regionSlugs.length; index += 1) {
    const regionSlug = String(regionSlugs[index] || '').trim()

    if (!regionSlug) {
      continue
    }

    try {
      const result = service.searchRegionNotices(
        {
          apiKey: options.apiKey,
          perPage: options.perPage || DEFAULT_PER_PAGE,
          timeout: options.timeout,
        },
        {
          regionSlug: regionSlug,
          includeClosed: false,
        }
      )
      const notices = result && Array.isArray(result.notices) ? result.notices : []
      const errors = result && Array.isArray(result.errors) ? result.errors : []

      for (let noticeIndex = 0; noticeIndex < notices.length; noticeIndex += 1) {
        pushUniqueNotice(entries, seen, notices[noticeIndex])
      }

      if (errors.length > 0) {
        errorCount += errors.length
        $app.logger().warn('jobs/homeping-notice-daily:region-errors', 'region', regionSlug, 'count', errors.length)
      }
    } catch (exception) {
      errorCount += 1
      $app.logger().error('jobs/homeping-notice-daily:region-failed', 'region', regionSlug, 'error', String(exception && exception.message ? exception.message : exception))
    }
  }

  return {
    entries: entries,
    errorCount: errorCount,
  }
}

/**
 * 발송 기록이 없는 신규 공고만 추립니다.
 * @param {object} service 발송 기록 서비스
 * @param {{ notice: types.HomepingNotice, noticeKey: string }[]} entries 전체 공고 목록
 * @returns {{ notice: types.HomepingNotice, noticeKey: string }[]} 신규 공고 목록
 */
function filterNewEntries(service, entries) {
  const list = Array.isArray(entries) ? entries : []
  const newEntries = []

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]

    if (!service.hasNotifiedNotice(entry.noticeKey)) {
      newEntries.push(entry)
    }
  }

  return newEntries
}

/**
 * 신규 공고를 조회하고 전체 구독자에게 푸시를 보냅니다.
 * @param {{ applyhomeService?: object, notifiedNoticeService?: object, oneSignalService?: object }} services 의존 서비스
 * @param {{ apiKey?: string, perPage?: number, timeout?: number, regionSlugs?: string[] }} options 실행 옵션
 * @returns {types.HomepingDailyNoticeJobResult} 실행 결과
 */
function runWithServices(services, options) {
  const sourceServices = services || {}
  const sourceOptions = options || {}
  const noticeSourceService = sourceServices.applyhomeService || applyhomeService
  const notifiedService = sourceServices.notifiedNoticeService || notifiedNoticeService
  const pushService = sourceServices.oneSignalService || oneSignalService
  const apiKey = String(sourceOptions.apiKey || getRequiredDataApiKey()).trim()
  const collectedResult = collectCurrentNoticeEntries(noticeSourceService, {
    apiKey: apiKey,
    perPage: sourceOptions.perPage || DEFAULT_PER_PAGE,
    timeout: sourceOptions.timeout,
    regionSlugs: sourceOptions.regionSlugs,
  })
  const newEntries = filterNewEntries(notifiedService, collectedResult.entries)

  $app.logger().info('jobs/homeping-notice-daily:checked', 'checkedCount', collectedResult.entries.length, 'newCount', newEntries.length, 'errorCount', collectedResult.errorCount)

  if (newEntries.length === 0) {
    return {
      checkedCount: collectedResult.entries.length,
      newCount: 0,
      sent: false,
      notificationId: '',
      errorCount: collectedResult.errorCount,
    }
  }

  const response = pushService.sendPushNotification({
    title: createNotificationTitle(newEntries),
    contents: createNotificationContents(newEntries),
    url: createNotificationUrl(newEntries),
  })
  const notificationId = String(response && response.id ? response.id : '').trim()
  const notifiedAt = new Date().toISOString()

  for (let index = 0; index < newEntries.length; index += 1) {
    notifiedService.createNotifiedNotice({
      notice: newEntries[index].notice,
      region: notifiedService.BROADCAST_REGION || 'all',
      notifiedAt: notifiedAt,
      providerMessageId: notificationId,
    })
  }

  $app.logger().info('jobs/homeping-notice-daily:sent', 'newCount', newEntries.length, 'notificationId', notificationId)

  return {
    checkedCount: collectedResult.entries.length,
    newCount: newEntries.length,
    sent: true,
    notificationId: notificationId,
    errorCount: collectedResult.errorCount,
  }
}

/**
 * 기본 의존성으로 신규 공고 알림 job을 실행합니다.
 * @returns {types.HomepingDailyNoticeJobResult} 실행 결과
 */
function run() {
  return runWithServices(null, null)
}

module.exports = {
  collectCurrentNoticeEntries,
  createNotificationContents,
  createNotificationTitle,
  filterNewEntries,
  run,
  runWithServices,
}
