;(function () {
  function syncBookLinks() {
    if (!['/library', '/reviews', '/highlights'].includes(window.location.pathname)) return

    var from = window.location.pathname + window.location.search

    document.querySelectorAll('a[data-book-detail]').forEach(function (link) {
      var url = new URL(link.href)
      url.searchParams.set('from', from)
      link.href = url.pathname + url.search + url.hash
    })
  }

  syncBookLinks()
  document.addEventListener('htmx:afterSettle', syncBookLinks)

  var review = document.querySelector('textarea[data-review-draft-key]')

  if (review) {
    var key = review.getAttribute('data-review-draft-key')
    var savedText = review.defaultValue.trim()

    try {
      var draft = JSON.parse(window.localStorage.getItem(key) || 'null')

      if (draft && draft.savedText === savedText && draft.text.trim() !== savedText) {
        review.value = draft.text
      } else {
        window.localStorage.removeItem(key)
      }
    } catch (exception) {}

    review.addEventListener('input', function () {
      try {
        if (review.value.trim() === savedText) {
          window.localStorage.removeItem(key)
        } else {
          window.localStorage.setItem(key, JSON.stringify({ savedText: savedText, text: review.value }))
        }
      } catch (exception) {}
    })
  }

  function revealBookSection() {
    var id = window.location.hash.slice(1)

    if (id !== 'book-review' && !/^highlight-[a-z0-9]+$/.test(id)) return

    var target = document.getElementById(id)
    if (!target) return

    target.scrollIntoView({ block: 'start' })
    target.classList.add('booklog-linked-section')
    window.setTimeout(function () {
      target.classList.remove('booklog-linked-section')
    }, 1800)
  }

  window.addEventListener('hashchange', revealBookSection)
  revealBookSection()
})()
