const oneSignalService = require('./onesignal-service')
const pushSendLogService = require('./push-send-log-service')

const NOTIFICATION_KEY = 'reading_reminder'
const PUSH_CHANNEL = 'push'

/**
 * 오늘 기준으로 지난 날짜 문자열을 만듭니다.
 *
 * @param {number} daysBeforeToday 오늘에서 뺄 일수
 * @returns {string} YYYY-MM-DD 날짜 문자열
 */
function getDateTextDaysAgo(daysBeforeToday) {
  const targetDate = new Date()

  targetDate.setUTCHours(0, 0, 0, 0)
  targetDate.setUTCDate(targetDate.getUTCDate() - daysBeforeToday)

  return targetDate.toISOString().slice(0, 10)
}

/**
 * 읽기 리마인더 대상 사용자 설정 목록을 조회합니다.
 *
 * @returns {Array<any>} 대상 user_settings 목록
 */
function findReadingReminderSettings() {
  return $app.findRecordsByFilter('user_settings', 'push_enabled = true && reading_reminder_cycle > 0', '-updated', 500, 0)
}

/**
 * 사용자 설정에서 비활성 일수 기준을 읽습니다.
 *
 * @param {any} settingsRecord user_settings record
 * @returns {number} 리마인더 기준 일수
 */
function getInactivityDays(settingsRecord) {
  const readingReminderCycleValue = settingsRecord.get('reading_reminder_cycle')
  const readingReminderCycle = Number(readingReminderCycleValue)

  if (!isNaN(readingReminderCycle) && readingReminderCycle >= 1) {
    return Math.floor(readingReminderCycle)
  }

  return 0
}

/**
 * 사용자에게 보낼 읽기 리마인더 책장을 찾습니다.
 *
 * @param {string} userId 사용자 ID
 * @param {number} inactivityDays 리마인더 기준 일수
 * @returns {any | null} 대상 책장 record
 */
function findReminderShelfRecord(userId, inactivityDays) {
  const cutoffDateText = getDateTextDaysAgo(inactivityDays)

  try {
    const shelfRecords = $app.findRecordsByFilter('book_shelves', 'user_id = {:userId} && status = "reading" && last_read_at != "" && last_read_at <= {:cutoffDate}', '-last_read_at,-updated', 10, 0, {
      userId: userId,
      cutoffDate: cutoffDateText,
    })

    if (!shelfRecords || shelfRecords.length === 0) {
      return null
    }

    return shelfRecords[0]
  } catch (exception) {
    $app
      .logger()
      .error(
        'jobs/reading-reminder:find-shelf-failed',
        'userId',
        String(userId || '').trim(),
        'cutoffDate',
        cutoffDateText,
        'error',
        String(exception && exception.message ? exception.message : exception)
      )
  }

  return null
}

/**
 * 책 제목을 짧게 정리합니다.
 *
 * @param {string} title 원본 책 제목
 * @returns {string} 정리된 책 제목
 */
function trimBookTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 책장 record에서 책 제목을 조회합니다.
 *
 * @param {any} shelfRecord book_shelves record
 * @returns {string} 책 제목
 */
function findShelfBookTitle(shelfRecord) {
  const bookId = String(shelfRecord && shelfRecord.get('book_id') ? shelfRecord.get('book_id') : '').trim()

  if (!bookId) {
    return '제목 없는 책'
  }

  try {
    const bookRecord = $app.findRecordById('books', bookId)
    const title = trimBookTitle(bookRecord && bookRecord.get('title') ? bookRecord.get('title') : '')

    return title || '제목 없는 책'
  } catch (exception) {
    $app.logger().warn('jobs/reading-reminder:find-book-failed', 'bookId', bookId, 'error', String(exception && exception.message ? exception.message : exception))
  }

  return '제목 없는 책'
}

/**
 * 마지막 읽은 날짜로부터 지난 일수를 계산합니다.
 *
 * @param {string} lastReadAt 마지막 읽은 날짜
 * @returns {number | null} 지난 일수
 */
function getDaysSinceLastRead(lastReadAt) {
  return pushSendLogService.getDaysBetween(lastReadAt, getDateTextDaysAgo(0))
}

/**
 * 읽기 리마인더 발송 시점이 되었는지 확인합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {string} lastReadAt 마지막 읽은 날짜
 * @param {number} reminderCycle 리마인더 주기 일수
 * @returns {boolean} 발송 필요 여부
 */
function isReadingReminderDue(userId, lastReadAt, reminderCycle) {
  const lastSentAt = pushSendLogService.getLastSentAt(userId, NOTIFICATION_KEY)
  const daysFromLastReadToLastSent = pushSendLogService.getDaysBetween(lastReadAt, lastSentAt)

  if (!lastSentAt) {
    return true
  }

  if (daysFromLastReadToLastSent === null || daysFromLastReadToLastSent < 0) {
    return true
  }

  return pushSendLogService.getDaysBetween(lastSentAt, pushSendLogService.getTodayDateText()) >= reminderCycle
}

/**
 * 읽기 리마인더 문구를 만듭니다.
 *
 * @param {string} bookTitle 책 제목
 * @param {number} inactiveDays 마지막 읽기 후 지난 일수
 * @returns {string} 푸시 본문
 */
function createReminderContents(bookTitle, inactiveDays) {
  const normalizedTitle = trimBookTitle(bookTitle) || '제목 없는 책'
  const dayText = String(inactiveDays) + '일'

  return `📚 "${normalizedTitle}"\n\n⏱ ${dayText}째 멈춰 있어요.\n\n📖 오늘 한 페이지라도 이어서 읽어볼까요?`
}

/**
 * 사용자 한 명에게 읽기 리마인더를 보냅니다.
 *
 * @param {any} settingsRecord user_settings record
 * @returns {{sent: boolean, skipped: boolean, userId: string, reason?: string}} 처리 결과
 */
function sendReminderForUser(settingsRecord) {
  const userId = String(settingsRecord.get('user_id') || '').trim()
  const inactivityDays = getInactivityDays(settingsRecord)

  if (!userId) {
    return {
      sent: false,
      skipped: true,
      userId: '',
      reason: 'missing_user_id',
    }
  }

  if (inactivityDays < 1) {
    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'reading_reminder_off',
    }
  }

  if (pushSendLogService.hasSentToday(userId, NOTIFICATION_KEY)) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      errorMessage: 'already_sent_today',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'already_sent_today',
    }
  }

  const shelfRecord = findReminderShelfRecord(userId, inactivityDays)

  if (!shelfRecord) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      errorMessage: 'missing_stale_reading_shelf',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'missing_stale_reading_shelf',
    }
  }

  const lastReadAt = String(shelfRecord.get('last_read_at') || '').trim()
  const inactiveDaysSinceLastRead = getDaysSinceLastRead(lastReadAt)

  if (inactiveDaysSinceLastRead === null || inactiveDaysSinceLastRead < inactivityDays) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      bookId: String(shelfRecord.get('book_id') || '').trim(),
      shelfId: String(shelfRecord.get('id') || '').trim(),
      errorMessage: 'invalid_last_read_at',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'invalid_last_read_at',
    }
  }

  if (!isReadingReminderDue(userId, lastReadAt, inactivityDays)) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      bookId: String(shelfRecord.get('book_id') || '').trim(),
      shelfId: String(shelfRecord.get('id') || '').trim(),
      errorMessage: 'cycle_not_due',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'cycle_not_due',
    }
  }

  const bookTitle = findShelfBookTitle(shelfRecord)
  const payload = {
    externalIds: [userId],
    title: '북로그 리마인더',
    contents: createReminderContents(bookTitle, inactiveDaysSinceLastRead),
  }
  const response = oneSignalService.sendPushNotification(payload)

  pushSendLogService.createLog({
    userId: userId,
    notificationKey: NOTIFICATION_KEY,
    channel: PUSH_CHANNEL,
    sendStatus: 'sent',
    dedupeKey: NOTIFICATION_KEY + ':' + userId + ':' + pushSendLogService.getTodayDateText(),
    bookId: String(shelfRecord.get('book_id') || '').trim(),
    shelfId: String(shelfRecord.get('id') || '').trim(),
    title: payload.title,
    bodyText: payload.contents,
    providerMessageId: response && response.id ? String(response.id) : '',
    sentAt: pushSendLogService.getTodayDateText(),
    payloadJson: response,
  })

  $app.logger().info('jobs/reading-reminder:sent', 'userId', userId, 'shelfId', String(shelfRecord.get('id') || '').trim(), 'bookTitle', bookTitle, 'inactiveDays', inactiveDaysSinceLastRead)

  return {
    sent: true,
    skipped: false,
    userId: userId,
  }
}

/**
 * 읽기 리마인더 대상자를 조회하고 푸시를 보냅니다.
 *
 * @returns {{ready: boolean, matchedUserCount: number, sentCount: number, skippedCount: number}} 작업 결과
 */
function run() {
  const settingsRecords = findReadingReminderSettings()
  let sentCount = 0
  let skippedCount = 0

  $app.logger().info('jobs/reading-reminder:start', 'matchedUserCount', settingsRecords.length)

  for (let index = 0; index < settingsRecords.length; index += 1) {
    const settingsRecord = settingsRecords[index]

    try {
      const result = sendReminderForUser(settingsRecord)

      if (result.sent) {
        sentCount += 1
      } else {
        skippedCount += 1
        $app.logger().info('jobs/reading-reminder:skip', 'userId', String(result.userId || ''), 'reason', String(result.reason || ''))
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
            'jobs/reading-reminder:log-failed',
            'userId',
            String(settingsRecord.get('user_id') || '').trim(),
            'error',
            String(logException && logException.message ? logException.message : logException)
          )
      }
      $app
        .logger()
        .error('jobs/reading-reminder:user-failed', 'userId', String(settingsRecord.get('user_id') || '').trim(), 'error', String(exception && exception.message ? exception.message : exception))
    }
  }

  $app.logger().info('jobs/reading-reminder:done', 'matchedUserCount', settingsRecords.length, 'sentCount', sentCount, 'skippedCount', skippedCount)

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
