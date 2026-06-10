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
 * 업무 레코드를 카드 표시 데이터로 바꾼다.
 * @param {types.PocketBaseRecord} record 업무 레코드
 * @returns {types.ProjectTaskCard}
 */
function toTaskCard(record) {
  const status = normalizeTaskStatus(record.get('status'))
  const priority = normalizeTaskPriority(record.get('priority'))
  const type = normalizeTaskType(record.get('type'))
  const dueAt = String(record.get('due_at') || '').trim()
  const updatedAt = String(record.get('updated') || '').trim()

  return {
    id: String(record.get('id') || ''),
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
    dueAt: dueAt ? dateutil.formatDate(dueAt, dateutil.FORMATS.DATE) : '',
    updatedAt: updatedAt ? dateutil.formatDate(updatedAt, dateutil.FORMATS.DATE) : '',
  }
}

/**
 * 프로젝트 업무 보드 데이터를 만든다.
 * @param {object} app PocketBase 앱
 * @param {string} userId 사용자 ID
 * @param {string} projectId 프로젝트 ID
 * @returns {types.ProjectTaskBoardState}
 */
function getTaskBoardState(app, userId, projectId) {
  /** @type {Record<string, types.ProjectTaskCard[]>} */
  const tasksByStatus = {}

  for (let index = 0; index < TASK_STATUS_COLUMNS.length; index += 1) {
    tasksByStatus[TASK_STATUS_COLUMNS[index].value] = []
  }

  const tasks = app.findRecordsByFilter('project_tasks', 'user = {:userId} && project = {:projectId}', '-is_pinned,+sort_order,-updated', 300, 0, { userId, projectId })

  for (let index = 0; index < tasks.length; index += 1) {
    const task = toTaskCard(tasks[index])
    const bucket = tasksByStatus[task.status] || tasksByStatus.todo

    bucket.push(task)
  }

  return {
    statusColumns: TASK_STATUS_COLUMNS,
    tasksByStatus,
    taskCount: tasks.length,
  }
}

module.exports = {
  TASK_STATUS_COLUMNS,
  TASK_STATUS_VALUES,
  TASK_PRIORITY_VALUES,
  TASK_TYPE_VALUES,
  getTaskBoardState,
  normalizeTaskPriority,
  normalizeTaskStatus,
  normalizeTaskType,
}
