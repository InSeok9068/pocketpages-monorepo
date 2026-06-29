;(function () {
  const db = window.MomCalendarDb
  const FullCalendar = window.FullCalendar

  const state = {
    calendar: null,
    workplaces: [],
    logsByDate: new Map(),
    monthPickerYear: new Date().getFullYear(),
    touchMoved: false,
    touchStartY: 0,
    backupMeta: null,
    backupRunning: false,
  }
  const FREELANCER_TAX_RATE = 0.033
  const TOUCH_SCROLL_THRESHOLD = 8
  const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000

  /**
   * 숫자 입력값을 정리한다.
   * @param {string | number} value
   * @returns {number}
   */
  function toNumber(value) {
    const numberValue = Number(value)
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0
  }

  /**
   * 로컬 저장용 ID를 만든다.
   * @param {string} prefix
   * @returns {string}
   */
  function createId(prefix) {
    if (window.crypto && window.crypto.randomUUID) {
      return prefix + '_' + window.crypto.randomUUID()
    }

    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
  }

  /**
   * 백업 복구 코드를 만든다.
   * @returns {string}
   */
  function createBackupId() {
    return createId('mom')
  }

  /**
   * 금액을 원화 표기로 바꾼다.
   * @param {number} amount
   * @returns {string}
   */
  function formatCurrency(amount) {
    return Math.round(amount).toLocaleString('ko-KR') + '원'
  }

  /**
   * 날짜 문자열을 표시용으로 바꾼다.
   * @param {string} date
   * @returns {string}
   */
  function formatDateLabel(date) {
    const parts = date.split('-')
    return parts[0] + '년 ' + Number(parts[1]) + '월 ' + Number(parts[2]) + '일'
  }

  /**
   * 날짜 객체를 input date 값으로 바꾼다.
   * @param {Date} date
   * @returns {string}
   */
  function formatDateInput(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return year + '-' + month + '-' + day
  }

  /**
   * 오늘 시각을 ISO 문자열로 만든다.
   * @returns {string}
   */
  function nowIso() {
    return new Date().toISOString()
  }

  /**
   * 일시를 화면 표시용으로 바꾼다.
   * @param {string} value
   * @returns {string}
   */
  function formatDateTimeLabel(value) {
    if (!value) return '없음'

    const date = new Date(value)
    if (isNaN(date.getTime())) return '없음'

    return date.toLocaleString('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  /**
   * DOM 참조를 모은다.
   * @returns {Record<string, HTMLElement>}
   */
  function getElements() {
    return {
      calendar: document.getElementById('calendar'),
      summaryDays: document.getElementById('summary-days'),
      summaryOvertime: document.getElementById('summary-overtime'),
      summaryPay: document.getElementById('summary-pay'),
      sheetBackdrop: document.getElementById('sheet-backdrop'),
      salarySheet: document.getElementById('salary-sheet'),
      monthSheet: document.getElementById('month-sheet'),
      workplaceSheet: document.getElementById('workplace-sheet'),
      showCalendarButton: document.getElementById('show-calendar-button'),
      openSalarySheetButton: document.getElementById('open-salary-sheet-button'),
      openWorkplaceSheetButton: document.getElementById('open-workplace-sheet-button'),
      closeSalarySheetButton: document.getElementById('close-salary-sheet-button'),
      closeMonthSheetButton: document.getElementById('close-month-sheet-button'),
      closeWorkplaceSheetButton: document.getElementById('close-workplace-sheet-button'),
      prevMonthYearButton: document.getElementById('prev-month-year-button'),
      nextMonthYearButton: document.getElementById('next-month-year-button'),
      monthPickerYear: document.getElementById('month-picker-year'),
      monthOptionList: document.getElementById('month-option-list'),
      salaryStartDate: document.getElementById('salary-start-date'),
      salaryEndDate: document.getElementById('salary-end-date'),
      salaryTaxEnabled: document.getElementById('salary-tax-enabled'),
      salaryWorkDays: document.getElementById('salary-work-days'),
      salaryGrossPay: document.getElementById('salary-gross-pay'),
      salaryTaxAmount: document.getElementById('salary-tax-amount'),
      salaryNetPay: document.getElementById('salary-net-pay'),
      salaryFormula: document.getElementById('salary-formula'),
      workplaceForm: document.getElementById('workplace-form'),
      workplaceId: document.getElementById('workplace-id'),
      workplaceName: document.getElementById('workplace-name'),
      dailyPay: document.getElementById('daily-pay'),
      overtimeHourlyPay: document.getElementById('overtime-hourly-pay'),
      mealAllowance: document.getElementById('meal-allowance'),
      resetWorkplaceButton: document.getElementById('reset-workplace-button'),
      workplaceList: document.getElementById('workplace-list'),
      worklogDialog: document.getElementById('worklog-dialog'),
      worklogForm: document.getElementById('worklog-form'),
      worklogDate: document.getElementById('worklog-date'),
      worklogDateLabel: document.getElementById('worklog-date-label'),
      worklogWorkplace: document.getElementById('worklog-workplace'),
      worklogOvertimeHours: document.getElementById('worklog-overtime-hours'),
      worklogMealAllowancePaid: document.getElementById('worklog-meal-allowance-paid'),
      closeWorklogButton: document.getElementById('close-worklog-button'),
      deleteWorklogButton: document.getElementById('delete-worklog-button'),
      backupStatus: document.getElementById('backup-status'),
      backupCode: document.getElementById('backup-code'),
      copyBackupCodeButton: document.getElementById('copy-backup-code-button'),
      runBackupButton: document.getElementById('run-backup-button'),
      restoreBackupId: document.getElementById('restore-backup-id'),
      restoreBackupButton: document.getElementById('restore-backup-button'),
    }
  }

  /**
   * 하단바 선택 상태를 바꾼다.
   * @param {Record<string, HTMLElement>} elements
   * @param {string} activeName
   */
  function setActiveBottomNav(elements, activeName) {
    elements.showCalendarButton.classList.toggle('is-active', activeName === 'calendar')
    elements.openSalarySheetButton.classList.toggle('is-active', activeName === 'salary')
    elements.openWorkplaceSheetButton.classList.toggle('is-active', activeName === 'workplace')
  }

  /**
   * 열린 바텀시트를 닫는다.
   * @param {Record<string, HTMLElement>} elements
   */
  function closeSheets(elements) {
    elements.salarySheet.hidden = true
    elements.monthSheet.hidden = true
    elements.workplaceSheet.hidden = true
    elements.sheetBackdrop.hidden = true
    setActiveBottomNav(elements, 'calendar')

    if (state.calendar) {
      state.calendar.updateSize()
    }
  }

  /**
   * 바텀시트를 연다.
   * @param {Record<string, HTMLElement>} elements
   * @param {'salary' | 'month' | 'workplace'} sheetName
   */
  function openSheet(elements, sheetName) {
    elements.salarySheet.hidden = sheetName !== 'salary'
    elements.monthSheet.hidden = sheetName !== 'month'
    elements.workplaceSheet.hidden = sheetName !== 'workplace'
    elements.sheetBackdrop.hidden = false
    setActiveBottomNav(elements, sheetName)

    if (sheetName === 'salary') {
      ensureSalaryRange(elements)
      renderSalaryCalculation(elements)
    }

    if (sheetName === 'month') {
      syncMonthPickerWithCalendar(elements)
    }
  }

  /**
   * FullCalendar 제목을 선택 가능한 컨트롤로 보강한다.
   */
  function enhanceCalendarTitle() {
    const title = document.querySelector('#calendar .fc-toolbar-title')
    if (!title) return

    title.setAttribute('role', 'button')
    title.setAttribute('tabindex', '0')
    title.setAttribute('title', '월 선택')
  }

  /**
   * 월 선택 UI를 다시 그린다.
   * @param {Record<string, HTMLElement>} elements
   */
  function renderMonthPicker(elements) {
    const currentDate = state.calendar ? state.calendar.getDate() : new Date()
    const currentYear = currentDate.getFullYear()
    const currentMonth = currentDate.getMonth() + 1

    elements.monthPickerYear.textContent = state.monthPickerYear + '년'
    Array.from(elements.monthOptionList.querySelectorAll('button')).forEach(function (button) {
      const month = Number(button.getAttribute('data-month'))
      button.classList.toggle('is-selected', state.monthPickerYear === currentYear && month === currentMonth)
    })
  }

  /**
   * 현재 캘린더 월을 월 선택 UI에 반영한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function syncMonthPickerWithCalendar(elements) {
    const currentDate = state.calendar ? state.calendar.getDate() : new Date()
    state.monthPickerYear = currentDate.getFullYear()
    renderMonthPicker(elements)
  }

  /**
   * 선택한 년월로 이동한다.
   * @param {Record<string, HTMLElement>} elements
   * @param {number} month
   */
  function goToMonth(elements, month) {
    const monthText = String(month).padStart(2, '0')
    state.calendar.gotoDate(state.monthPickerYear + '-' + monthText + '-01')
    closeSheets(elements)
  }

  /**
   * 근무 기록 1건의 지급액을 계산한다.
   * @param {types.WorkLog} log
   * @returns {number}
   */
  function calculateLogPay(log) {
    let totalPay = log.dailyPaySnapshot
    totalPay += log.overtimeHours * log.overtimeHourlyPaySnapshot

    if (log.mealAllowancePaid) {
      totalPay += log.mealAllowanceSnapshot
    }

    return totalPay
  }

  /**
   * 현재 달 범위를 계산한다.
   * @returns {{start: string, end: string}}
   */
  function getCurrentMonthRange() {
    const currentDate = state.calendar ? state.calendar.getDate() : new Date()
    const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0)

    return {
      start: formatDateInput(start),
      end: formatDateInput(end),
    }
  }

  /**
   * 계산 기간 기본값을 채운다.
   * @param {Record<string, HTMLElement>} elements
   */
  function ensureSalaryRange(elements) {
    if (elements.salaryStartDate.value && elements.salaryEndDate.value) return

    const range = getCurrentMonthRange()
    elements.salaryStartDate.value = range.start
    elements.salaryEndDate.value = range.end
  }

  /**
   * 기간 급여 계산 결과를 다시 그린다.
   * @param {Record<string, HTMLElement>} elements
   */
  function renderSalaryCalculation(elements) {
    const startDate = elements.salaryStartDate.value
    const endDate = elements.salaryEndDate.value
    const hasRange = startDate && endDate
    const rangeStart = hasRange && startDate <= endDate ? startDate : endDate
    const rangeEnd = hasRange && startDate <= endDate ? endDate : startDate
    let workDays = 0
    let grossPay = 0

    if (hasRange) {
      state.logsByDate.forEach(function (log) {
        if (log.date < rangeStart || log.date > rangeEnd) return

        workDays += 1
        grossPay += calculateLogPay(log)
      })
    }

    const taxAmount = elements.salaryTaxEnabled.checked ? Math.floor(grossPay * FREELANCER_TAX_RATE) : 0
    const netPay = grossPay - taxAmount

    elements.salaryWorkDays.textContent = workDays + '일'
    elements.salaryGrossPay.textContent = formatCurrency(grossPay)
    elements.salaryTaxAmount.textContent = formatCurrency(taxAmount)
    elements.salaryNetPay.textContent = formatCurrency(netPay)
    elements.salaryFormula.textContent = '세전 ' + formatCurrency(grossPay) + ' - 원천세 ' + formatCurrency(taxAmount) + ' = ' + formatCurrency(netPay)
  }

  /**
   * 근무지 선택지를 다시 그린다.
   * @param {Record<string, HTMLElement>} elements
   */
  function renderWorkplaceSelect(elements) {
    const select = elements.worklogWorkplace
    select.innerHTML = ''

    state.workplaces.forEach(function (workplace) {
      const option = document.createElement('option')
      option.value = workplace.id
      option.textContent = workplace.name
      select.appendChild(option)
    })

    select.disabled = state.workplaces.length === 0
  }

  /**
   * 근무지 목록을 다시 그린다.
   * @param {Record<string, HTMLElement>} elements
   */
  function renderWorkplaceList(elements) {
    elements.workplaceList.innerHTML = ''

    if (state.workplaces.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = '먼저 근무지를 저장하면 달력에 근무 기록을 추가할 수 있습니다.'
      elements.workplaceList.appendChild(empty)
      return
    }

    state.workplaces.forEach(function (workplace) {
      const card = document.createElement('article')
      card.className = 'workplace-card'
      card.dataset.id = workplace.id

      const title = document.createElement('strong')
      title.textContent = workplace.name

      const meta = document.createElement('div')
      meta.className = 'workplace-meta'
      meta.textContent = '일당 ' + formatCurrency(workplace.dailyPay) + ' · 야근 ' + formatCurrency(workplace.overtimeHourlyPay) + '/h · 식대 ' + formatCurrency(workplace.mealAllowance)

      const actions = document.createElement('div')
      actions.className = 'workplace-actions'

      const editButton = document.createElement('button')
      editButton.type = 'button'
      editButton.dataset.action = 'edit'
      editButton.textContent = '수정'

      const deleteButton = document.createElement('button')
      deleteButton.type = 'button'
      deleteButton.dataset.action = 'delete'
      deleteButton.textContent = '삭제'

      actions.append(editButton, deleteButton)
      card.append(title, meta, actions)
      elements.workplaceList.appendChild(card)
    })
  }

  /**
   * 근무지 입력 폼을 비운다.
   * @param {Record<string, HTMLElement>} elements
   */
  function resetWorkplaceForm(elements) {
    elements.workplaceId.value = ''
    elements.workplaceName.value = ''
    elements.dailyPay.value = '0'
    elements.overtimeHourlyPay.value = '0'
    elements.mealAllowance.value = '0'
  }

  /**
   * 근무지 수정값을 폼에 넣는다.
   * @param {Record<string, HTMLElement>} elements
   * @param {types.Workplace} workplace
   */
  function fillWorkplaceForm(elements, workplace) {
    elements.workplaceId.value = workplace.id
    elements.workplaceName.value = workplace.name
    elements.dailyPay.value = String(workplace.dailyPay)
    elements.overtimeHourlyPay.value = String(workplace.overtimeHourlyPay)
    elements.mealAllowance.value = String(workplace.mealAllowance)
  }

  /**
   * FullCalendar 이벤트 목록을 만든다.
   * @returns {Array<any>}
   */
  function buildCalendarEvents() {
    return Array.from(state.logsByDate.values()).map(function (log) {
      return {
        id: log.date,
        title: log.workplaceNameSnapshot,
        start: log.date,
        allDay: true,
        extendedProps: {
          overtimeHours: log.overtimeHours,
          workplaceName: log.workplaceNameSnapshot,
        },
      }
    })
  }

  /**
   * 근무 기록 이벤트 내용을 그린다.
   * @param {any} info FullCalendar 이벤트 정보
   * @returns {{domNodes: HTMLElement[]}}
   */
  function renderWorkLogEvent(info) {
    const content = document.createElement('div')
    const title = document.createElement('span')
    const overtimeHours = Number(info.event.extendedProps.overtimeHours || 0)

    content.className = 'worklog-event-content'
    title.className = 'worklog-event-title'
    title.textContent = info.event.extendedProps.workplaceName || info.event.title
    content.appendChild(title)

    if (overtimeHours > 0) {
      const overtime = document.createElement('span')
      overtime.className = 'worklog-event-overtime'
      overtime.textContent = '+' + overtimeHours + 'h'
      content.appendChild(overtime)
    }

    return { domNodes: [content] }
  }

  /**
   * 달력과 요약을 다시 그린다.
   */
  function refreshCalendar() {
    if (!state.calendar) return

    state.calendar.removeAllEvents()
    state.calendar.addEventSource(buildCalendarEvents())
    renderMonthSummary()
  }

  /**
   * 현재 달 요약을 계산한다.
   */
  function renderMonthSummary() {
    const currentDate = state.calendar.getDate()
    const monthKey = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0')
    let workDays = 0
    let overtimeHours = 0
    let totalPay = 0

    state.logsByDate.forEach(function (log) {
      if (!log.date.startsWith(monthKey)) return

      workDays += 1
      overtimeHours += log.overtimeHours
      totalPay += calculateLogPay(log)
    })

    const elements = getElements()
    elements.summaryDays.textContent = workDays + '일'
    elements.summaryOvertime.textContent = overtimeHours + '시간'
    elements.summaryPay.textContent = formatCurrency(totalPay)
  }

  /**
   * JSON API 요청을 보낸다.
   * @param {string} url 요청 URL
   * @param {Record<string, any>} payload 요청 데이터
   * @returns {Promise<Record<string, any>>}
   */
  function requestJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).then(function (response) {
      return response.json().then(function (result) {
        if (!response.ok || !result.ok) {
          throw new Error(result.message || '요청에 실패했습니다.')
        }

        return result
      })
    })
  }

  /**
   * 백업 상태 문구를 표시한다.
   * @param {Record<string, HTMLElement>} elements
   * @param {string} message 상태 문구
   * @param {'default' | 'success' | 'error'} status 상태 종류
   */
  function setBackupStatus(elements, message, status) {
    elements.backupStatus.textContent = message
    elements.backupStatus.classList.toggle('is-success', status === 'success')
    elements.backupStatus.classList.toggle('is-error', status === 'error')
  }

  /**
   * 백업 메타 정보를 저장하고 화면에 반영한다.
   * @param {Record<string, HTMLElement>} elements
   * @param {types.BackupMeta} meta 백업 메타
   * @returns {Promise<void>}
   */
  function saveBackupMeta(elements, meta) {
    state.backupMeta = meta

    return db.saveBackupMeta(meta).then(function () {
      renderBackupPanel(elements)
    })
  }

  /**
   * 백업 메타를 준비한다.
   * @param {Record<string, HTMLElement>} elements
   * @returns {Promise<types.BackupMeta>}
   */
  function ensureBackupMeta(elements) {
    return db.getBackupMeta().then(function (meta) {
      if (meta && meta.backupId) {
        state.backupMeta = meta
        renderBackupPanel(elements)
        return meta
      }

      const nextMeta = {
        backupId: createBackupId(),
        lastBackupAt: '',
        lastRestoreAt: '',
      }

      return saveBackupMeta(elements, nextMeta).then(function () {
        return nextMeta
      })
    })
  }

  /**
   * 백업 영역을 다시 그린다.
   * @param {Record<string, HTMLElement>} elements
   */
  function renderBackupPanel(elements) {
    const meta = state.backupMeta || {}
    const lastBackupAt = String(meta.lastBackupAt || '')

    elements.backupCode.value = String(meta.backupId || '')

    if (!navigator.onLine) {
      setBackupStatus(elements, '오프라인입니다. 온라인에서 앱을 열면 백업을 시도합니다.', 'default')
      return
    }

    setBackupStatus(elements, '마지막 백업: ' + formatDateTimeLabel(lastBackupAt), lastBackupAt ? 'success' : 'default')
  }

  /**
   * 하루 백업이 필요한지 확인한다.
   * @param {types.BackupMeta} meta 백업 메타
   * @returns {boolean}
   */
  function shouldRunDailyBackup(meta) {
    if (!meta || !meta.lastBackupAt) return true

    const lastBackupTime = new Date(meta.lastBackupAt).getTime()
    return !lastBackupTime || Date.now() - lastBackupTime >= BACKUP_INTERVAL_MS
  }

  /**
   * 전체 데이터를 서버에 백업한다.
   * @param {Record<string, HTMLElement>} elements
   * @param {boolean} force 강제 실행 여부
   * @returns {Promise<void>}
   */
  function runBackup(elements, force) {
    if (state.backupRunning) return Promise.resolve()

    return ensureBackupMeta(elements).then(function (meta) {
      if (!navigator.onLine) {
        setBackupStatus(elements, '오프라인이라 백업하지 못했습니다.', 'error')
        return
      }

      if (!force && !shouldRunDailyBackup(meta)) {
        renderBackupPanel(elements)
        return
      }

      state.backupRunning = true
      elements.runBackupButton.disabled = true
      setBackupStatus(elements, '백업 중입니다.', 'default')

      return db
        .exportBackupData()
        .then(function (backup) {
          backup.backupId = meta.backupId
          return requestJson('/api/backup/save', {
            backupId: meta.backupId,
            payload: backup,
          })
        })
        .then(function (result) {
          return saveBackupMeta(elements, {
            backupId: meta.backupId,
            lastBackupAt: String(result.savedAt || nowIso()),
            lastRestoreAt: String(meta.lastRestoreAt || ''),
          })
        })
        .then(function () {
          setBackupStatus(elements, '백업 완료: ' + formatDateTimeLabel(state.backupMeta.lastBackupAt), 'success')
        })
        .catch(function (exception) {
          setBackupStatus(elements, String(exception.message || exception) || '백업에 실패했습니다.', 'error')
        })
        .then(function () {
          state.backupRunning = false
          elements.runBackupButton.disabled = false
        })
    })
  }

  /**
   * 서버 백업을 로컬 DB로 복구한다.
   * @param {Record<string, HTMLElement>} elements
   * @returns {Promise<void>}
   */
  function restoreBackup(elements) {
    const backupId = elements.restoreBackupId.value.trim()

    if (!backupId) {
      setBackupStatus(elements, '복구 코드를 입력해주세요.', 'error')
      return Promise.resolve()
    }

    if (!window.confirm('현재 로컬 데이터를 백업 데이터로 교체하시겠습니까?')) {
      return Promise.resolve()
    }

    elements.restoreBackupButton.disabled = true
    setBackupStatus(elements, '복구 중입니다.', 'default')

    return requestJson('/api/backup/restore', {
      backupId: backupId,
    })
      .then(function (result) {
        return db.importBackupData(result.payload).then(function () {
          return saveBackupMeta(elements, {
            backupId: backupId,
            lastBackupAt: String(result.updated || ''),
            lastRestoreAt: nowIso(),
          })
        })
      })
      .then(function () {
        elements.restoreBackupId.value = ''
        return reloadState(elements)
      })
      .then(function () {
        setBackupStatus(elements, '복구 완료: ' + formatDateTimeLabel(state.backupMeta.lastRestoreAt), 'success')
      })
      .catch(function (exception) {
        setBackupStatus(elements, String(exception.message || exception) || '복구에 실패했습니다.', 'error')
      })
      .then(function () {
        elements.restoreBackupButton.disabled = false
      })
  }

  /**
   * 근무 기록 팝업을 연다.
   * @param {Record<string, HTMLElement>} elements
   * @param {string} date
   */
  function openWorkLogDialog(elements, date) {
    if (state.workplaces.length === 0) {
      window.alert('근무지를 먼저 입력해주세요.')
      return
    }

    const existingLog = state.logsByDate.get(date)
    const firstWorkplace = state.workplaces[0]
    const workplace = existingLog
      ? state.workplaces.find(function (item) {
          return item.id === existingLog.workplaceId
        }) || firstWorkplace
      : firstWorkplace

    elements.worklogDate.value = date
    elements.worklogDateLabel.textContent = formatDateLabel(date)
    elements.worklogWorkplace.value = workplace.id
    elements.worklogOvertimeHours.value = existingLog ? String(existingLog.overtimeHours) : '0'
    elements.worklogMealAllowancePaid.checked = existingLog ? existingLog.mealAllowancePaid : workplace.mealAllowance > 0
    elements.deleteWorklogButton.hidden = !existingLog
    elements.worklogDialog.showModal()
  }

  /**
   * 앱 상태를 IndexedDB에서 다시 읽는다.
   * @param {Record<string, HTMLElement>} elements
   * @returns {Promise<void>}
   */
  function reloadState(elements) {
    return Promise.all([db.listWorkplaces(), db.listWorkLogs()]).then(function (results) {
      state.workplaces = results[0]
      state.logsByDate = new Map(
        results[1].map(function (log) {
          return [log.date, log]
        })
      )

      renderWorkplaceSelect(elements)
      renderWorkplaceList(elements)
      refreshCalendar()
      renderSalaryCalculation(elements)
    })
  }

  /**
   * 근무지 저장 이벤트를 연결한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindWorkplaceForm(elements) {
    elements.workplaceForm.addEventListener('submit', function (event) {
      event.preventDefault()

      const now = nowIso()
      const existing = state.workplaces.find(function (workplace) {
        return workplace.id === elements.workplaceId.value
      })
      const mealAllowance = toNumber(elements.mealAllowance.value)
      const workplace = {
        id: existing ? existing.id : createId('wp'),
        name: elements.workplaceName.value.trim(),
        dailyPay: toNumber(elements.dailyPay.value),
        overtimeHourlyPay: toNumber(elements.overtimeHourlyPay.value),
        mealAllowance: mealAllowance,
        defaultMealAllowancePaid: mealAllowance > 0,
        memo: existing ? existing.memo || '' : '',
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      }

      if (!workplace.name) return

      db.saveWorkplace(workplace).then(function () {
        resetWorkplaceForm(elements)
        reloadState(elements)
      })
    })

    elements.resetWorkplaceButton.addEventListener('click', function () {
      resetWorkplaceForm(elements)
    })

    elements.workplaceList.addEventListener('click', function (event) {
      const button = event.target.closest('button')
      const card = event.target.closest('.workplace-card')
      if (!button || !card) return

      const workplace = state.workplaces.find(function (item) {
        return item.id === card.dataset.id
      })
      if (!workplace) return

      if (button.dataset.action === 'edit') {
        fillWorkplaceForm(elements, workplace)
        openSheet(elements, 'workplace')
        return
      }

      if (button.dataset.action === 'delete') {
        if (!window.confirm('근무지를 삭제하시겠습니까?')) return

        db.deleteWorkplace(workplace.id).then(function () {
          reloadState(elements)
        })
      }
    })
  }

  /**
   * 하단바와 바텀시트 이벤트를 연결한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindBottomSheets(elements) {
    elements.showCalendarButton.addEventListener('click', function () {
      closeSheets(elements)
    })

    elements.openSalarySheetButton.addEventListener('click', function () {
      openSheet(elements, 'salary')
    })

    elements.openWorkplaceSheetButton.addEventListener('click', function () {
      openSheet(elements, 'workplace')
    })

    elements.closeSalarySheetButton.addEventListener('click', function () {
      closeSheets(elements)
    })

    elements.closeWorkplaceSheetButton.addEventListener('click', function () {
      closeSheets(elements)
    })

    elements.sheetBackdrop.addEventListener('click', function () {
      closeSheets(elements)
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeSheets(elements)
      }
    })
  }

  /**
   * 월 선택 이벤트를 연결한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindMonthPicker(elements) {
    elements.calendar.addEventListener('click', function (event) {
      if (event.target.closest('.fc-toolbar-title')) {
        openSheet(elements, 'month')
      }
    })

    elements.calendar.addEventListener('keydown', function (event) {
      if (!event.target.closest('.fc-toolbar-title')) return
      if (event.key !== 'Enter' && event.key !== ' ') return

      event.preventDefault()
      openSheet(elements, 'month')
    })

    elements.closeMonthSheetButton.addEventListener('click', function () {
      closeSheets(elements)
    })

    elements.prevMonthYearButton.addEventListener('click', function () {
      state.monthPickerYear -= 1
      renderMonthPicker(elements)
    })

    elements.nextMonthYearButton.addEventListener('click', function () {
      state.monthPickerYear += 1
      renderMonthPicker(elements)
    })

    elements.monthOptionList.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-month]')
      if (!button) return

      goToMonth(elements, Number(button.getAttribute('data-month')))
    })
  }

  /**
   * 급여 계산 입력 이벤트를 연결한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindSalaryCalculator(elements) {
    elements.salaryStartDate.addEventListener('input', function () {
      renderSalaryCalculation(elements)
    })

    elements.salaryEndDate.addEventListener('input', function () {
      renderSalaryCalculation(elements)
    })

    elements.salaryTaxEnabled.addEventListener('change', function () {
      renderSalaryCalculation(elements)
    })
  }

  /**
   * 근무 기록 저장 이벤트를 연결한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindWorkLogForm(elements) {
    elements.worklogWorkplace.addEventListener('change', function () {
      const workplace = state.workplaces.find(function (item) {
        return item.id === elements.worklogWorkplace.value
      })
      if (!workplace) return

      elements.worklogMealAllowancePaid.checked = workplace.mealAllowance > 0
    })

    elements.closeWorklogButton.addEventListener('click', function () {
      elements.worklogDialog.close()
    })

    elements.deleteWorklogButton.addEventListener('click', function () {
      const date = elements.worklogDate.value
      if (!date) return

      db.deleteWorkLog(date).then(function () {
        elements.worklogDialog.close()
        reloadState(elements)
      })
    })

    elements.worklogForm.addEventListener('submit', function (event) {
      event.preventDefault()

      const date = elements.worklogDate.value
      const workplace = state.workplaces.find(function (item) {
        return item.id === elements.worklogWorkplace.value
      })
      if (!date || !workplace) return

      const existingLog = state.logsByDate.get(date)
      const now = nowIso()
      const workLog = {
        date: date,
        workplaceId: workplace.id,
        workplaceNameSnapshot: workplace.name,
        dailyPaySnapshot: workplace.dailyPay,
        overtimeHourlyPaySnapshot: workplace.overtimeHourlyPay,
        mealAllowanceSnapshot: workplace.mealAllowance,
        overtimeHours: toNumber(elements.worklogOvertimeHours.value),
        mealAllowancePaid: elements.worklogMealAllowancePaid.checked,
        memo: existingLog ? existingLog.memo || '' : '',
        createdAt: existingLog ? existingLog.createdAt : now,
        updatedAt: now,
      }

      db.saveWorkLog(workLog).then(function () {
        elements.worklogDialog.close()
        reloadState(elements)
      })
    })
  }

  /**
   * 백업/복구 이벤트를 연결한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindBackupPanel(elements) {
    elements.runBackupButton.addEventListener('click', function () {
      runBackup(elements, true)
    })

    elements.restoreBackupButton.addEventListener('click', function () {
      restoreBackup(elements)
    })

    elements.copyBackupCodeButton.addEventListener('click', function () {
      const backupId = elements.backupCode.value
      if (!backupId) return

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(backupId).then(function () {
          setBackupStatus(elements, '복구 코드를 복사했습니다.', 'success')
        })
        return
      }

      elements.backupCode.select()
      document.execCommand('copy')
      setBackupStatus(elements, '복구 코드를 복사했습니다.', 'success')
    })

    window.addEventListener('online', function () {
      renderBackupPanel(elements)
      runBackup(elements, false)
    })

    window.addEventListener('offline', function () {
      renderBackupPanel(elements)
    })
  }

  /**
   * 백업 상태를 준비하고 필요한 경우 하루 1회 백업을 실행한다.
   * @param {Record<string, HTMLElement>} elements
   * @returns {Promise<void>}
   */
  function initBackup(elements) {
    return ensureBackupMeta(elements).then(function () {
      return runBackup(elements, false)
    })
  }

  /**
   * 터치 스크롤 중 발생한 날짜 클릭을 무시한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function bindCalendarTouchGuard(elements) {
    elements.calendar.addEventListener(
      'touchstart',
      function (event) {
        if (!event.touches || event.touches.length === 0) return

        state.touchMoved = false
        state.touchStartY = event.touches[0].clientY
      },
      { passive: true }
    )

    elements.calendar.addEventListener(
      'touchmove',
      function (event) {
        if (!event.touches || event.touches.length === 0) return

        if (Math.abs(event.touches[0].clientY - state.touchStartY) > TOUCH_SCROLL_THRESHOLD) {
          state.touchMoved = true
        }
      },
      { passive: true }
    )
  }

  /**
   * 터치 스크롤 직후 클릭 여부를 확인한다.
   * @returns {boolean}
   */
  function shouldIgnoreCalendarClick() {
    if (!state.touchMoved) return false

    state.touchMoved = false
    return true
  }

  /**
   * FullCalendar를 시작한다.
   * @param {Record<string, HTMLElement>} elements
   */
  function initCalendar(elements) {
    state.calendar = new FullCalendar.Calendar(elements.calendar, {
      initialView: 'dayGridMonth',
      locale: 'ko',
      height: 'auto',
      contentHeight: 'auto',
      fixedWeekCount: true,
      expandRows: false,
      dayMaxEvents: 2,
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: '',
      },
      buttonText: {
        today: '오늘',
      },
      dateClick: function (info) {
        if (shouldIgnoreCalendarClick()) return

        openWorkLogDialog(elements, info.dateStr)
      },
      eventClick: function (info) {
        if (shouldIgnoreCalendarClick()) return

        openWorkLogDialog(elements, info.event.startStr)
      },
      eventContent: renderWorkLogEvent,
      datesSet: function () {
        renderMonthSummary()
        enhanceCalendarTitle()
      },
    })

    state.calendar.render()
  }

  document.addEventListener('DOMContentLoaded', function () {
    const elements = getElements()
    bindBottomSheets(elements)
    bindSalaryCalculator(elements)
    bindMonthPicker(elements)
    bindWorkplaceForm(elements)
    bindWorkLogForm(elements)
    bindBackupPanel(elements)
    bindCalendarTouchGuard(elements)
    initCalendar(elements)
    reloadState(elements).then(function () {
      initBackup(elements)
    })
  })
})()
