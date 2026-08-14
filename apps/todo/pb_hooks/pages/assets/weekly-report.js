;(function () {
  const BLOCK_TAGS = {
    BLOCKQUOTE: true,
    DIV: true,
    H1: true,
    H2: true,
    H3: true,
    H4: true,
    H5: true,
    H6: true,
    P: true,
    PRE: true,
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function readNodeText(node, listDepth) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    if (node.tagName === 'BR') return '\n'

    let text = ''
    const depth = node.tagName === 'UL' || node.tagName === 'OL' ? listDepth + 1 : listDepth

    for (let index = 0; index < node.childNodes.length; index += 1) {
      text += readNodeText(node.childNodes[index], depth)
    }

    if (node.tagName === 'LI') return '  '.repeat(Math.max(0, listDepth - 1)) + '- ' + text.trim() + '\n'
    if (BLOCK_TAGS[node.tagName]) return text + '\n'

    return text
  }

  function makeReportContent(title, contentHtml) {
    const documentValue = new DOMParser().parseFromString(String(contentHtml || ''), 'text/html')
    const content = normalizeText(readNodeText(documentValue.body, 0))

    return normalizeText(content ? String(title || '') + '\n' + content : title)
  }

  function escapeSpreadsheetText(value) {
    const text = String(value || '')

    return /^[=+@]/.test(text) ? "'" + text : text
  }

  function toDelimitedCell(value) {
    const text = escapeSpreadsheetText(value)

    return /[\t\r\n"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }

  function createClipboardTable(rows) {
    const table = document.createElement('table')
    const body = document.createElement('tbody')

    for (let index = 0; index < rows.length; index += 1) {
      const tableRow = document.createElement('tr')
      const contentsCell = document.createElement('td')

      contentsCell.textContent = escapeSpreadsheetText(rows[index].contents)
      contentsCell.style.whiteSpace = 'pre-wrap'
      contentsCell.colSpan = 6
      tableRow.appendChild(contentsCell)

      const ownerCell = document.createElement('td')
      const dueDateCell = document.createElement('td')
      const workingTimeCell = document.createElement('td')

      ownerCell.textContent = escapeSpreadsheetText(rows[index].owner)
      dueDateCell.textContent = escapeSpreadsheetText(rows[index].dueDate)
      workingTimeCell.textContent = escapeSpreadsheetText(rows[index].workingTime)
      tableRow.appendChild(ownerCell)
      tableRow.appendChild(dueDateCell)
      tableRow.appendChild(workingTimeCell)

      body.appendChild(tableRow)
    }

    table.appendChild(body)

    return table
  }

  function copyWithSelection(table) {
    const container = document.createElement('div')
    const selection = window.getSelection()
    const range = document.createRange()

    container.style.position = 'fixed'
    container.style.left = '-9999px'
    container.appendChild(table)
    document.body.appendChild(container)
    range.selectNodeContents(table)
    selection.removeAllRanges()
    selection.addRange(range)

    const copied = document.execCommand('copy')

    selection.removeAllRanges()
    container.remove()

    if (!copied) throw new Error('클립보드 복사에 실패했습니다.')
  }

  async function copyTable(table, plainText) {
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ])
      return
    }

    copyWithSelection(table)
  }

  function showToast(message, tone) {
    window.dispatchEvent(
      new CustomEvent('app-toast', {
        detail: { message, tone: tone || 'info' },
      })
    )
  }

  function initializeWeeklyReport(root) {
    const sectionNames = ['thisWeek', 'nextWeek']
    const itemElements = Array.from(root.querySelectorAll('[data-report-item]'))
    const selectedCount = root.querySelector('[data-selected-count]')
    const itemCount = root.querySelector('[data-item-count]')
    const draftKey = String(root.dataset.draftKey || '')
    let activeSection = 'thisWeek'
    let draft = {
      activeSection,
      sections: { thisWeek: {}, nextWeek: {} },
    }
    let saveTimer = 0
    let shouldPersistDraft = true
    let storageErrorShown = false
    let items = []

    try {
      items = JSON.parse(root.dataset.reportItems || '[]')
    } catch (_exception) {
      showToast('업무 내용을 불러오지 못했습니다.', 'error')
    }

    try {
      const savedDraft = JSON.parse(window.localStorage.getItem(draftKey) || '{}')
      if (savedDraft && savedDraft.sections && typeof savedDraft.sections === 'object') {
        draft.sections.thisWeek = savedDraft.sections.thisWeek || {}
        draft.sections.nextWeek = savedDraft.sections.nextWeek || {}
        if (sectionNames.indexOf(savedDraft.activeSection) !== -1) activeSection = savedDraft.activeSection
      } else if (savedDraft && savedDraft.items && typeof savedDraft.items === 'object') {
        const workIds = Object.keys(savedDraft.items)

        for (let index = 0; index < workIds.length; index += 1) {
          const workId = workIds[index]
          const savedItem = savedDraft.items[workId]

          draft.sections.thisWeek[workId] = {
            contents: savedItem.contents,
            owner: savedItem.owner,
            dueDate: savedItem.dueDate,
            workingTime: savedItem.workingTime,
            selected: !!savedItem.selected,
            included: !savedItem.removed,
          }
        }
      }
    } catch (_exception) {
      draft.sections = { thisWeek: {}, nextWeek: {} }
    }
    draft.activeSection = activeSection

    function persistDraft() {
      window.clearTimeout(saveTimer)
      if (!draftKey || !shouldPersistDraft) return

      try {
        window.localStorage.setItem(draftKey, JSON.stringify(draft))
      } catch (_exception) {
        if (!storageErrorShown) showToast('브라우저 임시 저장에 실패했습니다.', 'error')
        storageErrorShown = true
      }
    }

    function scheduleDraftSave() {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(persistDraft, 200)
    }

    function saveItemDraft(element, included) {
      const workId = String(element.dataset.reportId || '')
      const sectionName = String(element.dataset.reportSection || '')
      if (!workId) return

      draft.sections[sectionName][workId] = {
        contents: element.querySelector('[data-report-content]').value,
        owner: element.querySelector('[data-report-owner]').value,
        dueDate: element.querySelector('[data-report-due-date]').value,
        workingTime: element.querySelector('[data-report-working-time]').value,
        selected: element.querySelector('[data-report-selected]').checked,
        included: !!included,
      }
      scheduleDraftSave()
    }

    function getIncludedElements(sectionName) {
      return itemElements.filter(function (element) {
        return element.dataset.reportSection === sectionName && !element.hidden
      })
    }

    function updateCounts() {
      for (let index = 0; index < sectionNames.length; index += 1) {
        const sectionName = sectionNames[index]
        const elements = getIncludedElements(sectionName)

        root.querySelector('[data-section-count="' + sectionName + '"]').textContent = String(elements.length)
        root.querySelector('[data-section-empty="' + sectionName + '"]').hidden = elements.length > 0
      }

      const activeElements = getIncludedElements(activeSection)
      const count = activeElements.filter(function (element) {
        return element.querySelector('[data-report-selected]').checked
      }).length

      selectedCount.textContent = String(count)
      itemCount.textContent = String(activeElements.length)
    }

    function setActiveSection(sectionName, saveSelection) {
      activeSection = sectionName
      draft.activeSection = sectionName

      for (let index = 0; index < sectionNames.length; index += 1) {
        const currentName = sectionNames[index]
        const isActive = currentName === sectionName
        const tab = root.querySelector('[data-report-tab="' + currentName + '"]')

        root.querySelector('[data-report-panel="' + currentName + '"]').hidden = !isActive
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false')
        tab.classList.toggle('bg-slate-900', isActive)
        tab.classList.toggle('text-white', isActive)
        tab.classList.toggle('text-slate-600', !isActive)
        tab.classList.toggle('hover:bg-slate-100', !isActive)
      }

      updateCounts()
      if (saveSelection) scheduleDraftSave()
    }

    function readSelectedRows() {
      const rows = []

      const activeElements = getIncludedElements(activeSection)
      for (let index = 0; index < activeElements.length; index += 1) {
        const element = activeElements[index]
        if (!element.querySelector('[data-report-selected]').checked) continue

        rows.push({
          contents: normalizeText(element.querySelector('[data-report-content]').value),
          owner: String(element.querySelector('[data-report-owner]').value || '').trim(),
          dueDate: String(element.querySelector('[data-report-due-date]').value || '').trim() || '-',
          workingTime: String(element.querySelector('[data-report-working-time]').value || '').trim(),
        })
      }

      return rows
    }

    async function handleCopy() {
      const rows = readSelectedRows()
      if (!rows.length) {
        showToast('복사할 업무를 먼저 선택해주세요.', 'error')
        return
      }

      const plainText = rows
        .map(function (row) {
          return [
            toDelimitedCell(row.contents),
            toDelimitedCell(row.owner),
            toDelimitedCell(row.dueDate),
            toDelimitedCell(row.workingTime),
          ].join('\t')
        })
        .join('\n')

      try {
        await copyTable(createClipboardTable(rows), plainText)
        showToast('선택한 엑셀 행을 복사했습니다.', 'success')
      } catch (exception) {
        showToast(String(exception.message || exception), 'error')
      }
    }

    for (let index = 0; index < itemElements.length; index += 1) {
      const element = itemElements[index]
      const sectionName = String(element.dataset.reportSection || '')
      const workId = String(element.dataset.reportId || '')
      const itemIndex = Number(element.dataset.reportIndex)
      const item = items[itemIndex] || {}
      const savedItem = draft.sections[sectionName][workId] || null
      const contentInput = element.querySelector('[data-report-content]')
      const ownerInput = element.querySelector('[data-report-owner]')
      const dueDateInput = element.querySelector('[data-report-due-date]')
      const workingTimeInput = element.querySelector('[data-report-working-time]')
      const selectedInput = element.querySelector('[data-report-selected]')

      contentInput.value =
        savedItem && typeof savedItem.contents === 'string'
          ? savedItem.contents
          : makeReportContent(item.title, item.contentHtml)
      if (savedItem && typeof savedItem.owner === 'string') ownerInput.value = savedItem.owner
      if (savedItem && typeof savedItem.dueDate === 'string') dueDateInput.value = savedItem.dueDate
      if (savedItem && typeof savedItem.workingTime === 'string') workingTimeInput.value = savedItem.workingTime
      selectedInput.checked = !!(savedItem && savedItem.selected)
      element.hidden = savedItem ? savedItem.included === false : sectionName === 'nextWeek'

      contentInput.addEventListener('input', function () {
        saveItemDraft(element, true)
      })
      ownerInput.addEventListener('input', function () {
        saveItemDraft(element, true)
      })
      dueDateInput.addEventListener('input', function () {
        saveItemDraft(element, true)
      })
      workingTimeInput.addEventListener('input', function () {
        saveItemDraft(element, true)
      })
      selectedInput.addEventListener('change', function () {
        updateCounts()
        saveItemDraft(element, true)
      })
      element.querySelector('[data-remove-report-item]').addEventListener('click', function () {
        selectedInput.checked = false
        element.hidden = true
        saveItemDraft(element, false)
        updateCounts()
      })

      const copyButton = element.querySelector('[data-copy-to-next-week]')
      if (copyButton) {
        copyButton.addEventListener('click', function () {
          const target = root.querySelector(
            '[data-report-item][data-report-section="nextWeek"][data-report-id="' + workId + '"]'
          )
          const savedTarget = draft.sections.nextWeek[workId] || null

          if (!savedTarget) {
            target.querySelector('[data-report-content]').value = contentInput.value
            target.querySelector('[data-report-owner]').value = ownerInput.value
            target.querySelector('[data-report-due-date]').value = dueDateInput.value
            target.querySelector('[data-report-working-time]').value = workingTimeInput.value
            target.querySelector('[data-report-selected]').checked = false
          }

          target.hidden = false
          saveItemDraft(target, true)
          updateCounts()
          showToast('다음 주 업무로 복사했습니다.', 'success')
        })
      }
    }

    for (let index = 0; index < sectionNames.length; index += 1) {
      const sectionName = sectionNames[index]
      root.querySelector('[data-report-tab="' + sectionName + '"]').addEventListener('click', function () {
        setActiveSection(sectionName, true)
      })
    }

    root.querySelector('[data-select-all]').addEventListener('click', function () {
      const activeElements = getIncludedElements(activeSection)
      for (let index = 0; index < activeElements.length; index += 1) {
        activeElements[index].querySelector('[data-report-selected]').checked = true
        saveItemDraft(activeElements[index], true)
      }
      updateCounts()
    })
    root.querySelector('[data-clear-selection]').addEventListener('click', function () {
      const activeElements = getIncludedElements(activeSection)
      for (let index = 0; index < activeElements.length; index += 1) {
        activeElements[index].querySelector('[data-report-selected]').checked = false
        saveItemDraft(activeElements[index], true)
      }
      updateCounts()
    })
    root.querySelector('[data-reset-draft]').addEventListener('click', function () {
      const sectionLabel = activeSection === 'thisWeek' ? '이번 주' : '다음 주'
      if (!window.confirm(sectionLabel + ' 임시 저장 내용을 초기화할까요?')) return

      draft.sections[activeSection] = {}
      persistDraft()
      shouldPersistDraft = false
      window.location.reload()
    })
    root.querySelector('[data-copy-rows]').addEventListener('click', function () {
      handleCopy()
    })
    window.addEventListener('pagehide', persistDraft)

    setActiveSection(activeSection, false)
    scheduleDraftSave()
  }

  const root = document.querySelector('[data-weekly-report]')
  if (root) initializeWeeklyReport(root)
})()
