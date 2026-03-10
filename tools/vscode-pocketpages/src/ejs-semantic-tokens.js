'use strict'

const ts = require('typescript')
const { extractTemplateCodeBlocks } = require('./ejs-template')

const TOKEN_TYPES = ['keyword', 'string', 'number', 'regexp', 'comment', 'operator']
const TOKEN_TYPE_INDEX = new Map(TOKEN_TYPES.map((name, index) => [name, index]))

function getTokenTypeIndex(name) {
  const value = TOKEN_TYPE_INDEX.get(name)
  return value === undefined ? null : value
}

function classifySyntaxKind(kind) {
  if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) {
    return 'keyword'
  }

  if (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail
  ) {
    return 'string'
  }

  if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) {
    return 'number'
  }

  if (kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return 'regexp'
  }

  if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
    return 'comment'
  }

  return null
}

function collectTokenEntriesFromBlock(block) {
  const tokens = []

  const openDelimiterLength = Math.max(0, block.contentStart - block.fullStart)
  const closeDelimiterLength = Math.max(0, block.fullEnd - block.contentEnd)

  if (openDelimiterLength > 0) {
    tokens.push({
      start: block.fullStart,
      length: openDelimiterLength,
      tokenType: 'operator',
    })
  }

  if (closeDelimiterLength > 0) {
    tokens.push({
      start: block.contentEnd,
      length: closeDelimiterLength,
      tokenType: 'operator',
    })
  }

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, block.content)

  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const tokenType = classifySyntaxKind(kind)
    if (!tokenType) {
      continue
    }

    const tokenStart = block.contentStart + scanner.getTokenPos()
    const tokenLength = scanner.getTextPos() - scanner.getTokenPos()
    if (tokenLength <= 0) {
      continue
    }

    tokens.push({
      start: tokenStart,
      length: tokenLength,
      tokenType,
    })
  }

  return tokens
}

function collectEjsSemanticTokenEntries(documentText) {
  return extractTemplateCodeBlocks(documentText)
    .flatMap((block) => collectTokenEntriesFromBlock(block))
    .sort((left, right) => {
      if (left.start !== right.start) {
        return left.start - right.start
      }

      return left.length - right.length
    })
}

module.exports = {
  TOKEN_TYPES,
  collectEjsSemanticTokenEntries,
  getTokenTypeIndex,
}
