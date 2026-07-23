document.addEventListener('alpine:init', function () {
  Alpine.data('appToast', function () {
    return {
      isOpen: false,
      message: '',
      tone: 'info',
      timerId: 0,

      init() {
        const initialMessage = String(this.$el.dataset.initialMessage || '').trim()
        if (!initialMessage) return

        this.showToast({ message: initialMessage })
        this.removeFlashParam()
      },

      destroy() {
        window.clearTimeout(this.timerId)
      },

      showToast(detail) {
        const payload = detail && typeof detail === 'object' ? detail : { message: detail }
        const title = String(payload.title || '').trim()
        const body = String(payload.message || payload.value || '').trim()
        const message = title && body ? title + ' · ' + body : title || body
        if (!message) return

        const duration = Number(payload.duration)
        this.message = message
        this.tone = payload.tone === 'success' || payload.tone === 'error' ? payload.tone : 'info'
        this.isOpen = true

        window.clearTimeout(this.timerId)
        this.timerId = window.setTimeout(
          () => {
            this.isOpen = false
          },
          Number.isFinite(duration) && duration > 0 ? duration : 4000
        )
      },

      closeToast() {
        window.clearTimeout(this.timerId)
        this.isOpen = false
      },

      removeFlashParam() {
        const url = new URL(window.location.href)
        if (!url.searchParams.has('__flash')) return

        url.searchParams.delete('__flash')
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
      },
    }
  })
})
