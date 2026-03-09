'use strict'

const path = require('path')
const { PocketPagesLanguageServiceManager } = require('../src/language-service')

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const filePath = path.join(repoRoot, 'apps', 'sample', 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs')
  const documentText = `<script server>\nmet\n</script>\n`

  const manager = new PocketPagesLanguageServiceManager()
  const service = manager.getServiceForFile(filePath)

  if (!service) {
    throw new Error(`PocketPages app root not found for ${filePath}`)
  }

  const completionOffset = documentText.indexOf('met') + 'met'.length
  const completionData = service.getCompletionData(filePath, documentText, completionOffset)

  if (!completionData) {
    throw new Error('No completion data returned for <script server> block.')
  }

  const completionNames = completionData.entries.map((entry) => entry.name)
  if (!completionNames.includes('meta')) {
    throw new Error(`Expected "meta" completion. Got: ${completionNames.slice(0, 20).join(', ')}`)
  }

  const hoverText = `<script server>\nmeta\n</script>\n`
  const hoverOffset = hoverText.indexOf('meta') + 1
  const quickInfo = service.getQuickInfo(filePath, hoverText, hoverOffset)

  if (!quickInfo || !quickInfo.displayText.includes('meta')) {
    throw new Error(`Expected hover info for "meta". Got: ${JSON.stringify(quickInfo)}`)
  }

  console.log('Sanity check passed.')
  console.log(`Sample completions: ${completionNames.slice(0, 10).join(', ')}`)
  console.log(`Hover: ${quickInfo.displayText}`)
}

run()
