;(function () {
  const modal = document.querySelector('[data-hp-detail-modal]')
  const title = document.querySelector('[data-hp-detail-modal-title]')
  const body = document.querySelector('[data-hp-detail-modal-body]')
  const closeButton = document.querySelector('[data-hp-detail-modal-close]')
  const buttons = Array.from(document.querySelectorAll('[data-hp-lh-detail-button]'))

  if (!modal || !title || !body || !closeButton || buttons.length === 0) {
    return
  }

  let activeButton = null

  function setBodyStatus(message) {
    body.replaceChildren()

    const status = document.createElement('p')
    status.className = 'hp-detail-modal-status'
    status.textContent = message
    body.appendChild(status)
  }

  function createItem(item) {
    const wrapper = document.createElement('div')
    const label = document.createElement('dt')
    const value = document.createElement('dd')

    label.textContent = item.label || ''

    if (item.url) {
      const link = document.createElement('a')
      link.href = item.url
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.textContent = item.value || item.url
      value.appendChild(link)
    } else {
      value.textContent = item.value || ''
    }

    wrapper.appendChild(label)
    wrapper.appendChild(value)

    return wrapper
  }

  function appendSection(section) {
    if (!section || !Array.isArray(section.items) || section.items.length === 0) {
      return
    }

    const sectionElement = document.createElement('section')
    const heading = document.createElement('h3')
    const list = document.createElement('dl')

    sectionElement.className = 'hp-detail-section'
    heading.textContent = section.title || '상세정보'
    list.className = 'hp-detail-grid'

    for (let index = 0; index < section.items.length; index += 1) {
      list.appendChild(createItem(section.items[index]))
    }

    sectionElement.appendChild(heading)
    sectionElement.appendChild(list)
    body.appendChild(sectionElement)
  }

  function appendFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return
    }

    appendSection({
      title: '첨부파일',
      items: files,
    })
  }

  function appendContent(content) {
    if (!content) {
      return
    }

    const sectionElement = document.createElement('section')
    const heading = document.createElement('h3')
    const paragraph = document.createElement('p')

    sectionElement.className = 'hp-detail-section'
    heading.textContent = '공고 내용'
    paragraph.className = 'hp-detail-content'
    paragraph.textContent = content

    sectionElement.appendChild(heading)
    sectionElement.appendChild(paragraph)
    body.appendChild(sectionElement)
  }

  function renderDetail(detail) {
    body.replaceChildren()

    const sections = Array.isArray(detail && detail.sections) ? detail.sections : []

    for (let index = 0; index < sections.length; index += 1) {
      appendSection(sections[index])
    }

    appendFiles(detail && detail.files)
    appendContent(detail && detail.content)

    if (!body.children.length) {
      setBodyStatus('표시할 상세정보가 없습니다. 공식 공고문을 확인해주세요.')
    }
  }

  function openModal(button) {
    activeButton = button
    title.textContent = button.getAttribute('data-notice-title') || '공고 상세'
    setBodyStatus('상세정보를 불러오는 중입니다.')
    modal.hidden = false
    document.body.classList.add('hp-modal-open')
    closeButton.focus()
  }

  function closeModal() {
    modal.hidden = true
    document.body.classList.remove('hp-modal-open')

    if (activeButton) {
      activeButton.focus()
    }
  }

  function buildDetailUrl(button) {
    const params = new URLSearchParams()

    params.set('panId', button.getAttribute('data-pan-id') || '')
    params.set('splInfTpCd', button.getAttribute('data-spl-inf-tp-cd') || '')
    params.set('ccrCnntSysDsCd', button.getAttribute('data-ccr-cnnt-sys-ds-cd') || '')
    params.set('uppAisTpCd', button.getAttribute('data-upp-ais-tp-cd') || '')
    params.set('aisTpCd', button.getAttribute('data-ais-tp-cd') || '')

    return '/api/lh-notice-detail?' + params.toString()
  }

  async function loadDetail(button) {
    openModal(button)

    try {
      const response = await fetch(buildDetailUrl(button), {
        headers: {
          Accept: 'application/json',
        },
      })
      const payload = await response.json()

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || '상세정보를 불러오지 못했습니다.')
      }

      renderDetail(payload.detail || {})
    } catch (exception) {
      setBodyStatus(exception && exception.message ? exception.message : '상세정보를 불러오지 못했습니다.')
    }
  }

  for (let index = 0; index < buttons.length; index += 1) {
    buttons[index].addEventListener('click', function () {
      loadDetail(buttons[index])
    })
  }

  closeButton.addEventListener('click', closeModal)

  modal.addEventListener('click', function (event) {
    if (event.target === modal) {
      closeModal()
    }
  })

  document.addEventListener('keydown', function (event) {
    if (!modal.hidden && event.key === 'Escape') {
      closeModal()
    }
  })
})()
