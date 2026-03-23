const oneSignalService = require('./onesignal-service')
const pushSendLogService = require('./push-send-log-service')

const NOTIFICATION_KEY = 'highlight_reminder'
const PUSH_CHANNEL = 'push'

/**
 * 하이라이트 문구를 알림 본문용으로 정리합니다.
 *
 * @param {string} quoteText 원본 하이라이트 문구
 * @returns {string} 정리된 하이라이트 문구
 */
function trimHighlightQuote(quoteText) {
  return String(quoteText || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 푸시 본문에 넣을 책 제목을 짧게 정리합니다.
 *
 * @param {string} title 원본 책 제목
 * @returns {string} 잘린 책 제목
 */
function trimBookTitle(title) {
  const normalized = String(title || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return '제목 없음'
  }

  if (normalized.length <= 15) {
    return normalized
  }

  return normalized.slice(0, 15) + '...'
}

/**
 * 하이라이트에 연결된 책 제목을 조회합니다.
 *
 * @param {any} highlightRecord 하이라이트 record
 * @returns {string} 책 제목
 */
function findHighlightBookTitle(highlightRecord) {
  const bookId = String(highlightRecord && highlightRecord.get('book_id') ? highlightRecord.get('book_id') : '').trim()

  if (!bookId) {
    return '제목 없음'
  }

  try {
    const bookRecord = $app.findRecordById('books', bookId)
    return String(bookRecord && bookRecord.get('title') ? bookRecord.get('title') : '제목 없음').trim() || '제목 없음'
  } catch (exception) {
    $app.logger().warn('jobs/highlight-reminder:find-book-failed', 'bookId', bookId, 'error', String(exception && exception.message ? exception.message : exception))
    return '제목 없음'
  }
}

/**
 * 알림 대상 사용자 설정 목록을 조회합니다.
 *
 * @returns {Array<any>} 알림 대상 user_settings 목록
 */
function findHighlightReminderSettings() {
  return $app.findRecordsByFilter('user_settings', 'push_enabled = true && highlight_push_cycle > 0', '-updated', 500, 0)
}

/**
 * 하이라이트 리마인더 발송 시점이 되었는지 확인합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {number} highlightPushCycle 하이라이트 주기 일수
 * @returns {boolean} 발송 필요 여부
 */
function isHighlightReminderDue(userId, highlightPushCycle) {
  const lastSentAt = pushSendLogService.getLastSentAt(userId, NOTIFICATION_KEY)
  const todayDateText = pushSendLogService.getTodayDateText()

  if (!lastSentAt) {
    return true
  }

  const daysSinceLastSent = pushSendLogService.getDaysBetween(lastSentAt, todayDateText)
  const requiredIntervalDays = highlightPushCycle

  if (daysSinceLastSent === null) {
    return true
  }

  return daysSinceLastSent >= requiredIntervalDays
}

/**
 * 사용자별 하이라이트 하나를 랜덤으로 조회합니다.
 *
 * @param {string} userId 조회할 사용자 ID
 * @returns {any | null} 랜덤 하이라이트 record
 */
function findRandomHighlightRecord(userId) {
  try {
    const totalCount = $app.countRecords(
      'book_highlights',
      $dbx.exp('user_id = {:userId}', {
        userId: userId,
      })
    )

    if (totalCount < 1) {
      return null
    }

    const randomOffset = Math.floor(Math.random() * totalCount)
    const highlightRecords = $app.findRecordsByFilter('book_highlights', 'user_id = {:userId}', '-updated', 1, randomOffset, {
      userId: userId,
    })

    if (highlightRecords.length > 0) {
      return highlightRecords[0]
    }
  } catch (exception) {
    $app.logger().error('jobs/highlight-reminder:find-highlight-failed', 'userId', String(userId || '').trim(), 'error', String(exception && exception.message ? exception.message : exception))
  }

  return null
}

/**
 * 하이라이트 리마인더 대상을 한 명씩 처리합니다.
 *
 * @param {any} settingsRecord user_settings record
 * @returns {{sent: boolean, skipped: boolean, userId: string, reason?: string}} 처리 결과
 */
function sendReminderForUser(settingsRecord) {
  const userId = String(settingsRecord.get('user_id') || '').trim()
  const highlightPushCycleValue = settingsRecord.get('highlight_push_cycle')
  const highlightPushCycle = Number(highlightPushCycleValue)

  if (!userId) {
    return {
      sent: false,
      skipped: true,
      userId: '',
      reason: 'missing_user_id',
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

  if (isNaN(highlightPushCycle) || highlightPushCycle < 1) {
    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'highlight_reminder_off',
    }
  }

  if (!isHighlightReminderDue(userId, highlightPushCycle)) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
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

  const highlightRecord = findRandomHighlightRecord(userId)

  if (!highlightRecord) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      errorMessage: 'missing_highlight',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'missing_highlight',
    }
  }

  const quoteText = trimHighlightQuote(highlightRecord.get('quote_text'))
  const bookTitle = trimBookTitle(findHighlightBookTitle(highlightRecord))

  if (!quoteText) {
    pushSendLogService.createLog({
      userId: userId,
      notificationKey: NOTIFICATION_KEY,
      channel: PUSH_CHANNEL,
      sendStatus: 'skipped',
      dedupeKey: '',
      bookId: String(highlightRecord.get('book_id') || '').trim(),
      highlightId: String(highlightRecord.get('id') || '').trim(),
      errorMessage: 'missing_quote_text',
      sentAt: pushSendLogService.getTodayDateText(),
    })

    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'missing_quote_text',
    }
  }

  const contents = quoteText ? '"' + quoteText + '"\n"' + bookTitle + '"\n이 문장이 유난히 마음에 남았던 이유를 잠시 떠올려보세요. 🍃' : ''
  const payload = {
    externalIds: [userId],
    title: '북로그 리마인더',
    contents: contents,
  }
  const response = oneSignalService.sendPushNotification(payload)

  pushSendLogService.createLog({
    userId: userId,
    notificationKey: NOTIFICATION_KEY,
    channel: PUSH_CHANNEL,
    sendStatus: 'sent',
    dedupeKey: NOTIFICATION_KEY + ':' + userId + ':' + pushSendLogService.getTodayDateText(),
    bookId: String(highlightRecord.get('book_id') || '').trim(),
    highlightId: String(highlightRecord.get('id') || '').trim(),
    title: payload.title,
    bodyText: payload.contents,
    providerMessageId: response && response.id ? String(response.id) : '',
    sentAt: pushSendLogService.getTodayDateText(),
    payloadJson: response,
  })

  $app.logger().info('jobs/highlight-reminder:sent', 'userId', userId, 'highlightId', String(highlightRecord.get('id') || '').trim(), 'bookTitle', bookTitle)

  return {
    sent: true,
    skipped: false,
    userId: userId,
  }
}

/**
 * 매일 하이라이트 리마인더 대상자를 조회하고 푸시를 보냅니다.
 *
 * @returns {{ready: boolean, matchedUserCount: number, sentCount: number, skippedCount: number}} 작업 결과
 */
function run() {
  const settingsRecords = findHighlightReminderSettings()
  let sentCount = 0
  let skippedCount = 0

  $app.logger().info('jobs/highlight-reminder:start', 'matchedUserCount', settingsRecords.length)

  for (let index = 0; index < settingsRecords.length; index += 1) {
    const settingsRecord = settingsRecords[index]

    try {
      const result = sendReminderForUser(settingsRecord)

      if (result.sent) {
        sentCount += 1
      } else {
        skippedCount += 1
        $app.logger().info('jobs/highlight-reminder:skip', 'userId', String(result.userId || ''), 'reason', String(result.reason || ''))
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
            'jobs/highlight-reminder:log-failed',
            'userId',
            String(settingsRecord.get('user_id') || '').trim(),
            'error',
            String(logException && logException.message ? logException.message : logException)
          )
      }
      $app
        .logger()
        .error('jobs/highlight-reminder:user-failed', 'userId', String(settingsRecord.get('user_id') || '').trim(), 'error', String(exception && exception.message ? exception.message : exception))
    }
  }

  $app.logger().info('jobs/highlight-reminder:done', 'matchedUserCount', settingsRecords.length, 'sentCount', sentCount, 'skippedCount', skippedCount)

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
