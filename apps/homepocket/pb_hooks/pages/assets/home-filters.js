(() => {
  const form = document.getElementById('home-filter-form')
  if (!form) return

  const statusSelect = form.querySelector('select[name="status"]')
  const tagSelect = form.querySelector('select[name="tag"]')
  const section = form.querySelector('input[name="section"]').value
  const statusKey = 'homepocket:filter-status'
  const tagKey = 'homepocket:filter-tag:' + section
  const query = new URLSearchParams(window.location.search)
  let needsRefresh = false

  function readPreference(key) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }

  function writePreference(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // 저장소를 사용할 수 없는 브라우저에서는 현재 선택만 적용한다.
    }
  }

  function restorePreference(select, key, queryName) {
    if (query.has(queryName)) return false

    const savedValue = readPreference(key)
    const hasOption = Array.from(select.options).some((option) => option.value === savedValue)
    if (savedValue === null || !hasOption || select.value === savedValue) return false

    select.value = savedValue
    return true
  }

  needsRefresh = restorePreference(statusSelect, statusKey, 'status') || needsRefresh
  needsRefresh = restorePreference(tagSelect, tagKey, 'tag') || needsRefresh

  form.addEventListener('change', (event) => {
    if (event.target === statusSelect) writePreference(statusKey, statusSelect.value)
    if (event.target === tagSelect) writePreference(tagKey, tagSelect.value)
  })

  function applySavedFilters() {
    if (needsRefresh) form.requestSubmit()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applySavedFilters, { once: true })
  } else {
    applySavedFilters()
  }
})()
