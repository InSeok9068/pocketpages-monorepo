;(() => {
  const container = document.querySelector('[data-home-section-swiper]')
  if (!container || !window.Swiper) return

  const sectionOrder = ['task', 'purchase', 'grocery', 'storage']
  const initialSection = container.dataset.initialSection
  const initialIndex = Math.max(0, sectionOrder.indexOf(initialSection))
  const tabs = Array.from(document.querySelectorAll('[data-home-section-tab]'))
  const slides = Array.from(container.querySelectorAll('[data-home-section-slide]'))
  let activeIndex = initialIndex

  function syncAddress(section) {
    const activeForm = Array.from(document.querySelectorAll('[data-home-filter-form]')).find(
      (form) => form.elements.section.value === section
    )
    if (!activeForm) return

    const url = new URL(window.location.href)
    url.searchParams.set('section', section)
    url.searchParams.set('status', activeForm.elements.status.value)
    url.searchParams.set('tag', activeForm.elements.tag.value)
    window.history.replaceState(window.history.state, '', url.toString())
  }

  function setActiveSection(index, updateAddress = true) {
    const section = sectionOrder[index]
    if (!section) return
    activeIndex = index

    for (const tab of tabs) {
      const isActive = tab.dataset.homeSectionTab === section
      tab.classList.toggle('is-active', isActive)
      if (isActive) {
        tab.setAttribute('aria-current', 'page')
      } else {
        tab.removeAttribute('aria-current')
      }
    }

    for (const slide of slides) {
      slide.classList.toggle('is-active', slide.dataset.homeSectionSlide === section)
    }

    if (updateAddress) syncAddress(section)
  }

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const tab = event.target.closest('[data-home-section-tab]')
    if (!tab) return

    const index = sectionOrder.indexOf(tab.dataset.homeSectionTab)
    if (index < 0) return

    event.preventDefault()
    if (swiper.realIndex !== index) swiper.slideToLoop(index)
    setActiveSection(index)
  })

  document.addEventListener('change', (event) => {
    if (!(event.target instanceof Element)) return
    const form = event.target.closest('[data-home-filter-form]')
    if (!form || form.elements.section.value !== sectionOrder[activeIndex]) return
    syncAddress(form.elements.section.value)
  })

  container.classList.add('is-ready')
  const swiper = new window.Swiper(container, {
    initialSlide: initialIndex,
    slidesPerView: 1,
    autoHeight: true,
    spaceBetween: 0,
    speed: 220,
    threshold: 12,
    resistanceRatio: 0.65,
    loop: true,
    touchStartPreventDefault: false,
    noSwipingSelector: 'button, input, textarea, select, summary, label',
    on: {
      init(instance) {
        setActiveSection(instance.realIndex, false)
      },
      slideChange(instance) {
        setActiveSection(instance.realIndex)
      },
    },
  })

  document.body.addEventListener('htmx:afterSwap', (event) => {
    if (!event.target.closest('[data-home-section-slide]')) return
    swiper.update()
    swiper.updateAutoHeight(0)
  })
})()
