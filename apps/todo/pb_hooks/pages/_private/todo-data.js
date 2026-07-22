const workView = require('./work-view')

/**
 * 사용자 담당자 목록을 조회한다.
 * @param {string} userId 사용자 ID
 * @returns {types.DeveloperOption[]}
 */
function listDevelopers(userId) {
  const records = $app.findRecordsByFilter('developers', 'user = {:userId} && del = false', '+sort,+name', 200, 0, { userId })

  return workView.toDeveloperOptions(records)
}

/**
 * 업무 상태 코드 목록을 조회한다.
 * @returns {types.WorkStateOption[]}
 */
function listWorkStates() {
  const records = $app.findRecordsByFilter('codes', 'type = "workState" && del = false', '+sort,+value', 100, 0)

  return workView.toStateOptions(records)
}

/**
 * 사용자 설정을 조회한다.
 * @param {string} userId 사용자 ID
 * @returns {types.PocketBaseRecord|null}
 */
function findSetting(userId) {
  try {
    return $app.findFirstRecordByFilter('settings', 'user = {:userId}', { userId })
  } catch (_exception) {
    return null
  }
}

/**
 * 조건에 맞는 업무 카드 목록을 조회한다.
 * @param {string} userId 사용자 ID
 * @param {{done?: boolean, developerId?: string, keyword?: string, state?: string, from?: string, to?: string, dueFrom?: string, dueTo?: string, sort?: string, limit?: number}} [filters] 조회 조건
 * @returns {types.WorkCard[]}
 */
function listWorkCards(userId, filters) {
  const input = filters || {}
  const expressions = ['user = {:userId}']
  const values = { userId }

  if (typeof input.done === 'boolean') {
    expressions.push('done = {:done}')
    values.done = input.done
  }
  if (input.developerId === '__unassigned__') expressions.push('developer = ""')
  else if (input.developerId) {
    expressions.push('developer = {:developerId}')
    values.developerId = input.developerId
  }
  if (input.keyword) {
    expressions.push('(title ~ {:keyword} || content ~ {:keyword})')
    values.keyword = input.keyword
  }
  if (input.state) {
    expressions.push('state = {:state}')
    values.state = input.state
  }
  if (input.from) {
    expressions.push('updated >= {:from}')
    values.from = input.from
  }
  if (input.to) {
    expressions.push('updated <= {:to}')
    values.to = input.to
  }
  if (input.dueFrom) {
    expressions.push('dueDate >= {:dueFrom}')
    values.dueFrom = input.dueFrom
  }
  if (input.dueTo) {
    expressions.push('dueDate <= {:dueTo}')
    values.dueTo = input.dueTo
  }

  const developers = listDevelopers(userId)
  const stateOptions = listWorkStates()
  const setting = findSetting(userId)
  const records = $app.findRecordsByFilter('works', expressions.join(' && '), input.sort || '+sort,-created', input.limit || 500, 0, values)
  const developerMap = workView.getDeveloperMap(developers)
  const urgentDays = workView.getUrgentDays(setting)
  const cards = []

  for (let index = 0; index < records.length; index += 1) {
    cards.push(workView.toWorkCard(records[index], developerMap, stateOptions, urgentDays))
  }

  return cards
}

module.exports = {
  findSetting,
  listDevelopers,
  listWorkCards,
  listWorkStates,
}
