/*
 * Safe EJS + Tailwind Prettier bridge for this repo.
 * It preserves raw <% ... %> content while reusing Tailwind's parser wrappers.
 */

import prettier from 'prettier'
import * as htmlPlugin from 'prettier/plugins/html'
import * as tailwindPlugin from 'prettier-plugin-tailwindcss'

const basePrinter = htmlPlugin.printers.html
const tailwindHtmlParser = tailwindPlugin.parsers.html
// Preserve all standard EJS tag families as raw text:
// <% %>, <%_ %>, <%= %>, <%- %>, <%# %>, <%% %>, -%>, _%>
const EJS_TAG_PATTERN = /<%(?:[%=_#-])?[\s\S]*?(?:[-_])?%>/g
const BLOCK_TOKEN_PREFIX = '__PP_EJS_BLOCK_'
const INLINE_TOKEN_PREFIX = '__PP_EJS_INLINE_'
const INDENT = '  '

function buildJsFormatOptions(options, parser, overrides = {}) {
  return {
    parser,
    printWidth: options.printWidth,
    singleQuote: options.singleQuote,
    trailingComma: options.trailingComma,
    semi: options.semi,
    bracketSpacing: options.bracketSpacing,
    quoteProps: options.quoteProps,
    jsxSingleQuote: options.jsxSingleQuote,
    arrowParens: options.arrowParens,
    objectWrap: options.objectWrap,
    ...overrides,
  }
}

function indentBlock(text) {
  return text
    .split('\n')
    .map((line) => (line ? `${INDENT}${line}` : line))
    .join('\n')
}

async function tryFormatScriptlet(body, options) {
  const inner = body.trim()
  if (!inner) {
    return null
  }

  try {
    const formatted = await prettier.format(inner, buildJsFormatOptions(options, 'babel'))

    return formatted.trimEnd()
  } catch {
    return null
  }
}

async function tryFormatExpression(body, options) {
  const inner = body.trim()
  if (!inner) {
    return null
  }

  try {
    const formatted = await prettier.format(
      inner,
      buildJsFormatOptions(options, '__js_expression', { printWidth: 1000 }),
    )

    return formatted.trim()
  } catch {
    return null
  }
}

async function formatEjsTag(match, options) {
  const parts = match.match(/^<%([%=_#-]?)([\s\S]*?)([-_]?)%>$/)
  if (!parts) {
    return match
  }

  const [, openModifier, body, closeModifier] = parts

  if (openModifier === '#' || openModifier === '%') {
    return match
  }

  if (openModifier === '=' || openModifier === '-') {
    const formattedExpression = await tryFormatExpression(body, options)
    if (!formattedExpression) {
      return match
    }

    return `<%${openModifier} ${formattedExpression} ${closeModifier}%>`
  }

  const formattedScriptlet = await tryFormatScriptlet(body, options)
  if (!formattedScriptlet) {
    return match
  }

  if (!formattedScriptlet.includes('\n')) {
    return `<%${openModifier} ${formattedScriptlet} ${closeModifier}%>`
  }

  return `<%${openModifier}\n${indentBlock(formattedScriptlet)}\n${closeModifier}%>`
}

async function formatEjsBodies(text, options) {
  const matches = [...text.matchAll(EJS_TAG_PATTERN)]
  if (matches.length === 0) {
    return text
  }

  const replacements = await Promise.all(matches.map(([match]) => formatEjsTag(match, options)))
  let lastIndex = 0
  let result = ''

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const offset = match.index ?? 0
    result += text.slice(lastIndex, offset)
    result += replacements[index]
    lastIndex = offset + match[0].length
  }

  result += text.slice(lastIndex)
  return result
}

function isStandaloneTag(text, offset, match) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const nextNewline = text.indexOf('\n', offset + match.length)
  const lineEnd = nextNewline === -1 ? text.length : nextNewline
  const before = text.slice(lineStart, offset)
  const after = text.slice(offset + match.length, lineEnd)

  return /^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)
}

function tokenizeEjs(text) {
  const entries = []
  const preparedText = text.replace(EJS_TAG_PATTERN, (match, offset, sourceText) => {
    const index = String(entries.length).padStart(4, '0')
    const token = isStandaloneTag(sourceText, offset, match)
      ? `<!--${BLOCK_TOKEN_PREFIX}${index}__-->`
      : `${INLINE_TOKEN_PREFIX}${index}__`

    entries.push([token, match])
    return token
  })

  return {
    entries,
    preparedText,
  }
}

function restoreTokens(value, entries) {
  if (!entries || entries.length === 0) {
    return value
  }

  if (typeof value === 'string') {
    let restored = value
    for (const [token, raw] of entries) {
      restored = restored.split(token).join(raw)
    }
    return restored
  }

  if (Array.isArray(value)) {
    return value.map((item) => restoreTokens(item, entries))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const restored = {}
  for (const [key, item] of Object.entries(value)) {
    restored[key] = restoreTokens(item, entries)
  }
  return restored
}

async function parse(text, options, legacy) {
  const formattedText = await formatEjsBodies(text, options)
  const { entries, preparedText } = tokenizeEjs(formattedText)
  options.__ppEjsTokenEntries = entries
  options.originalText = preparedText
  return tailwindHtmlParser.parse(preparedText, options, legacy)
}

function print(path, options, print) {
  const doc = basePrinter.print(path, options, print)
  const node = path.getValue()

  if (node && node.kind === 'root') {
    return restoreTokens(doc, options.__ppEjsTokenEntries || [])
  }

  return doc
}

export const languages = [
  {
    name: 'EJS',
    parsers: ['html'],
    extensions: ['.ejs'],
  },
]

export const options = tailwindPlugin.options

export const parsers = {
  ...tailwindPlugin.parsers,
  html: {
    ...tailwindHtmlParser,
    parse,
  },
}

export const printers = {
  html: {
    ...basePrinter,
    print,
  },
}
