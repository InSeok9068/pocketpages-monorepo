/*
 * Safe EJS + Tailwind Prettier bridge for this repo.
 * It preserves raw <% ... %> content while reusing Tailwind's parser wrappers.
 */

import * as htmlPlugin from 'prettier/plugins/html'
import * as tailwindPlugin from 'prettier-plugin-tailwindcss'

const basePrinter = htmlPlugin.printers.html
const tailwindHtmlParser = tailwindPlugin.parsers.html
// Preserve all standard EJS tag families as raw text:
// <% %>, <%_ %>, <%= %>, <%- %>, <%# %>, <%% %>, -%>, _%>
const EJS_TAG_PATTERN = /<%(?:[%=_#-])?[\s\S]*?(?:[-_])?%>/g
const BLOCK_TOKEN_PREFIX = '__PP_EJS_BLOCK_'
const INLINE_TOKEN_PREFIX = '__PP_EJS_INLINE_'

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

function parse(text, options, legacy) {
  const { entries, preparedText } = tokenizeEjs(text)
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
