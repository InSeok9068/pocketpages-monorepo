const { dateutil } = require('@pocketpages/utils')

const FALLBACK_STATES = Object.freeze([
  { value: 'wait', label: '대기', iconClass: 'i-lucide-clock-3', badgeClass: 'bg-slate-100 text-slate-700' },
  { value: 'progress', label: '진행', iconClass: 'i-lucide-loader-circle', badgeClass: 'bg-blue-50 text-blue-700' },
  { value: 'review', label: '검토', iconClass: 'i-lucide-search-check', badgeClass: 'bg-violet-50 text-violet-700' },
  { value: 'hold', label: '보류', iconClass: 'i-lucide-pause-circle', badgeClass: 'bg-amber-50 text-amber-700' },
  { value: 'done', label: '완료', iconClass: 'i-lucide-circle-check', badgeClass: 'bg-emerald-50 text-emerald-700' },
  { value: 'cancel', label: '취소', iconClass: 'i-lucide-circle-x', badgeClass: 'bg-rose-50 text-rose-700' },
])

/**
 * 담당자 레코드를 선택 옵션으로 변환한다.
 * @param {types.PocketBaseRecord[]} records 담당자 레코드
 * @returns {types.DeveloperOption[]}
 */
function toDeveloperOptions(records) {
  const options = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]

    options.push({
      id: String(record.get('id') || ''),
      name: String(record.get('name') || ''),
    })
  }

  return options
}

/**
 * 코드 레코드로 업무 상태 목록을 만든다.
 * @param {types.PocketBaseRecord[]} records 코드 레코드
 * @returns {types.WorkStateOption[]}
 */
function toStateOptions(records) {
  const options = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const value = String(record.get('value') || '')

    if (!value || record.get('del')) continue

    const fallback = findStateOption(FALLBACK_STATES, value)
    options.push({
      value,
      label: String(record.get('desc') || value),
      iconClass: normalizeIconClass(String(record.get('class') || ''), fallback.iconClass),
      badgeClass: fallback.badgeClass,
    })
  }

  return options.length ? options : FALLBACK_STATES.slice()
}

/**
 * 업무 레코드를 화면 카드 데이터로 변환한다.
 * @param {types.PocketBaseRecord} record 업무 레코드
 * @param {Record<string, types.DeveloperOption>} developerMap 담당자 맵
 * @param {types.WorkStateOption[]} stateOptions 상태 목록
 * @param {number} urgentDays 임박 기준 일수
 * @returns {types.WorkCard}
 */
function toWorkCard(record, developerMap, stateOptions, urgentDays) {
  const state = String(record.get('state') || 'wait')
  const stateOption = findStateOption(stateOptions, state)
  const developerId = String(record.get('developer') || '')
  const developer = developerMap[developerId] || null
  const dueDate = String(record.get('dueDate') || '')
  const created = String(record.get('created') || '')
  const dueLimit = dateutil.endOfDay(dateutil.addDays(new Date(), Math.max(0, Number(urgentDays || 0))))

  return {
    id: String(record.get('id') || ''),
    title: String(record.get('title') || ''),
    content: String(record.get('content') || ''),
    done: !!record.get('done'),
    doneDate: String(record.get('doneDate') || ''),
    dueDate,
    dueDateLabel: dueDate ? dateutil.formatDate(dueDate, dateutil.FORMATS.DATE) : '',
    createdLabel: created ? dateutil.formatDate(created, dateutil.FORMATS.DATE) : '',
    state,
    stateLabel: stateOption.label,
    stateIconClass: stateOption.iconClass,
    stateBadgeClass: stateOption.badgeClass,
    developerId,
    developerName: developer ? developer.name : '미배정',
    sort: Number(record.get('sort') || 0),
    redmine: String(record.get('redmine') || ''),
    joplin: String(record.get('joplin') || ''),
    file: String(record.get('file') || ''),
    originalFileName: String(record.get('originalFileName') || ''),
    isUrgent: !!dueDate && !record.get('done') && dateutil.endOfDay(dueDate).getTime() <= dueLimit.getTime(),
  }
}

/**
 * 담당자 ID 맵을 만든다.
 * @param {types.DeveloperOption[]} developers 담당자 목록
 * @returns {Record<string, types.DeveloperOption>}
 */
function getDeveloperMap(developers) {
  const map = {}

  for (let index = 0; index < developers.length; index += 1) {
    map[developers[index].id] = developers[index]
  }

  return map
}

/**
 * 설정 JSON에서 임박 기준 일수를 읽는다.
 * @param {types.PocketBaseRecord|null} setting 설정 레코드
 * @returns {number}
 */
function getUrgentDays(setting) {
  if (!setting) return 3

  /** @type {{daysBefore?: number|string}} */
  const data = /** @type {{daysBefore?: number|string}} */ (setting.get('data') || {})
  const days = Number(data.daysBefore)

  return isNaN(days) ? 3 : Math.max(0, days)
}

function findStateOption(options, value) {
  for (let index = 0; index < options.length; index += 1) {
    if (options[index].value === value) return options[index]
  }

  return {
    value: value || 'wait',
    label: value || '대기',
    iconClass: 'i-lucide-circle',
    badgeClass: 'bg-slate-100 text-slate-700',
  }
}

function normalizeIconClass(value, fallback) {
  if (!value) return fallback
  if (value.indexOf('i-lucide-') === 0) return value

  return fallback
}

module.exports = {
  FALLBACK_STATES,
  getDeveloperMap,
  getUrgentDays,
  toDeveloperOptions,
  toStateOptions,
  toWorkCard,
}
