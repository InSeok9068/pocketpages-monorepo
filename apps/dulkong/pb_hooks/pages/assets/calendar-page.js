;(function (global) {
  'use strict'

  function parseCalendarEvents(root) {
    try {
      return JSON.parse(root.dataset.calendarEvents || '[]')
    } catch (error) {
      console.warn('Dulkong calendar data could not be parsed', error)
      return []
    }
  }

  function localDateText(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return date.getFullYear() + '-' + month + '-' + day
  }

  function todayDateText() {
    return localDateText(new Date())
  }

  function koreanDateLabel(dateText) {
    const parts = String(dateText || '').split('-')
    if (parts.length !== 3) return dateText
    return Number(parts[1]) + '월 ' + Number(parts[2]) + '일'
  }

  function eventOccursOn(event, dateText) {
    const details = event.extendedProps || {}
    const startDate = String(details.startDate || event.start || '').slice(0, 10)
    const endDate = String(details.endDate || startDate).slice(0, 10)
    return startDate <= dateText && dateText <= endDate
  }

  function setModalOpen(modal, open) {
    modal.hidden = !open
    document.body.style.overflow = open ? 'hidden' : ''
  }

  function setFormValue(form, name, value) {
    const field = form.elements.namedItem(name)
    if (field) field.value = value || ''
  }

  function patchPlanSignals(plan) {
    if (!global.patchSignals) return

    global.patchSignals({
      planId: plan.id || '',
      planTitle: plan.title || '',
      planKind: plan.kind || 'date',
      planStartDate: plan.startDate || '',
      planEndDate: plan.endDate || '',
      planStartTime: plan.startTime || '',
      planLocationName: plan.locationName || '',
      planNote: plan.note || '',
    })
  }

  function openCreateModal(modal, form, deleteForm, selectedDate) {
    form.reset()
    patchPlanSignals({
      startDate: selectedDate || todayDateText(),
    })
    setFormValue(form, 'planId', '')
    setFormValue(form, 'startDate', selectedDate || todayDateText())
    deleteForm.hidden = true
    document.getElementById('plan-modal-kicker').textContent = '새 약속'
    document.getElementById('plan-modal-title').textContent = '우리의 약속 추가'
    document.getElementById('plan-submit-label').textContent = '약속 저장하기'
    setModalOpen(modal, true)
  }

  function openEditModal(modal, form, deleteForm, plan) {
    patchPlanSignals(plan)
    setFormValue(form, 'planId', plan.id)
    setFormValue(form, 'title', plan.title)
    setFormValue(form, 'kind', plan.kind)
    setFormValue(form, 'startDate', plan.startDate)
    setFormValue(form, 'endDate', plan.endDate)
    setFormValue(form, 'startTime', plan.startTime)
    setFormValue(form, 'locationName', plan.locationName)
    setFormValue(form, 'note', plan.note)
    setFormValue(deleteForm, 'planId', plan.id)
    deleteForm.hidden = false
    document.getElementById('plan-modal-kicker').textContent = '약속 다듬기'
    document.getElementById('plan-modal-title').textContent = '약속 정보 수정'
    document.getElementById('plan-submit-label').textContent = '수정 내용 저장'
    setModalOpen(modal, true)
  }

  function createSelectedItem(event, openPlan) {
    const details = event.extendedProps || {}
    const isAnniversary = details.sourceKind === 'anniversary'
    const item = document.createElement(isAnniversary ? 'div' : 'button')
    const icon = document.createElement('span')
    const content = document.createElement('span')
    const title = document.createElement('strong')
    const meta = document.createElement('span')

    if (!isAnniversary) item.type = 'button'
    item.className = 'calendar-selected-item' + (isAnniversary ? ' is-anniversary' : '')
    icon.className = 'calendar-selected-item__icon'
    icon.textContent = isAnniversary ? details.emoji || '❤️' : details.kindEmoji || '🌿'
    content.className = 'min-w-0 flex-1'
    title.className = 'block truncate text-sm font-bold'
    title.textContent = details.title || event.title
    meta.className = 'mt-1 block truncate text-[11px] text-[#929188]'
    meta.textContent = isAnniversary
      ? '기념일'
      : [details.startTime || '하루 종일', details.locationName].filter(Boolean).join(' · ')

    content.append(title, meta)
    item.append(icon, content)
    if (!isAnniversary) {
      item.addEventListener('click', function () {
        openPlan(details.plan)
      })
    }
    return item
  }

  function renderSelectedDate(root, events, selectedDate, openPlan) {
    const title = document.getElementById('calendar-selected-title')
    const list = document.getElementById('calendar-selected-list')
    if (!title || !list) return

    title.textContent = koreanDateLabel(selectedDate)
    list.replaceChildren()

    const selectedEvents = events.filter(function (event) {
      return eventOccursOn(event, selectedDate)
    })

    if (!selectedEvents.length) {
      const empty = document.createElement('div')
      empty.className = 'calendar-selected-empty'
      empty.textContent = '아직 약속이 없는 날이에요.'
      list.appendChild(empty)
    } else {
      selectedEvents.forEach(function (event) {
        list.appendChild(createSelectedItem(event, openPlan))
      })
    }

    root.querySelectorAll('[data-calendar-date]').forEach(function (cell) {
      cell.classList.toggle('is-selected', cell.dataset.calendarDate === selectedDate)
    })
  }

  /**
   * 약속 달력과 등록·수정 모달을 초기화합니다.
   */
  function initCalendarPage() {
    const root = document.getElementById('couple-calendar')
    const modal = document.getElementById('plan-modal')
    const form = document.getElementById('plan-form')
    const deleteForm = document.getElementById('plan-delete-form')
    const addButton = document.getElementById('plan-add-button')
    const calendarApi = global.DulkongFullCalendar
    if (!root || !modal || !form || !deleteForm || !addButton || !calendarApi) return
    if (root.dataset.calendarInitialized === 'true') return
    root.dataset.calendarInitialized = 'true'

    if (global.dulkongCalendarInstance) global.dulkongCalendarInstance.destroy()

    const events = parseCalendarEvents(root)
    let selectedDate = todayDateText()

    function openPlan(plan) {
      openEditModal(modal, form, deleteForm, plan)
    }

    const calendar = new calendarApi.Calendar(root, {
      plugins: [calendarApi.dayGridPlugin, calendarApi.interactionPlugin],
      initialView: 'dayGridMonth',
      locale: 'ko',
      headerToolbar: { left: 'prev', center: 'title', right: 'next' },
      height: 'auto',
      fixedWeekCount: false,
      showNonCurrentDates: true,
      dayMaxEvents: 3,
      displayEventTime: false,
      borderless: true,
      events: events,
      toolbarClass: 'couple-calendar-toolbar',
      toolbarTitleClass: 'couple-calendar-title',
      buttonClass: function (info) {
        return 'couple-calendar-button is-' + info.name
      },
      dayHeaderClass: function (info) {
        const classes = ['couple-calendar-day-header']
        const weekday = info.date.getDay()
        if (weekday === 0) classes.push('is-sunday')
        if (weekday === 6) classes.push('is-saturday')
        return classes.join(' ')
      },
      dayCellClass: function (info) {
        const classes = ['couple-calendar-day']
        const weekday = info.date.getDay()
        if (info.isToday) classes.push('is-today')
        if (info.isOther) classes.push('is-other-month')
        if (weekday === 0) classes.push('is-sunday')
        if (weekday === 6) classes.push('is-saturday')
        return classes.join(' ')
      },
      dayCellTopClass: 'couple-calendar-day-number',
      dayCellTopContent: function (info) {
        return String(info.date.getDate())
      },
      dayCellDidMount: function (info) {
        info.el.dataset.calendarDate = localDateText(info.date)
      },
      eventClass: function (info) {
        const details = info.event.extendedProps || {}
        return [
          'couple-calendar-event',
          details.sourceKind === 'anniversary' ? 'is-anniversary' : '',
          details.kind ? 'is-' + details.kind : '',
        ]
          .filter(Boolean)
          .join(' ')
      },
      eventContent: function () {
        const dot = document.createElement('span')
        dot.className = 'couple-calendar-event-dot'
        return { domNodes: [dot] }
      },
      moreLinkClass: 'couple-calendar-more',
      dateClick: function (info) {
        selectedDate = info.dateStr
        renderSelectedDate(root, events, selectedDate, openPlan)
      },
      eventClick: function (info) {
        const details = info.event.extendedProps || {}
        selectedDate = String(details.startDate || '').slice(0, 10)
        renderSelectedDate(root, events, selectedDate, openPlan)
      },
      datesSet: function () {
        renderSelectedDate(root, events, selectedDate, openPlan)
      },
    })

    calendar.render()
    global.dulkongCalendarInstance = calendar

    global.dulkongApplyPlan = function (plan) {
      const existingEvent = calendar.getEventById('plan:' + plan.id)
      const existingIndex = events.findIndex(function (event) {
        return event.id === 'plan:' + plan.id
      })
      const allDay = !plan.startTime
      let eventEnd

      if (allDay && plan.endDate) {
        const endDate = new Date(plan.endDate + 'T12:00:00')
        endDate.setDate(endDate.getDate() + 1)
        eventEnd = localDateText(endDate)
      }

      const calendarEvent = {
        id: 'plan:' + plan.id,
        title: plan.title,
        start: allDay ? plan.startDate : plan.startDate + 'T' + plan.startTime,
        end: eventEnd,
        allDay: allDay,
        extendedProps: {
          sourceKind: 'plan',
          kind: plan.kind,
          kindEmoji: {
            date: '💚',
            trip: '🧳',
            appointment: '🕐',
            other: '🌿',
          }[plan.kind] || '🌿',
          title: plan.title,
          startDate: plan.startDate,
          endDate: plan.endDate,
          startTime: plan.startTime,
          locationName: plan.locationName,
          plan: plan,
        },
      }

      if (existingEvent) existingEvent.remove()
      if (existingIndex >= 0) events.splice(existingIndex, 1, calendarEvent)
      else events.push(calendarEvent)
      calendar.addEvent(calendarEvent)
      selectedDate = plan.startDate
      renderSelectedDate(root, events, selectedDate, openPlan)
      setModalOpen(modal, false)
    }

    global.dulkongDeletePlan = function (planId) {
      const eventId = 'plan:' + planId
      const existingEvent = calendar.getEventById(eventId)
      const existingIndex = events.findIndex(function (event) {
        return event.id === eventId
      })

      if (existingEvent) existingEvent.remove()
      if (existingIndex >= 0) events.splice(existingIndex, 1)
      renderSelectedDate(root, events, selectedDate, openPlan)
      setModalOpen(modal, false)
    }
    renderSelectedDate(root, events, selectedDate, openPlan)

    addButton.addEventListener('click', function () {
      openCreateModal(modal, form, deleteForm, selectedDate)
    })
    modal.querySelectorAll('[data-plan-modal-close]').forEach(function (button) {
      button.addEventListener('click', function () {
        setModalOpen(modal, false)
      })
    })
    modal.addEventListener('click', function (event) {
      if (event.target === modal) setModalOpen(modal, false)
    })
    const observer = new MutationObserver(function () {
      if (document.contains(root)) return
      observer.disconnect()
      calendar.destroy()
      if (global.dulkongCalendarInstance === calendar) global.dulkongCalendarInstance = null
      document.body.style.overflow = ''
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  global.dulkongInitCalendarPage = initCalendarPage
})(window)
