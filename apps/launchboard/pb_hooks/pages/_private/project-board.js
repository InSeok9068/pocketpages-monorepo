const { dateutil } = require('@pocketpages/utils')

const PROJECT_STATUS_COLUMNS = [
  { value: 'idea', label: '아이디어', tone: 'bg-[#fff7e6] text-[#8a5b00]', icon: 'i-lucide-lightbulb', iconTone: 'bg-[#fff0c2] text-[#f59f00]', surface: 'bg-[#fffaf0]' },
  { value: 'building', label: '작업중', tone: 'bg-[#eaf3ff] text-[#1b64da]', icon: 'i-lucide-hammer', iconTone: 'bg-[#eaf3ff] text-[#3182f6]', surface: 'bg-[#f2f7ff]' },
  { value: 'launched', label: '출시', tone: 'bg-[#e9f9ee] text-[#208a3f]', icon: 'i-lucide-rocket', iconTone: 'bg-[#e9f9ee] text-[#2fbe5f]', surface: 'bg-[#f1fbf4]' },
  { value: 'paused', label: '보류', tone: 'bg-[#f3efff] text-[#6f4bc4]', icon: 'i-lucide-pause', iconTone: 'bg-[#f3efff] text-[#8b5cf6]', surface: 'bg-[#f8f5ff]' },
  { value: 'discarded', label: '폐기', tone: 'bg-[#fff0f0] text-[#e03131]', icon: 'i-lucide-trash-2', iconTone: 'bg-[#fff0f0] text-[#ff6b6b]', surface: 'bg-[#fff5f5]' },
]

const PROJECT_STATUS_VALUES = PROJECT_STATUS_COLUMNS.map((column) => column.value)
const PROJECT_PRIORITY_VALUES = ['low', 'normal', 'high']

const priorityLabels = {
  low: '낮음',
  normal: '보통',
  high: '높음',
}

const priorityTones = {
  low: 'bg-[#eef2f6] text-[#6b7684]',
  normal: 'bg-[#eaf3ff] text-[#1b64da]',
  high: 'bg-[#fff0f0] text-[#e03131]',
}

/**
 * 프로젝트 날짜를 화면 표시용으로 바꾼다.
 * @param {unknown} value 날짜 값
 * @returns {string}
 */
function formatProjectDate(value) {
  const raw = String(value || '').trim()

  if (!raw) return ''

  return dateutil.formatDate(raw, dateutil.FORMATS.DATE)
}

/**
 * URL에서 origin을 추출한다.
 * @param {unknown} value URL 값
 * @returns {string}
 */
function getUrlOrigin(value) {
  const raw = String(value || '').trim()

  if (!raw) return ''

  const normalized = raw.indexOf('://') === -1 ? 'https://' + raw : raw
  const match = normalized.match(/^(https?:\/\/[^/?#]+)/i)

  if (!match) return ''

  return match[1].replace(/\/+$/, '')
}

/**
 * favicon 후보 URL을 만든다.
 * @param {unknown} domainUrl 도메인 URL
 * @returns {string[]}
 */
function getFaviconUrls(domainUrl) {
  const origin = getUrlOrigin(domainUrl)

  if (!origin) return []

  return [origin + '/favicon.svg', origin + '/assets/favicon.svg', origin + '/favicon.png', origin + '/favicon.ico']
}

/**
 * 프로젝트 상태를 허용된 값으로 보정한다.
 * @param {unknown} value 상태 값
 * @returns {string}
 */
function normalizeProjectStatus(value) {
  const raw = String(value || 'idea').trim()

  return PROJECT_STATUS_VALUES.indexOf(raw) >= 0 ? raw : 'idea'
}

/**
 * 프로젝트 우선순위를 허용된 값으로 보정한다.
 * @param {unknown} value 우선순위 값
 * @returns {string}
 */
function normalizeProjectPriority(value) {
  const raw = String(value || 'normal').trim()

  return PROJECT_PRIORITY_VALUES.indexOf(raw) >= 0 ? raw : 'normal'
}

/**
 * 프로젝트 레코드를 카드 표시 데이터로 바꾼다.
 * @param {types.PocketBaseRecord} record 프로젝트 레코드
 * @returns {types.ProjectCard}
 */
function toProjectCard(record) {
  const slug = String(record.get('slug') || '').trim()
  const priority = normalizeProjectPriority(record.get('priority'))
  const domainUrl = String(record.get('domain_url') || '').trim()

  return {
    id: String(record.get('id') || ''),
    nameKo: String(record.get('name_ko') || '').trim(),
    nameEn: String(record.get('name_en') || '').trim(),
    slug,
    href: '/projects/' + encodeURIComponent(slug),
    tasksHref: '/projects/' + encodeURIComponent(slug) + '/tasks',
    status: normalizeProjectStatus(record.get('status')),
    domainUrl,
    faviconUrls: getFaviconUrls(domainUrl),
    repoUrl: String(record.get('repo_url') || '').trim(),
    description: String(record.get('description') || '').trim(),
    priority,
    priorityLabel: priorityLabels[priority] || priority,
    priorityTone: priorityTones[priority] || priorityTones.normal,
    showPriority: priority !== 'normal',
    isPinned: record.get('is_pinned') === true,
    startedAt: formatProjectDate(record.get('started_at')),
    launchedAt: formatProjectDate(record.get('launched_at')),
    discardedAt: formatProjectDate(record.get('discarded_at')),
    updatedAt: formatProjectDate(record.get('updated')),
  }
}

/**
 * 프로젝트 보드 데이터를 만든다.
 * @param {object} app PocketBase 앱
 * @param {string} userId 사용자 ID
 * @returns {types.ProjectBoardState}
 */
function getProjectBoardState(app, userId) {
  /** @type {Record<string, types.ProjectCard[]>} */
  const projectsByStatus = {}

  for (let index = 0; index < PROJECT_STATUS_COLUMNS.length; index += 1) {
    projectsByStatus[PROJECT_STATUS_COLUMNS[index].value] = []
  }

  const projects = app.findRecordsByFilter('projects', 'user = {:userId}', '-is_pinned,+sort_order,-updated', 200, 0, { userId })

  for (let index = 0; index < projects.length; index += 1) {
    const project = toProjectCard(projects[index])
    const bucket = projectsByStatus[project.status] || projectsByStatus.idea

    bucket.push(project)
  }

  return {
    statusColumns: PROJECT_STATUS_COLUMNS,
    projectsByStatus,
    projectCount: projects.length,
  }
}

module.exports = {
  PROJECT_PRIORITY_VALUES,
  PROJECT_STATUS_COLUMNS,
  PROJECT_STATUS_VALUES,
  getProjectBoardState,
  normalizeProjectPriority,
  normalizeProjectStatus,
}
