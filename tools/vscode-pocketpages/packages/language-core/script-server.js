'use strict'

const SERVER_SCRIPT_RE = /<script\b(?=[^>]*\bserver\b)[^>]*>([\s\S]*?)<\/script>/gi

function extractServerBlocks(text) {
  const blocks = []
  let match

  while ((match = SERVER_SCRIPT_RE.exec(text)) !== null) {
    const fullMatch = match[0]
    const content = match[1]
    const matchStart = match.index
    const openTagLength = fullMatch.indexOf('>') + 1
    const contentStart = matchStart + openTagLength
    const contentEnd = contentStart + content.length

    blocks.push({
      index: blocks.length,
      fullStart: matchStart,
      fullEnd: matchStart + fullMatch.length,
      contentStart,
      contentEnd,
      content,
    })
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
