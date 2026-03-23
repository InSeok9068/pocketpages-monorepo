const oneSignalService = require('./onesignal-service')

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
function findDailyReminderSettings() {
  return $app.findRecordsByFilter('user_settings', 'push_enabled = true && highlight_reminder_enabled = true && highlight_push_cycle = "daily"', '-updated', 500, 0)
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

  if (!userId) {
    return {
      sent: false,
      skipped: true,
      userId: '',
      reason: 'missing_user_id',
    }
  }

  const highlightRecord = findRandomHighlightRecord(userId)

  if (!highlightRecord) {
    return {
      sent: false,
      skipped: true,
      userId: userId,
      reason: 'missing_highlight',
    }
  }

  const quoteText = trimHighlightQuote(highlightRecord.get('quote_text'))
  const bookTitle = trimBookTitle(findHighlightBookTitle(highlightRecord))
  const contents = quoteText ? quoteText + '\n"' + bookTitle + '"' : '"' + bookTitle + '"'

  oneSignalService.sendPushNotification({
    externalIds: [userId],
    title: '북로그 리마인더',
    contents: contents,
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
  const settingsRecords = findDailyReminderSettings()
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
