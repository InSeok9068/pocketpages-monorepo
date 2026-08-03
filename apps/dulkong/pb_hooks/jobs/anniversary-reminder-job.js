const { createOneSignalClient } = require('@pocketpages/onesignal')
const { dateutil } = require('@pocketpages/utils')

const SUPPORTED_KINDS = ['relationship_start', 'birthday']

/**
 * 이름 마지막 글자의 한글 받침 여부를 확인합니다.
 * @param {string} name 이름
 * @returns {boolean} 받침 존재 여부
 */
function hasFinalConsonant(name) {
  const normalizedName = String(name || '')
  const lastCharacterCode = normalizedName.charCodeAt(normalizedName.length - 1)

  return lastCharacterCode >= 0xac00 && lastCharacterCode <= 0xd7a3 && (lastCharacterCode - 0xac00) % 28 !== 0
}

/**
 * 기념일이 오늘인지 확인합니다.
 * @param {string} eventDate 기념일 날짜
 * @param {string} todayDate 오늘 날짜
 * @returns {boolean} 월일 일치 여부
 */
function isDueToday(eventDate, todayDate) {
  return dateutil.formatDate(eventDate, 'MM-DD') === String(todayDate || '').slice(5)
}

/**
 * 만남 기념일 메시지를 만듭니다.
 * @param {string} eventDate 처음 만난 날
 * @param {string} todayDate 오늘 날짜
 * @returns {{title: string, contents: string}} 푸시 메시지
 */
function createRelationshipMessage(eventDate, todayDate) {
  const anniversaryYears = Number(String(todayDate || '').slice(0, 4)) - Number(dateutil.formatDate(eventDate, 'YYYY'))

  return {
    title: '우리의 기념일 ❤️',
    contents:
      anniversaryYears > 0
        ? '우리 벌써 함께한 지 ' + String(anniversaryYears) + '년이야. 오늘도 서로에게 다정한 하루 보내자.'
        : '오늘은 우리의 첫날이야. 앞으로도 서로에게 다정한 하루를 쌓아가자.',
  }
}

/**
 * 생일 메시지를 만듭니다.
 * @param {string} birthdayPersonName 생일 주인공 이름
 * @returns {{title: string, contents: string}} 푸시 메시지
 */
function createBirthdayMessage(birthdayPersonName) {
  const name = String(birthdayPersonName || '').trim() || '소중한 사람'
  const subjectName = name + (hasFinalConsonant(name) ? '이가' : '가')

  return {
    title: name + '의 생일이야 🎂',
    contents: '오늘은 ' + subjectName + ' 태어난 날이야. 누구보다 가까이에서 따뜻하게 축하해줘.',
  }
}

/**
 * 생일 주인공에게 보낼 메시지를 만듭니다.
 * @param {string} birthdayPersonName 생일 주인공 이름
 * @returns {{title: string, contents: string}} 푸시 메시지
 */
function createBirthdayCelebrationMessage(birthdayPersonName) {
  const name = String(birthdayPersonName || '').trim() || '오늘의 주인공'

  return {
    title: name + (hasFinalConsonant(name) ? '아' : '야') + ', 생일 축하해 🎂',
    contents: '오늘은 네가 태어난 특별한 날이야. 우리 오늘 더 다정하게 보내자.',
  }
}

/**
 * 같은 기념일의 중복 발송을 막는 UUID를 만듭니다.
 * @param {string} apiKey OneSignal API 키
 * @param {string} anniversaryId 기념일 ID
 * @param {string} todayDate 발송 날짜
 * @param {string} recipientKind 수신자 구분
 * @returns {string} RFC 9562 UUID
 */
function createIdempotencyKey(apiKey, anniversaryId, todayDate, recipientKind) {
  const hash = $security
    .sha256(apiKey + ':' + anniversaryId + ':' + todayDate + ':' + recipientKind)
    .slice(0, 32)
    .split('')

  hash[12] = '8'
  hash[16] = (8 + (parseInt(hash[16], 16) % 4)).toString(16)

  return (
    hash.slice(0, 8).join('')
    + '-'
    + hash.slice(8, 12).join('')
    + '-'
    + hash.slice(12, 16).join('')
    + '-'
    + hash.slice(16, 20).join('')
    + '-'
    + hash.slice(20, 32).join('')
  )
}

/**
 * 한 수신자 그룹에 푸시를 보냅니다.
 * @param {import('@pocketpages/onesignal').OneSignalClient} oneSignal OneSignal 클라이언트
 * @param {string} apiKey OneSignal API 키
 * @param {string} anniversaryId 기념일 ID
 * @param {string} todayDate 발송 날짜
 * @param {{key: string, recipientIds: string[], message: {title: string, contents: string}}} delivery 발송 정보
 * @returns {import('@pocketpages/onesignal').OneSignalResult} 발송 결과
 */
function sendPush(oneSignal, apiKey, anniversaryId, todayDate, delivery) {
  const pushResult = oneSignal.createNotification({
    include_aliases: {
      external_id: delivery.recipientIds,
    },
    target_channel: 'push',
    headings: {
      en: delivery.message.title,
    },
    contents: {
      en: delivery.message.contents,
    },
    url: '/us',
    isAnyWeb: true,
    idempotency_key: createIdempotencyKey(apiKey, anniversaryId, todayDate, delivery.key),
  })

  if (!pushResult.ok) {
    throw new Error(
      'OneSignal 푸시 발송에 실패했습니다. status='
        + String(pushResult.statusCode)
        + ' error='
        + String(pushResult.errorMessage || '')
    )
  }

  return pushResult
}

/**
 * 기존 생일 데이터의 주인공을 찾습니다.
 * @param {core.Record} anniversaryRecord 기념일 레코드
 * @param {core.Record[]} users 사용자 목록
 * @returns {core.Record | null} 생일 주인공
 */
function findBirthdayPerson(anniversaryRecord, users) {
  const relatedUserId = String(anniversaryRecord.get('relatedUser') || '')

  for (let index = 0; index < users.length; index += 1) {
    if (String(users[index].get('id') || '') === relatedUserId) return users[index]
  }

  const title = String(anniversaryRecord.get('title') || '')

  for (let index = 0; index < users.length; index += 1) {
    const name = String(users[index].get('name') || '').trim()

    if (name && title.indexOf(name) >= 0) return users[index]
  }

  return null
}

/**
 * 대상 사용자 ID 목록을 만듭니다.
 * @param {string} kind 기념일 종류
 * @param {core.Record | null} birthdayPerson 생일 주인공
 * @param {core.Record[]} users 사용자 목록
 * @returns {string[]} 푸시 대상 사용자 ID
 */
function getRecipientIds(kind, birthdayPerson, users) {
  const birthdayPersonId = birthdayPerson ? String(birthdayPerson.get('id') || '') : ''
  const recipientIds = []

  for (let index = 0; index < users.length; index += 1) {
    const user = users[index]
    const userId = String(user.get('id') || '')

    if (!userId || !user.get('pushEnabled')) continue
    if (kind === 'birthday' && userId === birthdayPersonId) continue
    recipientIds.push(userId)
  }

  return recipientIds
}

/**
 * 기념일 알림 하나를 발송합니다.
 * @param {core.Record} anniversaryRecord 기념일 레코드
 * @param {core.Record[]} users 사용자 목록
 * @param {string} todayDate 오늘 날짜
 * @returns {{sent: boolean, reason?: string, recipientCount: number}} 발송 결과
 */
function sendAnniversaryReminder(anniversaryRecord, users, todayDate) {
  const kind = String(anniversaryRecord.get('kind') || '')
  const birthdayPerson = kind === 'birthday' ? findBirthdayPerson(anniversaryRecord, users) : null

  if (kind === 'birthday' && !birthdayPerson) {
    return { sent: false, reason: 'missing_related_user', recipientCount: 0 }
  }

  const eventDate = String(anniversaryRecord.get('eventDate') || '')
  const birthdayPersonName = birthdayPerson ? String(birthdayPerson.get('name') || '') : ''
  const deliveries = []

  if (kind === 'relationship_start') {
    deliveries.push({
      key: 'couple',
      recipientIds: getRecipientIds(kind, null, users),
      message: createRelationshipMessage(eventDate, todayDate),
    })
  } else {
    deliveries.push({
      key: 'partner',
      recipientIds: getRecipientIds(kind, birthdayPerson, users),
      message: createBirthdayMessage(birthdayPersonName),
    })

    if (birthdayPerson.get('pushEnabled')) {
      deliveries.push({
        key: 'birthday_person',
        recipientIds: [String(birthdayPerson.get('id') || '')],
        message: createBirthdayCelebrationMessage(birthdayPersonName),
      })
    }
  }

  const activeDeliveries = deliveries.filter(function (delivery) {
    return delivery.recipientIds.length > 0 && delivery.recipientIds[0]
  })

  if (!activeDeliveries.length) {
    return { sent: false, reason: 'missing_push_recipient', recipientCount: 0 }
  }

  const oneSignalAppId = String($os.getenv('DULKONG_ONESIGNAL_APPID') || '').trim()
  const oneSignalApiKey = String($os.getenv('DULKONG_ONESIGNAL_APIKEY') || '').trim()

  if (!oneSignalAppId || !oneSignalApiKey) {
    throw new Error('둘콩 OneSignal 환경 설정이 필요합니다.')
  }

  const oneSignal = createOneSignalClient({
    appId: oneSignalAppId,
    apiKey: oneSignalApiKey,
    timeoutSeconds: 5,
  })
  const anniversaryId = String(anniversaryRecord.get('id') || '')
  const notificationIds = []
  let recipientCount = 0

  for (let index = 0; index < activeDeliveries.length; index += 1) {
    const delivery = activeDeliveries[index]
    const pushResult = sendPush(oneSignal, oneSignalApiKey, anniversaryId, todayDate, delivery)

    recipientCount += delivery.recipientIds.length
    notificationIds.push(pushResult.notificationId)
  }

  $app
    .logger()
    .info(
      'jobs/anniversary-reminder:sent',
      'anniversaryId',
      anniversaryId,
      'kind',
      kind,
      'recipientCount',
      recipientCount,
      'notificationIds',
      notificationIds.join(',')
    )

  return { sent: true, recipientCount: recipientCount }
}

/**
 * 오늘의 기념일 알림을 발송합니다.
 * @returns {{matchedCount: number, sentCount: number, skippedCount: number}} 작업 결과
 */
function run() {
  const todayDate = dateutil.formatDate(new Date(), dateutil.FORMATS.DATE)
  const users = $app.findRecordsByFilter('users', '', '+created', 100, 0)
  const anniversaryRecords = $app.findRecordsByFilter(
    'anniversaries',
    'kind = "relationship_start" || kind = "birthday"',
    '+eventDate',
    100,
    0
  )
  let matchedCount = 0
  let sentCount = 0
  let skippedCount = 0

  $app.logger().info('jobs/anniversary-reminder:start', 'todayDate', todayDate)

  for (let index = 0; index < anniversaryRecords.length; index += 1) {
    const anniversaryRecord = anniversaryRecords[index]
    const kind = String(anniversaryRecord.get('kind') || '')
    const eventDate = String(anniversaryRecord.get('eventDate') || '')

    if (SUPPORTED_KINDS.indexOf(kind) < 0 || !isDueToday(eventDate, todayDate)) continue
    matchedCount += 1

    try {
      const result = sendAnniversaryReminder(anniversaryRecord, users, todayDate)

      if (result.sent) {
        sentCount += 1
      } else {
        skippedCount += 1
        $app
          .logger()
          .warn(
            'jobs/anniversary-reminder:skip',
            'anniversaryId',
            String(anniversaryRecord.get('id') || ''),
            'reason',
            String(result.reason || '')
          )
      }
    } catch (exception) {
      skippedCount += 1
      $app
        .logger()
        .error(
          'jobs/anniversary-reminder:send-failed',
          'anniversaryId',
          String(anniversaryRecord.get('id') || ''),
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  }

  $app
    .logger()
    .info(
      'jobs/anniversary-reminder:done',
      'matchedCount',
      matchedCount,
      'sentCount',
      sentCount,
      'skippedCount',
      skippedCount
    )

  return { matchedCount: matchedCount, sentCount: sentCount, skippedCount: skippedCount }
}

module.exports = {
  createBirthdayCelebrationMessage,
  createBirthdayMessage,
  createRelationshipMessage,
  findBirthdayPerson,
  getRecipientIds,
  isDueToday,
  run,
}
