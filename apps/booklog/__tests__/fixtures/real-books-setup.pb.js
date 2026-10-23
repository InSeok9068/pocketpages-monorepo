/* global onBootstrap, routerAdd, require, $app, $os, __hooks, Record, toBytes */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  const user = new Record($app.findCollectionByNameOrId('users'))
  user.set('id', 'realbookuser001')
  user.set('email', 'realbooks@example.com')
  user.set('password', 'test-password-1234')
  user.set('verified', true)
  user.set('booklog_enabled', true)
  user.set('shelf_book_limit', 500)
  $app.save(user)
})

// 방금 올린 책의 저장 결과와, 오디오북 생성 작업이 쓰는 실제 함수로 나눈 낭독 구간을 돌려줍니다.
routerAdd('GET', '/_test/real-books/latest', function (event) {
  const audioData = require(__hooks + '/pages/_private/book-audio-data.js')
  const fflate = require('fflate')
  const shelf = $app.findRecordsByFilter('book_shelves', 'user_id = {:userId}', '-created', 1, 0, {
    userId: 'realbookuser001',
  })[0]
  if (!shelf) return event.json(404, { message: 'no shelf' })
  const book = $app.findRecordById('books', shelf.get('book_id'))
  const file = $app.findRecordById('book_files', shelf.get('book_file_id'))

  const startedAt = Date.now()
  let sections = []
  let audioError = ''
  try {
    sections = audioData.readBookSections($app, file, toBytes)
  } catch (exception) {
    audioError = String(exception && exception.message ? exception.message : exception)
  }
  const audioMs = Date.now() - startedAt

  const spine = []
  let readError = ''
  try {
    const fsys = $app.newFilesystem()
    const reader = fsys.getReader(String(file.baseFilesPath()) + '/' + String(file.get('stored_file')))
    const bytes = new Uint8Array(toBytes(reader, Number(file.get('file_size'))))
    reader.close()
    fsys.close()
    const textEntries = fflate.unzipSync(bytes, {
      filter: function (entry) {
        return /\.(opf|xml|xhtml|html|htm)$/i.test(entry.name) && entry.originalSize <= 16 * 1024 * 1024
      },
    })
    const container = toString(textEntries['META-INF/container.xml'] || [])
    const opfPath = (container.match(/full-path\s*=\s*["']([^"']+)["']/) || [])[1] || ''
    const opf = toString(textEntries[opfPath] || [])
    const baseDir = opfPath.indexOf('/') >= 0 ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
    const hrefById = {}
    ;(opf.match(/<(?:\w+:)?item\b[^>]*>/g) || []).forEach(function (tag) {
      const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/) || [])[1]
      const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/) || [])[1]
      if (id && href) hrefById[id] = href
    })
    ;(opf.match(/<(?:\w+:)?itemref\b[^>]*>/g) || []).forEach(function (tag) {
      const idref = (tag.match(/\bidref\s*=\s*["']([^"']+)["']/) || [])[1]
      const href = hrefById[idref] || ''
      let path = baseDir + href.split('#')[0]
      try {
        if (!textEntries[path]) path = baseDir + decodeURIComponent(href.split('#')[0])
      } catch (exception) {
        // 잘못 인코딩된 이름은 그대로 두고 원래 경로로 찾습니다.
        $app.logger().debug('test/real-books:href-decode-skipped', 'href', href, 'error', String(exception))
      }
      const html = textEntries[path] ? toString(textEntries[path]) : ''
      const text = html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      spine.push({ href: href, chars: text.replace(/\s/g, '').length, sample: text.slice(0, 50) })
    })
  } catch (exception) {
    readError = String(exception && exception.message ? exception.message : exception)
  }

  const narrated = {}
  sections.forEach(function (section) {
    narrated[section.sectionIndex] = section
  })
  const chunkLengths = []
  sections.forEach(function (section) {
    section.chunks.forEach(function (chunk) {
      chunkLengths.push(chunk.length)
    })
  })

  return event.json(200, {
    book: {
      title: book.get('title'),
      author: book.get('author'),
      publisher: book.get('publisher'),
      isbn13: book.get('isbn13'),
      pages: book.get('estimated_page_count'),
    },
    file: {
      size: file.get('file_size'),
      textChars: file.get('text_char_count'),
      chapters: file.get('chapter_count'),
      language: file.get('language_code'),
      epubVersion: file.get('epub_version'),
    },
    audio: {
      ms: audioMs,
      error: audioError,
      sectionCount: sections.length,
      emptySections: sections.filter(function (section) {
        return (
          !section.chunks.length
          || section.chunks.every(function (chunk) {
            return !String(chunk).trim()
          })
        )
      }).length,
      chunkCount: chunkLengths.length,
      shortChunks: chunkLengths.filter(function (length) {
        return length < 20
      }).length,
      longestChunk: chunkLengths.length ? Math.max.apply(null, chunkLengths) : 0,
    },
    spine: spine.map(function (item, index) {
      return {
        href: item.href,
        chars: item.chars,
        narrated: !!narrated[index],
        chunks: narrated[index] ? narrated[index].chunks.length : 0,
        sample: item.sample,
      }
    }),
    readError: readError,
  })
})
