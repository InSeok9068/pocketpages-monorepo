'use strict'

const { extractServerBlocks } = require('./script-server')

const EJS_TAG_RE = /<%(?![%#])[_=-]?[\s\S]*?[-_]?%>/g

function shouldInsertStatementSeparator(previousBlock, nextBlock) {
  const previousText = String(previousBlock && previousBlock.content || '').trim()
  const nextText = String(nextBlock && nextBlock.content || '').trim()

  if (!previousText || !nextText) {
    return false
  }

  if (
    previousText.endsWith('}') &&
    /^(else\b|catch\b|finally\b|while\b)/.test(nextText)
  ) {
    return false
  }

  return true
}

function needsStatementSeparatorAcrossLines(nextBlock) {
  const nextText = String(nextBlock && nextBlock.content || '').trim()
  return /^(\(|\[|`|\/|\+|-)/.test(nextText)
}

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
  const sourceText = String(text || '')
  const chars = String(text || '')
    .split('')
    .map((char) => (char === '\r' || char === '\n' ? char : ' '))
  const blocks = [...extractServerBlocks(sourceText), ...extractTemplateCodeBlocks(sourceText)].sort((left, right) => left.contentStart - right.contentStart)

  for (const block of blocks) {
    for (let index = block.contentStart; index < block.contentEnd; index += 1) {
      chars[index] = sourceText[index]
    }
  }

  for (let index = 0; index < blocks.length - 1; index += 1) {
    const currentBlock = blocks[index]
    const nextBlock = blocks[index + 1]
    const gapText = sourceText.slice(currentBlock.contentEnd, nextBlock.contentStart)

    if (!gapText || !shouldInsertStatementSeparator(currentBlock, nextBlock)) {
      continue
    }

    if (/[\r\n]/.test(gapText) && !needsStatementSeparatorAcrossLines(nextBlock)) {
      continue
    }

    chars[currentBlock.contentEnd] = ';'
  }

  return chars.join('')
}

module.exports = {
  buildTemplateVirtualText,
  extractTemplateCodeBlocks,
  getTemplateCodeBlockAtOffset,
}
