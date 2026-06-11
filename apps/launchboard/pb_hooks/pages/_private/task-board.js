const { dateutil } = require('@pocketpages/utils')

const TASK_STATUS_COLUMNS = [
  { value: 'todo', label: '할 일', icon: 'i-lucide-circle', iconTone: 'bg-[#eef2f6] text-[#8b95a1]', surface: 'bg-white' },
  { value: 'doing', label: '진행중', icon: 'i-lucide-loader-circle', iconTone: 'bg-[#eaf3ff] text-[#3182f6]', surface: 'bg-[#f2f7ff]' },
  { value: 'done', label: '완료', icon: 'i-lucide-check-circle-2', iconTone: 'bg-[#e9f9ee] text-[#2fbe5f]', surface: 'bg-[#f1fbf4]' },
  { value: 'paused', label: '보류', icon: 'i-lucide-pause', iconTone: 'bg-[#f3efff] text-[#8b5cf6]', surface: 'bg-[#f8f5ff]' },
  { value: 'canceled', label: '취소', icon: 'i-lucide-x-circle', iconTone: 'bg-[#fff0f0] text-[#ff6b6b]', surface: 'bg-[#fff5f5]' },
]

const TASK_STATUS_VALUES = TASK_STATUS_COLUMNS.map((column) => column.value)
const TASK_PRIORITY_VALUES = ['low', 'normal', 'high']
const TASK_TYPE_VALUES = ['feature', 'bug', 'design', 'content', 'infra', 'research', 'etc']

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

const typeLabels = {
  feature: '기능',
  bug: '버그',
  design: '디자인',
  content: '콘텐츠',
  infra: '인프라',
  research: '리서치',
  etc: '기타',
}

const urgencyTones = {
  overdue: 'bg-[#fff0f0] text-[#e03131]',
  today: 'bg-[#fff4d6] text-[#8a5b00]',
  upcoming: 'bg-[#eaf3ff] text-[#1b64da]',
}

const signalTones = {
  high: 'bg-[#fff0f0] text-[#e03131]',
  blocked: 'bg-[#f3efff] text-[#6f4bc4]',
}

/**
 * 프로젝트 레코드를 업무 표시 보조 데이터로 바꾼다.
 * @param {types.PocketBaseRecord} record 프로젝트 레코드
 * @returns {types.ProjectTaskProject}
 */
function toTaskProject(record) {
  const slug = String(record.get('slug') || '').trim()

  return {
    id: String(record.get('id') || ''),
    nameKo: String(record.get('name_ko') || '').trim(),
    slug,
    tasksHref: slug ? '/projects/' + encodeURIComponent(slug) + '/tasks' : '',
  }
}

/**
 * 사용자 프로젝트 맵을 만든다.
 * @param {object} app PocketBase 앱
 * @param {string} userId 사용자 ID
 * @returns {Record<string, types.ProjectTaskProject>}
 */
function getTaskProjectMap(app, userId) {
  /** @type {Record<string, types.ProjectTaskProject>} */
  const projectMap = {}
  const projects = app.findRecordsByFilter('projects', 'user = {:userId}', '-is_pinned,+sort_order,-updated', 300, 0, { userId })

  for (let index = 0; index < projects.length; index += 1) {
    const project = toTaskProject(projects[index])

    if (project.id) projectMap[project.id] = project
  }

  return projectMap
}

/**
 * 업무 상태를 허용된 값으로 보정한다.
 * @param {unknown} value 상태 값
 * @returns {string}
 */
function normalizeTaskStatus(value) {
  const raw = String(value || 'todo').trim()

  return TASK_STATUS_VALUES.indexOf(raw) >= 0 ? raw : 'todo'
}

/**
 * 업무 우선순위를 허용된 값으로 보정한다.
 * @param {unknown} value 우선순위 값
 * @returns {string}
 */
function normalizeTaskPriority(value) {
  const raw = String(value || 'normal').trim()

  return TASK_PRIORITY_VALUES.indexOf(raw) >= 0 ? raw : 'normal'
}

/**
 * 업무 타입을 허용된 값으로 보정한다.
 * @param {unknown} value 타입 값
 * @returns {string}
 */
function normalizeTaskType(value) {
  const raw = String(value || 'etc').trim()

  return TASK_TYPE_VALUES.indexOf(raw) >= 0 ? raw : 'etc'
}

/**
 * 마감 상태 칩을 만든다.
 * @param {string} status 업무 상태
 * @param {string} dueAt 마감일 원본
 * @returns {types.ProjectTaskBadge|null}
 */
function getDueBadge(status, dueAt) {
  if (!dueAt || status === 'done' || status === 'canceled') return null

  const diff = dateutil.diffDays(dueAt, new Date())

  if (diff < 0) {
    return {
      label: '지남',
      tone: urgencyTones.overdue,
      icon: 'i-lucide-alert-circle',
    }
  }

  if (diff === 0) {
    return {
      label: '오늘',
      tone: urgencyTones.today,
      icon: 'i-lucide-calendar-check',
    }
  }

  if (diff <= 7) {
    return {
      label: 'D-' + diff,
      tone: urgencyTones.upcoming,
      icon: 'i-lucide-calendar-days',
    }
  }

  return null
}

/**
 * 업무 운영 신호 칩을 만든다.
 * @param {string} status 업무 상태
 * @param {string} priority 우선순위
 * @param {string} statusReason 상태 메모
 * @returns {types.ProjectTaskBadge[]}
 */
function getSignalBadges(status, priority, statusReason) {
  const badges = []

  if (priority === 'high') {
    badges.push({
      label: '높음',
      tone: signalTones.high,
      icon: 'i-lucide-flame',
    })
  }

  if ((status === 'paused' || status === 'doing') && statusReason) {
    badges.push({
      label: '막힘',
      tone: signalTones.blocked,
      icon: 'i-lucide-octagon-alert',
    })
  }

  return badges
}

/**
 * 업무 레코드를 카드 표시 데이터로 바꾼다.
 * @param {types.PocketBaseRecord} record 업무 레코드
 * @param {types.ProjectTaskProject|null} project 프로젝트 표시 데이터
 * @returns {types.ProjectTaskCard}
 */
function toTaskCard(record, project) {
  const status = normalizeTaskStatus(record.get('status'))
  const priority = normalizeTaskPriority(record.get('priority'))
  const type = normalizeTaskType(record.get('type'))
  const dueAt = String(record.get('due_at') || '').trim()
  const updatedAt = String(record.get('updated') || '').trim()
  const statusReason = String(record.get('status_reason') || '').trim()
  const projectSlug = project ? String(project.slug || '').trim() : ''
  const taskId = String(record.get('id') || '')
  const dueBadge = getDueBadge(status, dueAt)
  const signalBadges = getSignalBadges(status, priority, statusReason)

  return {
    id: taskId,
    title: String(record.get('title') || '').trim(),
    description: String(record.get('description') || '').trim(),
    status,
    priority,
    priorityLabel: priorityLabels[priority] || priority,
    priorityTone: priorityTones[priority] || priorityTones.normal,
    showPriority: priority !== 'normal',
    type,
    typeLabel: typeLabels[type] || type,
    isPinned: record.get('is_pinned') === true,
    projectId: project ? String(project.id || '') : String(record.get('project') || ''),
    projectName: project ? String(project.nameKo || '').trim() : '',
    projectSlug,
    href: projectSlug ? '/projects/' + encodeURIComponent(projectSlug) + '/tasks/' + encodeURIComponent(taskId) : '',
    dueAt: dueAt ? dateutil.formatDate(dueAt, dateutil.FORMATS.DATE) : '',
    dueBadge,
    signalBadges,
    updatedAt: updatedAt ? dateutil.formatDate(updatedAt, dateutil.FORMATS.DATE) : '',
  }
}

/**
 * 상태별 업무 버킷을 만든다.
 * @returns {Record<string, types.ProjectTaskCard[]>}
 */
function createTaskBuckets() {
  /** @type {Record<string, types.ProjectTaskCard[]>} */
  const tasksByStatus = {}

  for (let index = 0; index < TASK_STATUS_COLUMNS.length; index += 1) {
    tasksByStatus[TASK_STATUS_COLUMNS[index].value] = []
  }

  return tasksByStatus
}

/**
 * 오늘 업무 화면에 표시할 업무인지 확인한다.
 * @param {types.ProjectTaskCard} task 업무 카드
 * @returns {boolean}
 */
function isTodayInboxTask(task) {
  if (task.status === 'done' || task.status === 'canceled') return false
  if (task.status === 'doing') return true
  if (!task.dueAt) return false

  return dateutil.diffDays(task.dueAt, new Date()) <= 0
}

/**
 * 프로젝트 업무 보드 데이터를 만든다.
 * @param {object} app PocketBase 앱
 * @param {string} userId 사용자 ID
 * @param {string} projectId 프로젝트 ID
 * @returns {types.ProjectTaskBoardState}
 */
function getTaskBoardState(app, userId, projectId) {
  const tasksByStatus = createTaskBuckets()

  const tasks = app.findRecordsByFilter('project_tasks', 'user = {:userId} && project = {:projectId}', '-is_pinned,+sort_order,-updated', 300, 0, { userId, projectId })

  for (let index = 0; index < tasks.length; index += 1) {
    const task = toTaskCard(tasks[index], null)
    const bucket = tasksByStatus[task.status] || tasksByStatus.todo

    bucket.push(task)
  }

  return {
    statusColumns: TASK_STATUS_COLUMNS,
    tasksByStatus,
    taskCount: tasks.length,
  }
}

/**
 * 전체 업무 인박스 데이터를 만든다.
 * @param {object} app PocketBase 앱
 * @param {string} userId 사용자 ID
 * @param {string} view 화면 구분
 * @returns {types.ProjectTaskBoardState}
 */
function getTaskInboxState(app, userId, view) {
  const tasksByStatus = createTaskBuckets()
  const projectMap = getTaskProjectMap(app, userId)
  const tasks = app.findRecordsByFilter('project_tasks', 'user = {:userId}', '-is_pinned,+sort_order,due_at,-updated', 300, 0, { userId })
  let taskCount = 0

  for (let index = 0; index < tasks.length; index += 1) {
    const record = tasks[index]
    const projectId = String(record.get('project') || '')
    const task = toTaskCard(record, projectMap[projectId] || null)

    if (view === 'today' && !isTodayInboxTask(task)) continue

    const bucket = tasksByStatus[task.status] || tasksByStatus.todo

    bucket.push(task)
    taskCount += 1
  }

  return {
    statusColumns: TASK_STATUS_COLUMNS,
    tasksByStatus,
    taskCount,
  }
}

module.exports = {
  TASK_STATUS_COLUMNS,
  TASK_STATUS_VALUES,
  TASK_PRIORITY_VALUES,
  TASK_TYPE_VALUES,
  getTaskBoardState,
  getTaskInboxState,
  normalizeTaskPriority,
  normalizeTaskStatus,
  normalizeTaskType,
}
