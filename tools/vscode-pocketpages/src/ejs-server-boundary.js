'use strict'

const { extractServerBlocks } = require('./script-server')

function getLineIndexAtOffset(text, offset) {
  let lineIndex = 0
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, text.length))

  for (let index = 0; index < safeOffset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineIndex += 1
    }
  }

  return lineIndex
}

function isServerScriptLine(trimmedLine) {
  return /^<script\b/i.test(trimmedLine) && /\bserver\b/i.test(trimmedLine)
}

function findFirstTopLevelScriptletEndOffset(text) {
  const sourceText = String(text || '')
  const firstNonWhitespaceOffset = sourceText.search(/\S/)
  if (firstNonWhitespaceOffset === -1) {
    return -1
  }

  const firstTag = sourceText.slice(firstNonWhitespaceOffset, firstNonWhitespaceOffset + 3)
  if (firstTag !== '<% ' && firstTag !== '<%\r' && firstTag !== '<%\n' && sourceText.slice(firstNonWhitespaceOffset, firstNonWhitespaceOffset + 2) !== '<%') {
    return -1
  }

  const openTagSuffix = sourceText[firstNonWhitespaceOffset + 2] || ''
  if (openTagSuffix === '=' || openTagSuffix === '-' || openTagSuffix === '#') {
    return -1
  }

  const closeTagOffset = sourceText.indexOf('%>', firstNonWhitespaceOffset + 2)
  if (closeTagOffset === -1) {
    return -1
  }

  return closeTagOffset + 2
}

function getNextTemplateLineIndex(text, startOffset) {
  const sourceText = String(text || '')
  const lines = sourceText.split(/\r?\n/)
  const blockEndLineIndex = getLineIndexAtOffset(sourceText, startOffset)

  for (let lineIndex = blockEndLineIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const trimmedLine = lines[lineIndex].trim()
    if (!trimmedLine) {
      continue
    }

    if (isServerScriptLine(trimmedLine)) {
      return null
    }

    return lineIndex
  }

  return null
}

function getServerTemplateBoundaryLineNumbers(text, options) {
  const sourceText = String(text || '')
  const settings = options || {}
  const blocks = extractServerBlocks(sourceText)
  const boundaryLineNumbers = []

  for (const block of blocks) {
    const nextTemplateLineIndex = getNextTemplateLineIndex(sourceText, block.fullEnd)
    if (typeof nextTemplateLineIndex === 'number') {
      boundaryLineNumbers.push(nextTemplateLineIndex)
    }
  }

  if (settings.includeTopLevelPartialSetup) {
    const firstTopLevelScriptletEndOffset = findFirstTopLevelScriptletEndOffset(sourceText)
    if (firstTopLevelScriptletEndOffset !== -1) {
      const nextTemplateLineIndex = getNextTemplateLineIndex(sourceText, firstTopLevelScriptletEndOffset)
      if (typeof nextTemplateLineIndex === 'number') {
        boundaryLineNumbers.push(nextTemplateLineIndex)
      }
    }
  }

  return [...new Set(boundaryLineNumbers)].sort((left, right) => left - right)
}

module.exports = {
  getServerTemplateBoundaryLineNumbers,
}
