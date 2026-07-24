const oneSignalService = require('./onesignal-service')
const pushSendLogService = require('./push-send-log-service')
const { dateutil } = require('@pocketpages/utils')

const NOTIFICATION_KEY = 'weekly_reading_nudge'
const PUSH_CHANNEL = 'push'

/**
 * 한국시간 기준 이번 주 조회 범위를 만듭니다.
 *
 * @param {Date} nowDate 현재 시각
 * @returns {{weekKey: string, weekStartIso: string, weekEndIso: string}} 이번 주 범위
 */
function getCurrentKoreanWeekWindow(nowDate) {
  const sourceDate = nowDate instanceof Date ? nowDate : new Date()
  const currentDateText = dateutil.formatDate(sourceDate, dateutil.FORMATS.DATE)
  const currentUtcDate = new Date(currentDateText + 'T00:00:00.000Z')
  const daysSinceMonday = (currentUtcDate.getUTCDay() + 6) % 7
  const weekStartDate = new Date(currentUtcDate)

  weekStartDate.setUTCDate(currentUtcDate.getUTCDate() - daysSinceMonday)
  const weekKey = dateutil.formatDate(weekStartDate, dateutil.FORMATS.DATE)

  return {
    weekKey: weekKey,
    weekStartIso: dateutil.startOfDay(weekKey).toISOString(),
    weekEndIso: sourceDate.toISOString(),
  }
}

/**
 * 주간 독서 리마인더 대상 사용자 설정을 조회합니다.
 *
 * @returns {Array<any>} 대상 user_settings 목록
 */
function findWeeklyReadingNudgeSettings() {
  return $app.findRecordsByFilter(
    'user_settings',
    'push_enabled = true && weekly_reading_nudge_enabled = true',
    '-updated',
    500,
    0
  )
}

/**
 * 이번 주 독서 세션이 있는지 확인합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {string} weekStartIso 이번 주 시작 시각
 * @param {string} weekEndIso 조회 종료 시각
 * @returns {boolean} 세션 존재 여부
 */
function hasReadingSessionThisWeek(userId, weekStartIso, weekEndIso) {
  const normalizedUserId = String(userId || '').trim()

  if (!normalizedUserId) {
    return false
  }

  try {
    return !!$app.findFirstRecordByFilter(
      'reading_sessions',
      'user_id = {:userId} && ended_at >= {:weekStartIso} && ended_at <= {:weekEndIso} && duration_seconds > 0',
      {
        userId: normalizedUserId,
        weekStartIso: weekStartIso,
        weekEndIso: weekEndIso,
      }
    )
  } catch (_exception) {
    return false
  }
}

/**
 * 이번 주 주간 리마인더 발송 여부를 확인합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {string} weekKey 한국시간 주 시작 날짜
 * @returns {boolean} 발송 성공 로그 존재 여부
 */
function hasSentThisWeek(userId, weekKey) {
  const normalizedUserId = String(userId || '').trim()
  const dedupeKey = NOTIFICATION_KEY + ':' + normalizedUserId + ':' + String(weekKey || '').trim()

  if (!normalizedUserId || !weekKey) {
    return false
  }

  try {
    return !!$app.findFirstRecordByFilter('push_send_logs', 'dedupe_key = {:dedupeKey} && send_status = "sent"', {
      dedupeKey: dedupeKey,
    })
  } catch (_exception) {
    return false
  }
}

/**
 * 주간 독서 리마인더 문구를 만듭니다.
 *
 * @returns {string} 푸시 본문
 */
function createNudgeContents() {
  return '이번 주엔 아직 책을 펼친 기록이 없어요.\n1분만 읽어도 이번 주 독서가 시작돼요.'
}

/**
 * 사용자 한 명에게 주간 독서 리마인더를 보냅니다.
 *
 * @param {any} settingsRecord user_settings record
 * @param {{weekKey: string, weekStartIso: string, weekEndIso: string}} weekWindow 이번 주 범위
 * @returns {{sent: boolean, skipped: boolean, userId: string, reason?: string}} 처리 결과
 */
function sendNudgeForUser(settingsRecord, weekWindow) {
  const userId = String(settingsRecord.get('user_id') || '').trim()

  if (!userId) {
    return {
      sent: false,
      skipped: true,
      userId: '',
      reason: 'missing_user_id',
    }
  }

  if (hasSentThisWeek(userId, weekWindow.weekKey)) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      errorMessage: 'already_sent_this_week',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'already_sent_this_week',
    }
  }

  if (hasReadingSessionThisWeek(userId, weekWindow.weekStartIso, weekWindow.weekEndIso)) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      errorMessage: 'has_weekly_reading_session',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'has_weekly_reading_session',
    }
  }

  const payload = {
    externalIds: [userId],
    title: '북로그 리마인더',
    contents: createNudgeContents(),
  }
  const response = oneSignalService.sendPushNotification(payload)
  const dedupeKey = NOTIFICATION_KEY + ':' + userId + ':' + weekWindow.weekKey

  pushSendLogService.createLog({
    userId: userId,
    notificationKey: NOTIFICATION_KEY,
    channel: PUSH_CHANNEL,
    sendStatus: 'sent',
    dedupeKey: dedupeKey,
    title: payload.title,
    bodyText: payload.contents,
    providerMessageId: response && response.id ? String(response.id) : '',
    sentAt: pushSendLogService.getTodayDateText(),
    payloadJson: response,
  })

  $app.logger().info('jobs/weekly-reading-nudge:sent', 'userId', userId, 'weekKey', weekWindow.weekKey)

  return {
    sent: true,
    skipped: false,
    userId: userId,
  }
}

/**
 * 주간 독서 리마인더 대상자를 조회하고 푸시를 보냅니다.
 *
 * @returns {{ready: boolean, matchedUserCount: number, sentCount: number, skippedCount: number}} 작업 결과
 */
function run() {
  const weekWindow = getCurrentKoreanWeekWindow(new Date())
  const settingsRecords = findWeeklyReadingNudgeSettings()
  let sentCount = 0
  let skippedCount = 0

  $app
    .logger()
    .info(
      'jobs/weekly-reading-nudge:start',
      'matchedUserCount',
      settingsRecords.length,
      'weekKey',
      weekWindow.weekKey,
      'weekStartIso',
      weekWindow.weekStartIso,
      'weekEndIso',
      weekWindow.weekEndIso
    )

  for (let index = 0; index < settingsRecords.length; index += 1) {
    const settingsRecord = settingsRecords[index]

    try {
      const result = sendNudgeForUser(settingsRecord, weekWindow)

      if (result.sent) {
        sentCount += 1
      } else {
        skippedCount += 1
        $app
          .logger()
          .info(
            'jobs/weekly-reading-nudge:skip',
            'userId',
            String(result.userId || ''),
            'reason',
            String(result.reason || '')
          )
      }
    } catch (exception) {
      skippedCount += 1
      try {
        pushSendLogService.createLog({
          userId: String(settingsRecord.get('user_id') || '').trim(),
          notificationKey: NOTIFICATION_KEY,
          channel: PUSH_CHANNEL,
          sendStatus: 'failed',
          dedupeKey: '',
          errorMessage: String(exception && exception.message ? exception.message : exception),
          sentAt: pushSendLogService.getTodayDateText(),
        })
      } catch (logException) {
        $app
          .logger()
          .error(
            'jobs/weekly-reading-nudge:log-failed',
            'userId',
            String(settingsRecord.get('user_id') || '').trim(),
            'error',
            String(logException && logException.message ? logException.message : logException)
          )
      }
      $app
        .logger()
        .error(
          'jobs/weekly-reading-nudge:user-failed',
          'userId',
          String(settingsRecord.get('user_id') || '').trim(),
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  }

  $app
    .logger()
    .info(
      'jobs/weekly-reading-nudge:done',
      'matchedUserCount',
      settingsRecords.length,
      'sentCount',
      sentCount,
      'skippedCount',
      skippedCount
    )

  return {
    ready: true,
    matchedUserCount: settingsRecords.length,
    sentCount: sentCount,
    skippedCount: skippedCount,
  }
}

module.exports = {
  run,
}
