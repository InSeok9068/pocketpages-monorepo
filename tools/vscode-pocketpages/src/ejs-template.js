'use strict'

const { extractServerBlocks } = require('./script-server')

const EJS_TAG_RE = /<%(?![%#])[_=-]?[\s\S]*?[-_]?%>/g

function extractTemplateCodeBlocks(text) {
  const blocks = []
  let match

  while ((match = EJS_TAG_RE.exec(text)) !== null) {
    const fullMatch = match[0]
    const fullStart = match.index
    const fullEnd = fullStart + fullMatch.length

    let contentStart = fullStart + 2
    const openMarker = fullMatch.charAt(2)
    if (openMarker === '_' || openMarker === '=' || openMarker === '-') {
      contentStart += 1
    }

    let contentEnd = fullEnd - 2
    const closeMarker = fullMatch.charAt(fullMatch.length - 3)
    if (closeMarker === '_' || closeMarker === '-') {
      contentEnd -= 1
    }

    if (contentEnd < contentStart) {
      contentEnd = contentStart
    }

    blocks.push({
      index: blocks.length,
      fullStart,
      fullEnd,
      contentStart,
      contentEnd,
      content: text.slice(contentStart, contentEnd),
      kind: 'ejs-tag',
    })
  }

  return blocks
}

function getTemplateCodeBlockAtOffset(text, offset) {
  const allBlocks = [...extractServerBlocks(text), ...extractTemplateCodeBlocks(text)]
  return allBlocks.find((block) => offset >= block.contentStart && offset <= block.contentEnd) || null
}

function buildTemplateVirtualText(text) {
  const chars = String(text || '')
    .split('')
    .map((char) => (char === '\r' || char === '\n' ? char : ' '))

  for (const block of [...extractServerBlocks(text), ...extractTemplateCodeBlocks(text)]) {
    for (let index = block.contentStart; index < block.contentEnd; index += 1) {
      chars[index] = text[index]
    }
  }

  return chars.join('')
}

module.exports = {
  buildTemplateVirtualText,
  extractTemplateCodeBlocks,
  getTemplateCodeBlockAtOffset,
}
