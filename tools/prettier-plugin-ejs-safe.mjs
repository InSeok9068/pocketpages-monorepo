/*
 * Safe EJS + Tailwind Prettier bridge for this repo.
 * It preserves raw <% ... %> content while reusing Tailwind's parser wrappers.
 */

import prettier from 'prettier'
import * as htmlPlugin from 'prettier/plugins/html'
import * as tailwindPlugin from 'prettier-plugin-tailwindcss'

const basePrinter = htmlPlugin.printers.html
const { hardline } = prettier.doc.builders
const tailwindHtmlParser = await tailwindPlugin.parsers.html()
// Preserve all standard EJS tag families as raw text:
// <% %>, <%_ %>, <%= %>, <%- %>, <%# %>, <%% %>, -%>, _%>
const EJS_TAG_PATTERN = /<%(?:[%=_#-])?[\s\S]*?(?:[-_])?%>/g
const BLOCK_TOKEN_PREFIX = '__PP_EJS_BLOCK_'
const INLINE_TOKEN_PREFIX = '__PP_EJS_INLINE_'
const DATASTAR_ACTION_TOKEN_PREFIX = '__PP_DATASTAR_ACTION_'

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
    tabWidth: options.tabWidth,
    useTabs: options.useTabs,
    ...overrides,
  }
}

function getIndent(options) {
  if (options.useTabs) {
    return '\t'
  }

  const tabWidth = Number.isInteger(options.tabWidth) && options.tabWidth > 0 ? options.tabWidth : 2
  return ' '.repeat(tabWidth)
}

function indentBlock(text, options) {
  const indent = getIndent(options)
  return text
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : line))
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

async function tryFormatExpression(body, options, printWidth = 1000) {
  const inner = body.trim()
  if (!inner) {
    return null
  }

  try {
    const formatted = await prettier.format(inner, buildJsFormatOptions(options, '__js_expression', { printWidth }))

    return formatted.trim()
  } catch {
    return null
  }
}

async function formatEjsTag(match, options, expressionPrintWidth = 1000) {
  const parts = match.match(/^<%([%=_#-]?)([\s\S]*?)([-_]?)%>$/)
  if (!parts) {
    return match
  }

  const [, openModifier, body, closeModifier] = parts

  if (openModifier === '#' || openModifier === '%') {
    return match
  }

  if (openModifier === '=' || openModifier === '-') {
    const formattedExpression = await tryFormatExpression(body, options, expressionPrintWidth)
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

  return `<%${openModifier}\n${indentBlock(formattedScriptlet, options)}\n${closeModifier}%>`
}

function isDatastarExpressionAttribute(name) {
  const normalizedName = String(name || '').toLowerCase()

  return (
    normalizedName === 'data-init'
    || normalizedName === 'data-effect'
    || normalizedName === 'data-show'
    || normalizedName === 'data-text'
    || normalizedName === 'data-json-signals'
    || normalizedName.startsWith('data-on:')
    || normalizedName === 'data-signals'
    || normalizedName.startsWith('data-signals:')
    || normalizedName === 'data-computed'
    || normalizedName.startsWith('data-computed:')
    || normalizedName === 'data-class'
    || normalizedName.startsWith('data-class:')
    || normalizedName === 'data-attr'
    || normalizedName.startsWith('data-attr:')
    || normalizedName === 'data-style'
    || normalizedName.startsWith('data-style:')
  )
}

function isDatastarStatementAttribute(name) {
  const normalizedName = String(name || '').toLowerCase()

  return normalizedName === 'data-init' || normalizedName === 'data-effect' || normalizedName.startsWith('data-on:')
}

function tokenizeDatastarActions(value) {
  const entries = []
  const preparedValue = value.replace(/@([A-Za-z_$][\w$]*)\s*(?=\()/g, (match) => {
    const index = String(entries.length).padStart(4, '0')
    const token = `${DATASTAR_ACTION_TOKEN_PREFIX}${index}__`

    entries.push([token, match.trimEnd()])
    return token
  })

  return { entries, preparedValue }
}

function restoreDatastarActions(value, entries) {
  let restored = value

  for (const [token, action] of entries) {
    restored = restored.split(token).join(action)
  }

  return restored
}

async function tryFormatDatastarExpression(name, value, options) {
  const inner = String(value || '').trim()
  if (!inner) {
    return null
  }

  const { entries, preparedValue } = tokenizeDatastarActions(inner)
  const parser = isDatastarStatementAttribute(name) ? 'babel' : '__js_expression'

  try {
    const formatted = await prettier.format(
      preparedValue,
      buildJsFormatOptions(options, parser, {
        printWidth: options.printWidth,
      })
    )

    return restoreDatastarActions(formatted.trim(), entries)
  } catch {
    return null
  }
}

function updateAttributeValue(attribute, value) {
  attribute.value = value

  if (
    Array.isArray(attribute.valueTokens)
    && attribute.valueTokens.length === 1
    && Array.isArray(attribute.valueTokens[0].parts)
    && attribute.valueTokens[0].parts.length === 1
  ) {
    attribute.valueTokens[0].parts[0] = value
  }
}

function indentMultilineAttributeValue(value, attributeIndent, options) {
  if (!value.includes('\n')) {
    return value
  }

  const contentIndent = attributeIndent + getIndent(options)
  const lines = value.split('\n')

  return `\n${lines.map((line) => contentIndent + line).join('\n')}\n${attributeIndent}`
}

function indentInlineEjsEntry(entry, attributeIndent) {
  const raw = entry[1]
  if (entry[2] || !raw.includes('\n')) {
    return
  }

  const lines = raw.split('\n')
  entry[1] =
    lines[0]
    + '\n'
    + lines
      .slice(1)
      .map((line) => attributeIndent + line)
      .join('\n')
}

async function formatAttributeEjsEntries(attribute, attributeIndent, entries, options) {
  for (const entry of entries) {
    const [token, raw, isBlock] = entry
    if (isBlock || !attribute.value.includes(token)) {
      continue
    }

    entry[1] = await formatEjsTag(raw, options, options.printWidth)
    indentInlineEjsEntry(entry, attributeIndent)
  }
}

async function formatDatastarAttributes(node, depth, entries, options) {
  if (!node || typeof node !== 'object') {
    return
  }

  if (node.kind === 'element' && Array.isArray(node.attrs)) {
    const attributeIndent = getIndent(options).repeat(depth + 1)

    for (const attribute of node.attrs) {
      if (!isDatastarExpressionAttribute(attribute.name)) {
        continue
      }

      await formatAttributeEjsEntries(attribute, attributeIndent, entries, options)
      const formatted = await tryFormatDatastarExpression(attribute.name, attribute.value, options)

      if (formatted) {
        updateAttributeValue(attribute, indentMultilineAttributeValue(formatted, attributeIndent, options))
      }
    }
  }

  if (!Array.isArray(node.children)) {
    return
  }

  const childDepth = node.kind === 'element' ? depth + 1 : depth

  for (const child of node.children) {
    await formatDatastarAttributes(child, childDepth, entries, options)
  }
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

function isInsideHtmlTag(text, offset) {
  let insideTag = false
  let quote = ''

  for (let index = 0; index < offset; index += 1) {
    if (text.startsWith('<%', index)) {
      const tagEnd = text.indexOf('%>', index + 2)
      if (tagEnd === -1) {
        return insideTag
      }

      index = tagEnd + 1
      continue
    }

    if (!insideTag && text.startsWith('<!--', index)) {
      const commentEnd = text.indexOf('-->', index + 4)
      if (commentEnd === -1) {
        return false
      }

      index = commentEnd + 2
      continue
    }

    const character = text[index]

    if (!insideTag) {
      if (character === '<' && /[A-Za-z!/?]/.test(text[index + 1] || '')) {
        insideTag = true
      }
      continue
    }

    if (quote) {
      if (character === quote) {
        quote = ''
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      insideTag = false
    }
  }

  return insideTag
}

function isStandaloneTag(text, offset, match) {
  // An EJS expression can occupy its own line while still being an HTML
  // attribute (for example, a conditional `checked` or `selected`). Treating
  // it as a block would insert an HTML comment inside the opening tag and make
  // the document invalid for Prettier's HTML parser.
  if (isInsideHtmlTag(text, offset)) {
    return false
  }

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
    const isBlock = isStandaloneTag(sourceText, offset, match)
    const token = isBlock ? `<!--${BLOCK_TOKEN_PREFIX}${index}__-->` : `${INLINE_TOKEN_PREFIX}${index}__`

    entries.push([token, match, isBlock])
    return token
  })

  return {
    entries,
    preparedText,
  }
}

function rawBlockToDoc(raw) {
  const lines = raw.split('\n')
  const doc = []

  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      doc.push(hardline)
    }

    doc.push(lines[index])
  }

  return doc
}

function restoreStringToken(value, entries) {
  let selectedEntry = null
  let selectedOffset = -1

  for (const entry of entries) {
    const [token] = entry
    const offset = value.indexOf(token)

    if (offset !== -1 && (selectedOffset === -1 || offset < selectedOffset)) {
      selectedEntry = entry
      selectedOffset = offset
    }
  }

  if (!selectedEntry) {
    return value
  }

  const [token, raw, isBlock] = selectedEntry
  const before = value.slice(0, selectedOffset)
  const after = value.slice(selectedOffset + token.length)
  const replacement = isBlock && raw.includes('\n') ? rawBlockToDoc(raw) : raw
  const restoredAfter = restoreStringToken(after, entries)
  const doc = []

  if (before) {
    doc.push(before)
  }

  doc.push(replacement)

  if (Array.isArray(restoredAfter)) {
    doc.push(...restoredAfter)
  } else if (restoredAfter) {
    doc.push(restoredAfter)
  }

  if (doc.length === 1) {
    return doc[0]
  }

  return doc
}

function restoreRenderedStringToken(value, entries) {
  let restored = value

  for (const [token, raw] of entries) {
    if (!restored.includes(token)) {
      continue
    }

    restored = restored.split(token).join(raw)
  }

  return restored
}

function restoreString(value, entries) {
  const doc = restoreStringToken(value, entries)

  if (typeof doc !== 'string') {
    return doc
  }

  if (!doc.includes(BLOCK_TOKEN_PREFIX) && !doc.includes(INLINE_TOKEN_PREFIX)) {
    return doc
  }

  return restoreRenderedStringToken(doc, entries)
}

function restoreTokens(value, entries) {
  if (!entries || entries.length === 0) {
    return value
  }

  if (typeof value === 'string') {
    return restoreString(value, entries)
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
  const ast = await tailwindHtmlParser.parse(preparedText, options, legacy)

  await formatDatastarAttributes(ast, 0, entries, options)
  return ast
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
