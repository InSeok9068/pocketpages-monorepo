;(() => {
  const forms = Array.from(document.querySelectorAll('[data-home-filter-form]'))
  if (!forms.length) return

  const statusKey = 'homepocket:filter-status'
  const query = new URLSearchParams(window.location.search)
  const initialSection = query.get('section') || forms[0].elements.section.value
  const formsNeedingRefresh = new Set()

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

  function restorePreference(select, key, queryName, isActiveSection, allSections) {
    if ((allSections || isActiveSection) && query.has(queryName)) return false

    const savedValue = readPreference(key)
    if (savedValue === null) return false

    const hasOption = Array.from(select.options).some((option) => option.value === savedValue)
    if (!hasOption) {
      try {
        window.localStorage.removeItem(key)
      } catch {
        // 저장소를 사용할 수 없는 브라우저에서는 현재 선택만 적용한다.
      }
      return false
    }
    if (select.value === savedValue) return false

    select.value = savedValue
    return true
  }

  for (const form of forms) {
    const section = form.elements.section.value
    const statusSelect = form.elements.status
    const tagSelect = form.elements.tag
    const activeSection = section === initialSection

    if (restorePreference(statusSelect, statusKey, 'status', activeSection, true)) {
      for (const sectionForm of forms) formsNeedingRefresh.add(sectionForm)
    }
    if (restorePreference(tagSelect, 'homepocket:filter-tag:' + section, 'tag', activeSection)) {
      formsNeedingRefresh.add(form)
    }

    form.addEventListener('change', (event) => {
      if (event.target === statusSelect) {
        writePreference(statusKey, statusSelect.value)
        for (const sectionForm of forms) {
          const sectionStatus = sectionForm.elements.status
          sectionStatus.value = statusSelect.value
          if (sectionForm !== form) sectionForm.requestSubmit()
        }
      }

      if (event.target === tagSelect) {
        writePreference('homepocket:filter-tag:' + section, tagSelect.value)
      }
    })
  }

  function applySavedFilters() {
    for (const form of formsNeedingRefresh) form.requestSubmit()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applySavedFilters, { once: true })
  } else {
    applySavedFilters()
  }
})()
