(function () {
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

      ownerCell.textContent = escapeSpreadsheetText(rows[index].owner)
      dueDateCell.textContent = escapeSpreadsheetText(rows[index].dueDate)
      tableRow.appendChild(ownerCell)
      tableRow.appendChild(dueDateCell)

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
    let itemElements = Array.from(root.querySelectorAll('[data-report-item]'))
    const selectedCount = root.querySelector('[data-selected-count]')
    const itemCount = root.querySelector('[data-item-count]')
    let items = []

    try {
      items = JSON.parse(root.dataset.reportItems || '[]')
    } catch (_exception) {
      showToast('업무 내용을 불러오지 못했습니다.', 'error')
    }

    function updateSelectedCount() {
      const count = itemElements.filter(function (element) {
        return element.querySelector('[data-report-selected]').checked
      }).length

      selectedCount.textContent = String(count)
      itemCount.textContent = String(itemElements.length)
    }

    function readSelectedRows() {
      const rows = []

      for (let index = 0; index < itemElements.length; index += 1) {
        const element = itemElements[index]
        if (!element.querySelector('[data-report-selected]').checked) continue

        rows.push({
          contents: normalizeText(element.querySelector('[data-report-content]').value),
          owner: String(element.querySelector('[data-report-owner]').value || '').trim(),
          dueDate: String(element.querySelector('[data-report-due-date]').value || '').trim() || '-',
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
          return [toDelimitedCell(row.contents), toDelimitedCell(row.owner), toDelimitedCell(row.dueDate)].join('\t')
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
      const itemIndex = Number(element.dataset.reportIndex)
      const item = items[itemIndex] || {}

      element.querySelector('[data-report-content]').value = makeReportContent(item.title, item.contentHtml)
      element.querySelector('[data-report-selected]').addEventListener('change', updateSelectedCount)
      element.querySelector('[data-remove-report-item]').addEventListener('click', function () {
        itemElements = itemElements.filter(function (itemElement) {
          return itemElement !== element
        })
        element.remove()
        updateSelectedCount()
      })
    }

    root.querySelector('[data-select-all]').addEventListener('click', function () {
      for (let index = 0; index < itemElements.length; index += 1) {
        itemElements[index].querySelector('[data-report-selected]').checked = true
      }
      updateSelectedCount()
    })
    root.querySelector('[data-clear-selection]').addEventListener('click', function () {
      for (let index = 0; index < itemElements.length; index += 1) {
        itemElements[index].querySelector('[data-report-selected]').checked = false
      }
      updateSelectedCount()
    })
    root.querySelector('[data-copy-rows]').addEventListener('click', function () {
      handleCopy()
    })

    updateSelectedCount()
  }

  const root = document.querySelector('[data-weekly-report]')
  if (root) initializeWeeklyReport(root)
})()
