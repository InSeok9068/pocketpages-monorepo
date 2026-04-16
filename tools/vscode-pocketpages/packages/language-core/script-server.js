'use strict'

const SCRIPT_OPEN_TAG = '<script'

function isHtmlNameChar(char) {
  return /[A-Za-z0-9:_-]/.test(String(char || ''))
}

function skipEjsTag(text, startIndex) {
  const closeIndex = String(text || '').indexOf('%>', startIndex + 2)
  if (closeIndex === -1) {
    return text.length
  }

  return closeIndex + 2
}

function findScriptOpenTagEnd(text, startIndex) {
  let quote = ''
  let cursor = startIndex + SCRIPT_OPEN_TAG.length

  while (cursor < text.length) {
    const currentChar = text.charAt(cursor)

    if (quote) {
      if (currentChar === quote) {
        quote = ''
      }
      cursor += 1
      continue
    }

    if (currentChar === '"' || currentChar === "'") {
      quote = currentChar
      cursor += 1
      continue
    }

    if (currentChar === '<' && text.slice(cursor, cursor + 2) === '<%') {
      cursor = skipEjsTag(text, cursor)
      continue
    }

    if (currentChar === '>') {
      return cursor
    }

    cursor += 1
  }

  return -1
}

function findScriptCloseTag(text, startIndex) {
  const sourceText = String(text || '')
  const lowerText = sourceText.toLowerCase()
  let cursor = startIndex

  while (cursor < sourceText.length) {
    const closeStart = lowerText.indexOf('</script', cursor)
    if (closeStart === -1) {
      return null
    }

    const nextChar = sourceText.charAt(closeStart + '</script'.length)
    if (nextChar && isHtmlNameChar(nextChar)) {
      cursor = closeStart + '</script'.length
      continue
    }

    const closeTagEnd = sourceText.indexOf('>', closeStart + '</script'.length)
    if (closeTagEnd === -1) {
      return null
    }

    return {
      start: closeStart,
      end: closeTagEnd + 1,
    }
  }

  return null
}

function skipAttributeValue(text, startIndex) {
  let cursor = startIndex

  while (cursor < text.length && /\s/.test(text.charAt(cursor))) {
    cursor += 1
  }

  if (cursor >= text.length) {
    return cursor
  }

  if (text.slice(cursor, cursor + 2) === '<%') {
    return skipEjsTag(text, cursor)
  }

  const quote = text.charAt(cursor)
  if (quote === '"' || quote === "'") {
    cursor += 1
    while (cursor < text.length) {
      if (text.slice(cursor, cursor + 2) === '<%') {
        cursor = skipEjsTag(text, cursor)
        continue
      }

      if (text.charAt(cursor) === quote) {
        return cursor + 1
      }

      cursor += 1
    }

    return cursor
  }

  while (cursor < text.length) {
    if (text.slice(cursor, cursor + 2) === '<%') {
      cursor = skipEjsTag(text, cursor)
      continue
    }

    const currentChar = text.charAt(cursor)
    if (/\s/.test(currentChar) || currentChar === '>') {
      return cursor
    }

    cursor += 1
  }

  return cursor
}

function hasServerAttribute(attributesText) {
  const text = String(attributesText || '')
  let cursor = 0

  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text.charAt(cursor))) {
      cursor += 1
    }

    if (cursor >= text.length) {
      break
    }

    if (text.slice(cursor, cursor + 2) === '<%') {
      cursor = skipEjsTag(text, cursor)
      continue
    }

    if (text.charAt(cursor) === '/') {
      cursor += 1
      continue
    }

    const nameStart = cursor
    while (cursor < text.length) {
      const currentChar = text.charAt(cursor)
      if (/\s/.test(currentChar) || currentChar === '=' || currentChar === '>' || currentChar === '/') {
        break
      }

      if (text.slice(cursor, cursor + 2) === '<%') {
        break
      }

      cursor += 1
    }

    const name = text.slice(nameStart, cursor).trim().toLowerCase()
    if (!name) {
      cursor += 1
      continue
    }

    if (name === 'server') {
      return true
    }

    while (cursor < text.length && /\s/.test(text.charAt(cursor))) {
      cursor += 1
    }

    if (text.charAt(cursor) === '=') {
      cursor = skipAttributeValue(text, cursor + 1)
    }
  }

  return false
}

function extractServerBlocks(text) {
  const sourceText = String(text || '')
  const blocks = []
  const lowerText = sourceText.toLowerCase()
  let cursor = 0

  while (cursor < sourceText.length) {
    const scriptStart = lowerText.indexOf(SCRIPT_OPEN_TAG, cursor)
    if (scriptStart === -1) {
      break
    }

    const nextChar = sourceText.charAt(scriptStart + SCRIPT_OPEN_TAG.length)
    if (nextChar && isHtmlNameChar(nextChar)) {
      cursor = scriptStart + SCRIPT_OPEN_TAG.length
      continue
    }

    const openTagEnd = findScriptOpenTagEnd(sourceText, scriptStart)
    if (openTagEnd === -1) {
      break
    }

    const attributesText = sourceText.slice(scriptStart + SCRIPT_OPEN_TAG.length, openTagEnd)
    const contentStart = openTagEnd + 1
    const closeTag = findScriptCloseTag(sourceText, contentStart)
    if (!closeTag) {
      break
    }

    if (!hasServerAttribute(attributesText)) {
      cursor = closeTag.end
      continue
    }

    const contentEnd = closeTag.start
    const content = sourceText.slice(contentStart, contentEnd)

    blocks.push({
      index: blocks.length,
      fullStart: scriptStart,
      fullEnd: closeTag.end,
      contentStart,
      contentEnd,
      content,
    })

    cursor = closeTag.end
  }

  return blocks
}

function getServerBlockAtOffset(text, offset) {
  return extractServerBlocks(text).find((block) => offset >= block.contentStart && offset <= block.contentEnd) || null
}

module.exports = {
  extractServerBlocks,
  getServerBlockAtOffset,
}
