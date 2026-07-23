const WATCHER_GROUPS = Object.freeze({
  cx: [38, 95, 107, 118, 122],
  server: [82, 98, 110, 123],
  client: [31, 93],
  biz: [48, 60, 85, 109],
  manager: [8, 6],
})

/**
 * 비어 있는 Redmine 상세 패널 데이터를 만든다.
 * @returns {types.RedmineIssueView}
 */
function createEmptyIssueView() {
  return {
    id: '',
    subject: '',
    projectName: '',
    trackerName: '',
    statusId: 0,
    statusName: '',
    assignedToId: 0,
    assignedToName: '',
    startDate: '',
    dueDate: '',
    doneRatio: 0,
    url: '',
    allowedStatuses: [],
    allowedAssignees: [],
  }
}

/**
 * Redmine URL에서 이슈 번호를 읽는다.
 * @param {string} value Redmine 이슈 URL
 * @returns {string}
 */
function parseIssueId(value) {
  const match = String(value || '').match(/\/issues\/(\d+)(?=[/?#]|$)/)

  return match ? match[1] : ''
}

/**
 * Redmine 이슈를 조회한다.
 * @param {types.RedmineConfig} config Redmine 접속 설정
 * @param {string} issueId 이슈 번호
 * @returns {types.RedmineApiIssue}
 */
function getIssue(config, issueId) {
  requireConfig(config)
  const result = $http.send({
    url: config.host + '/issues/' + encodeURIComponent(issueId) + '.json?include=allowed_statuses',
    timeout: 20000,
    headers: getHeaders(config),
  })

  assertSuccess(result, 'Redmine 이슈를 불러오지 못했습니다.')

  const issue = /** @type {types.RedmineApiIssue} */ (result.json && result.json.issue ? result.json.issue : {})

  if (!Array.isArray(issue.allowed_statuses) || !issue.allowed_statuses.length) {
    const statusesResult = $http.send({
      url: config.host + '/issue_statuses.json',
      timeout: 20000,
      headers: getHeaders(config),
    })

    if (statusesResult.statusCode >= 200 && statusesResult.statusCode < 300) {
      issue.allowed_statuses = statusesResult.json && Array.isArray(statusesResult.json.issue_statuses) ? statusesResult.json.issue_statuses : []
    }
  }

  const projectId = issue.project ? String(issue.project.id || '') : ''
  issue.assignable_users = projectId ? getProjectAssignees(config, projectId) : []

  return issue
}

/**
 * Redmine 이슈를 생성한다.
 * @param {types.RedmineConfig} config Redmine 접속 설정
 * @param {types.RedmineCreateInput} input 생성 값
 * @returns {types.RedmineApiIssue}
 */
function createIssue(config, input) {
  requireConfig(config)
  if (!config.projectId) throw new Error('REDMINE_PROJECT_ID 설정이 필요합니다.')

  const issue = {
    project_id: config.projectId,
    subject: input.subject,
    description: input.description || '',
    start_date: input.startDate || '',
    due_date: input.dueDate || '',
    watcher_user_ids: resolveWatcherIds(input.watcherGroups || []),
  }

  if (config.trackerId) issue.tracker_id = config.trackerId

  const result = $http.send({
    url: config.host + '/issues.json',
    method: 'POST',
    timeout: 20000,
    body: JSON.stringify({ issue }),
    headers: getJsonHeaders(config),
  })

  assertSuccess(result, 'Redmine 이슈를 생성하지 못했습니다.')

  return /** @type {types.RedmineApiIssue} */ (result.json && result.json.issue ? result.json.issue : {})
}

/**
 * Redmine 이슈 상태와 일정을 수정한다.
 * @param {types.RedmineConfig} config Redmine 접속 설정
 * @param {types.RedmineUpdateInput} input 수정 값
 */
function updateIssue(config, input) {
  requireConfig(config)
  const issue = {
    start_date: input.startDate || '',
    due_date: input.dueDate || '',
    done_ratio: Math.max(0, Math.min(100, Number(input.doneRatio || 0))),
    notes: input.notes || '',
  }

  if (Number(input.statusId || 0) > 0) issue.status_id = Number(input.statusId)
  issue.assigned_to_id = Number(input.assignedToId || 0) || null

  const result = $http.send({
    url: config.host + '/issues/' + encodeURIComponent(input.id) + '.json',
    method: 'PUT',
    timeout: 20000,
    body: JSON.stringify({ issue }),
    headers: getJsonHeaders(config),
  })

  assertSuccess(result, 'Redmine 이슈를 수정하지 못했습니다.')
}

/**
 * Redmine 이슈에 관찰자 그룹을 추가한다.
 * @param {types.RedmineConfig} config Redmine 접속 설정
 * @param {string} issueId 이슈 번호
 * @param {string[]} watcherGroups 관찰자 그룹
 * @returns {{addedCount: number, failedIds: number[]}}
 */
function addWatcherGroups(config, issueId, watcherGroups) {
  requireConfig(config)
  const watcherIds = resolveWatcherIds(watcherGroups)
  const failedIds = []
  let addedCount = 0

  for (let index = 0; index < watcherIds.length; index += 1) {
    const result = $http.send({
      url: config.host + '/issues/' + encodeURIComponent(issueId) + '/watchers.json',
      method: 'POST',
      timeout: 20000,
      body: JSON.stringify({ user_id: watcherIds[index] }),
      headers: getJsonHeaders(config),
    })

    if (result.statusCode >= 200 && result.statusCode < 300) addedCount += 1
    else failedIds.push(watcherIds[index])
  }

  return { addedCount, failedIds }
}

/**
 * Redmine 응답을 상세 패널 데이터로 변환한다.
 * @param {types.RedmineConfig} config Redmine 접속 설정
 * @param {types.RedmineApiIssue} issue Redmine 이슈
 * @returns {types.RedmineIssueView}
 */
function toIssueView(config, issue) {
  const status = issue.status || {}
  const assignedTo = issue.assigned_to || {}
  const project = issue.project || {}
  const tracker = issue.tracker || {}
  const rawStatuses = Array.isArray(issue.allowed_statuses) ? issue.allowed_statuses : []
  const rawAssignees = Array.isArray(issue.assignable_users) ? issue.assignable_users : []
  const allowedStatuses = []
  const allowedAssignees = []

  for (let index = 0; index < rawStatuses.length; index += 1) {
    allowedStatuses.push({
      id: Number(rawStatuses[index].id || 0),
      name: String(rawStatuses[index].name || ''),
      isClosed: !!rawStatuses[index].is_closed,
    })
  }

  const statusId = Number(status.id || 0)
  let hasCurrentStatus = false
  for (let index = 0; index < allowedStatuses.length; index += 1) {
    if (allowedStatuses[index].id === statusId) hasCurrentStatus = true
  }
  if (!hasCurrentStatus && statusId) {
    allowedStatuses.unshift({ id: statusId, name: String(status.name || statusId), isClosed: !!status.is_closed })
  }

  for (let index = 0; index < rawAssignees.length; index += 1) {
    const assigneeId = Number(rawAssignees[index].id || 0)
    if (!assigneeId) continue
    allowedAssignees.push({ id: assigneeId, name: String(rawAssignees[index].name || assigneeId) })
  }

  const assignedToId = Number(assignedTo.id || 0)
  let hasCurrentAssignee = false
  for (let index = 0; index < allowedAssignees.length; index += 1) {
    if (allowedAssignees[index].id === assignedToId) hasCurrentAssignee = true
  }
  if (!hasCurrentAssignee && assignedToId) {
    allowedAssignees.unshift({ id: assignedToId, name: String(assignedTo.name || assignedToId) })
  }

  const id = String(issue.id || '')

  return {
    id,
    subject: String(issue.subject || ''),
    projectName: String(project.name || ''),
    trackerName: String(tracker.name || ''),
    statusId,
    statusName: String(status.name || ''),
    assignedToId,
    assignedToName: String(assignedTo.name || ''),
    startDate: String(issue.start_date || ''),
    dueDate: String(issue.due_date || ''),
    doneRatio: Number(issue.done_ratio || 0),
    url: config.host + '/issues/' + encodeURIComponent(id),
    allowedStatuses,
    allowedAssignees,
  }
}

/**
 * 프로젝트 멤버십에서 담당자 후보를 조회한다.
 * @param {types.RedmineConfig} config Redmine 접속 설정
 * @param {string} projectId 프로젝트 ID
 * @returns {types.RedmineApiNamedValue[]}
 */
function getProjectAssignees(config, projectId) {
  const assignees = []
  const seenIds = {}
  let offset = 0
  let totalCount = 0

  do {
    const result = $http.send({
      url: config.host + '/projects/' + encodeURIComponent(projectId) + '/memberships.json?limit=100&offset=' + offset,
      timeout: 20000,
      headers: getHeaders(config),
    })

    assertSuccess(result, 'Redmine 담당자 목록을 불러오지 못했습니다.')

    const memberships = result.json && Array.isArray(result.json.memberships) ? result.json.memberships : []
    totalCount = Number(result.json && result.json.total_count ? result.json.total_count : memberships.length)

    for (let index = 0; index < memberships.length; index += 1) {
      const owner = memberships[index].user || memberships[index].group || {}
      const ownerId = Number(owner.id || 0)
      if (!ownerId || seenIds[ownerId]) continue

      seenIds[ownerId] = true
      assignees.push({ id: ownerId, name: String(owner.name || ownerId) })
    }

    if (!memberships.length) break
    offset += memberships.length
  } while (offset < totalCount && offset < 500)

  return assignees
}

function resolveWatcherIds(groups) {
  const watcherIds = []
  const seenIds = {}

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const groupIds = WATCHER_GROUPS[String(groups[groupIndex] || '')] || []

    for (let watcherIndex = 0; watcherIndex < groupIds.length; watcherIndex += 1) {
      const watcherId = Number(groupIds[watcherIndex])
      if (seenIds[watcherId]) continue
      seenIds[watcherId] = true
      watcherIds.push(watcherId)
    }
  }

  return watcherIds
}

function requireConfig(config) {
  if (!config.apiKey) throw new Error('REDMINE_API_KEY 설정이 필요합니다.')
}

function getHeaders(config) {
  return { 'x-redmine-api-key': config.apiKey }
}

function getJsonHeaders(config) {
  return {
    'x-redmine-api-key': config.apiKey,
    'content-type': 'application/json',
  }
}

function assertSuccess(result, message) {
  if (result.statusCode >= 200 && result.statusCode < 300) return

  const errors = result.json && Array.isArray(result.json.errors) ? result.json.errors.join(', ') : ''
  throw new Error(errors ? message + ' ' + errors : message + ' (HTTP ' + result.statusCode + ')')
}

module.exports = {
  addWatcherGroups,
  createEmptyIssueView,
  createIssue,
  getIssue,
  parseIssueId,
  toIssueView,
  updateIssue,
}
