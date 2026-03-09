'use strict'

const path = require('path')
const { PocketPagesLanguageServiceManager } = require('../src/language-service')

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const boardsFilePath = path.join(repoRoot, 'apps', 'sample', 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs')
  const boardShowFilePath = path.join(
    repoRoot,
    'apps',
    'sample',
    'pb_hooks',
    'pages',
    '(site)',
    'boards',
    '[boardSlug]',
    'index.ejs'
  )

  const manager = new PocketPagesLanguageServiceManager()
  const service = manager.getServiceForFile(boardsFilePath)

  if (!service) {
    throw new Error(`PocketPages app root not found for ${boardsFilePath}`)
  }

  const completionText = `<script server>\nmet\n</script>\n`
  const completionOffset = completionText.indexOf('met') + 'met'.length
  const completionData = service.getCompletionData(boardsFilePath, completionText, completionOffset)

  if (!completionData) {
    throw new Error('No completion data returned for <script server> block.')
  }

  const completionNames = completionData.entries.map((entry) => entry.name)
  if (!completionNames.includes('meta')) {
    throw new Error(`Expected "meta" completion. Got: ${completionNames.slice(0, 20).join(', ')}`)
  }

  const hoverText = `<script server>\nmeta\n</script>\n`
  const hoverOffset = hoverText.indexOf('meta') + 1
  const quickInfo = service.getQuickInfo(boardsFilePath, hoverText, hoverOffset)

  if (!quickInfo || !quickInfo.displayText.includes('meta')) {
    throw new Error(`Expected hover info for "meta". Got: ${JSON.stringify(quickInfo)}`)
  }

  const paramsText = `<script server>\nparams.\n</script>\n`
  const paramsOffset = paramsText.indexOf('params.') + 'params.'.length
  const paramsCompletion = service.getCompletionData(boardShowFilePath, paramsText, paramsOffset)
  const paramsNames = paramsCompletion ? paramsCompletion.entries.map((entry) => entry.name) : []
  if (!paramsNames.includes('boardSlug')) {
    throw new Error(`Expected route param completion for "boardSlug". Got: ${paramsNames.slice(0, 20).join(', ')}`)
  }

  const resolveText = `<script server>\nresolve('bo')\n</script>\n`
  const resolveOffset = resolveText.indexOf('bo') + 'bo'.length
  const resolveCompletion = service.getCustomCompletionData(boardsFilePath, resolveText, resolveOffset)
  const resolveNames = resolveCompletion ? resolveCompletion.items.map((entry) => entry.label) : []
  if (!resolveNames.includes('board-service')) {
    throw new Error(`Expected resolve() completion for "board-service". Got: ${resolveNames.slice(0, 20).join(', ')}`)
  }

  const includeText = `<%- include('fl') %>\n`
  const includeOffset = includeText.indexOf('fl') + 'fl'.length
  const includeCompletion = service.getCustomCompletionData(boardsFilePath, includeText, includeOffset)
  const includeNames = includeCompletion ? includeCompletion.items.map((entry) => entry.label) : []
  if (!includeNames.includes('flash-alert.ejs')) {
    throw new Error(`Expected include() completion for "flash-alert.ejs". Got: ${includeNames.slice(0, 20).join(', ')}`)
  }

  const collectionText = `<script server>\n$app.findRecordsByFilter('bo')\n</script>\n`
  const collectionOffset = collectionText.indexOf('bo') + 'bo'.length
  const collectionCompletion = service.getCustomCompletionData(boardsFilePath, collectionText, collectionOffset)
  const collectionNames = collectionCompletion ? collectionCompletion.items.map((entry) => entry.label) : []
  if (!collectionNames.includes('boards') || !collectionNames.includes('posts')) {
    throw new Error(`Expected collection completions for "boards" and "posts". Got: ${collectionNames.slice(0, 20).join(', ')}`)
  }

  const fieldText = `<script server>\nboard.get('na')\n</script>\n`
  const fieldOffset = fieldText.indexOf('na') + 'na'.length
  const fieldCompletion = service.getCustomCompletionData(boardShowFilePath, fieldText, fieldOffset)
  const fieldNames = fieldCompletion ? fieldCompletion.items.map((entry) => entry.label) : []
  if (!fieldNames.includes('name') || !fieldNames.includes('slug')) {
    throw new Error(`Expected board field completions. Got: ${fieldNames.slice(0, 20).join(', ')}`)
  }

  const resolveDefinition = service.getDefinitionTarget(
    boardsFilePath,
    `<script server>\nresolve('board-service')\n</script>\n`,
    `<script server>\nresolve('board-service')\n</script>\n`.indexOf('board-service') + 2
  )
  if (!resolveDefinition || !resolveDefinition.endsWith('/pb_hooks/pages/_private/board-service.js')) {
    throw new Error(`Expected resolve() definition target. Got: ${resolveDefinition}`)
  }

  const includeDefinition = service.getDefinitionTarget(
    boardsFilePath,
    `<%- include('flash-alert.ejs') %>\n`,
    `<%- include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
  )
  if (!includeDefinition || !includeDefinition.endsWith('/pb_hooks/pages/_private/flash-alert.ejs')) {
    throw new Error(`Expected include() definition target. Got: ${includeDefinition}`)
  }

  const diagnostics = service.getDiagnostics(
    boardsFilePath,
    `<script server>\n$app.findRecordsByFilter('missing_collection')\nboard.get('missing_field')\n</script>\n`
  )
  const diagnosticMessages = diagnostics.map((entry) => String(entry.message))
  if (!diagnosticMessages.some((message) => message.includes('Unknown PocketBase collection "missing_collection"'))) {
    throw new Error(`Expected unknown collection diagnostic. Got: ${diagnosticMessages.join(' | ')}`)
  }
  if (!diagnosticMessages.some((message) => message.includes('Unknown field "missing_field" for collection "boards"'))) {
    throw new Error(`Expected unknown field diagnostic. Got: ${diagnosticMessages.join(' | ')}`)
  }

  const documentLinks = service.getDocumentLinks(
    boardsFilePath,
    `<script server>\nresolve('board-service')\n</script>\n<%- include('flash-alert.ejs') %>\n`
  )
  const documentLinkTargets = documentLinks.map((entry) => entry.targetFilePath)
  if (!documentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/_private/board-service.js'))) {
    throw new Error(`Expected resolve() document link target. Got: ${documentLinkTargets.join(', ')}`)
  }
  if (!documentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/_private/flash-alert.ejs'))) {
    throw new Error(`Expected include() document link target. Got: ${documentLinkTargets.join(', ')}`)
  }

  console.log('Sanity check passed.')
  console.log(`Sample completions: ${completionNames.slice(0, 10).join(', ')}`)
  console.log(`Route params: ${paramsNames.filter((name) => name === 'boardSlug').join(', ')}`)
  console.log(`Resolve candidates: ${resolveNames.slice(0, 5).join(', ')}`)
  console.log(`Include candidates: ${includeNames.slice(0, 5).join(', ')}`)
  console.log(`Collections: ${collectionNames.slice(0, 5).join(', ')}`)
  console.log(`Fields: ${fieldNames.slice(0, 5).join(', ')}`)
  console.log(`Document links: ${documentLinks.length}`)
  console.log(`Hover: ${quickInfo.displayText}`)
}

run()
