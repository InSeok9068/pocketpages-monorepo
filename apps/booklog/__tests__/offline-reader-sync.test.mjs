import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const readerLines = readFileSync(new URL('../pb_hooks/pages/assets/booklog-reader.js', import.meta.url), 'utf8').split(
  /\r?\n/
)
const offlineLines = readFileSync(
  new URL('../pb_hooks/pages/assets/booklog-offline.js', import.meta.url),
  'utf8'
).split(/\r?\n/)

// 오프라인에서 쓰지 않는 진단·독서 세션·완독 안내와 간소화한 상태는 일부러 다릅니다.
const OFFLINE_STANDINS = new Set([
  'traceReader',
  'isReaderTraceOn',
  'markReadingSessionActivity',
  'scheduleFinishPromptIfNeeded',

  'activeComponent',
])

function topLevelFunctions(lines) {
  const functions = new Map()
  lines.forEach((line, index) => {
    const match = /^ {2}function (\w+)\(/.exec(line)
    if (!match) return
    let end = index
    while (lines[end] !== '  }') end += 1
    functions.set(match[1], lines.slice(index, end + 1).join('\n'))
  })
  return functions
}

function topLevelVars(lines) {
  return new Map(
    lines
      .map((line) => /^ {2}var (\w+) = (.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  )
}

test('The offline shelf scrolls with the same functions and settings as the online reader', () => {
  const reader = topLevelFunctions(readerLines)
  const offline = topLevelFunctions(offlineLines)
  const shared = [...offline.keys()].filter((name) => reader.has(name) && !OFFLINE_STANDINS.has(name))
  assert.ok(shared.length >= 50, 'the scroll code is shared, not rewritten: ' + shared.length)
  for (const name of shared) {
    assert.equal(
      offline.get(name),
      reader.get(name),
      name + ' changed in booklog-reader.js; copy it to booklog-offline.js'
    )
  }

  const readerVars = topLevelVars(readerLines)
  for (const [name, value] of topLevelVars(offlineLines)) {
    if (readerVars.has(name) && !OFFLINE_STANDINS.has(name)) assert.equal(value, readerVars.get(name), name)
  }
})

test('Offline progress uses cached locations or generates them locally and tracks the current CFI', async () => {
  const functions = topLevelFunctions(offlineLines)
  const attributes = new Map()
  const progressBar = {
    hidden: true,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  }
  const progressFill = { style: {} }
  const activeComponent = { progressLocationsStatus: 'pending' }
  const cfi = 'epubcfi(/6/2!/4/2:0)'
  let generated = 0
  let loaded = 0
  const bookInstance = {
    spine: { get: () => true },
    locations: {
      load: () => {
        loaded += 1
      },
      generate: async () => {
        generated += 1
        return [cfi]
      },
      percentageFromCfi: (locator) => (locator === cfi ? 0 : 0.42),
    },
  }
  const context = {
    activeComponent,
    bookInstance,
    progressBar,
    progressFill,
    currentLocation: { start: { cfi } },
    PROGRESS_LOCATION_BREAK: 1600,
    PROGRESS_LOCATIONS_CACHE_VERSION: 'epubjs-0.3.93:1600',
  }
  runInNewContext(
    ['getProgressPercentFromLocator', 'updateOfflineProgress', 'prepareOfflineProgress']
      .map((name) => functions.get(name))
      .join('\n'),
    context
  )

  context.prepareOfflineProgress(
    { progressLocationsVersion: context.PROGRESS_LOCATIONS_CACHE_VERSION, progressLocations: JSON.stringify([cfi]) },
    bookInstance
  )
  assert.equal(loaded, 1)
  assert.equal(generated, 0)
  assert.equal(progressBar.hidden, false)
  assert.equal(attributes.get('aria-valuenow'), '0')

  activeComponent.progressLocationsStatus = 'pending'
  context.updateOfflineProgress()
  assert.equal(progressBar.hidden, true)
  assert.equal(attributes.has('aria-valuenow'), false)

  context.prepareOfflineProgress({}, bookInstance)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(generated, 1)
  context.currentLocation = { start: { cfi: 'epubcfi(/6/2!/4/2:42)' } }
  context.updateOfflineProgress()
  assert.equal(progressBar.hidden, false)
  assert.equal(progressFill.style.width, '42%')
  assert.equal(attributes.get('aria-valuenow'), '42')
})
