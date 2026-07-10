'use strict'

const { performance } = require('perf_hooks')

const SANITY_SECTIONS = Object.freeze([
  'contracts',
  'runtime-snapshot-cache',
  'path-and-extension-client',
  'fixture-integration',
])

const SANITY_TARGETS = Object.freeze({
  contracts: 'contracts',
  core: 'runtime-snapshot-cache',
  fast: 'path-and-extension-client',
  full: 'fixture-integration',
})

function parseTargetSection(args) {
  if (args.includes('--list')) {
    if (args.length !== 1) {
      throw new Error('Use --list without other sanity-check options.')
    }
    return { listOnly: true, targetSection: null }
  }

  const throughIndex = args.indexOf('--through')
  if (throughIndex === -1) {
    if (args.length) {
      throw new Error(`Unknown sanity-check options: ${args.join(' ')}`)
    }
    return { listOnly: false, targetSection: SANITY_TARGETS.full }
  }

  if (args.length !== 2 || throughIndex !== 0 || !args[1]) {
    throw new Error('Use --through <contracts|core|fast|full>.')
  }

  const targetSection = SANITY_TARGETS[args[1]]
  if (!targetSection) {
    throw new Error(`Unknown sanity-check target "${args[1]}".`)
  }
  return { listOnly: false, targetSection }
}

/**
 * sanity section 순서와 실행 시간을 관리합니다.
 * @param {string[]} args CLI 인자입니다.
 * @param {{ log?: (message: string) => void }} options 출력 옵션입니다.
 * @returns {{ listOnly: boolean, printSections: () => void, beginSection: (name: string) => void, completeSection: (name: string) => void, shouldStopAfter: (name: string) => boolean, finish: () => void }} sanity runner입니다.
 */
function createSanityRunner(args = process.argv.slice(2), options = {}) {
  const log = typeof options.log === 'function' ? options.log : (message) => console.log(message)
  const selection = parseTargetSection(args)
  const targetIndex = selection.listOnly ? -1 : SANITY_SECTIONS.indexOf(selection.targetSection)
  const completedSections = []
  const startedAt = performance.now()
  let activeSection = null

  function printSections() {
    for (const [target, section] of Object.entries(SANITY_TARGETS)) {
      log(`${target}: ${SANITY_SECTIONS.slice(0, SANITY_SECTIONS.indexOf(section) + 1).join(', ')}`)
    }
  }

  function beginSection(name) {
    const expectedSection = SANITY_SECTIONS[completedSections.length]
    if (activeSection) {
      throw new Error(`Sanity section "${activeSection.name}" is still running.`)
    }
    if (name !== expectedSection) {
      throw new Error(`Expected sanity section "${expectedSection}", got "${name}".`)
    }
    if (completedSections.length > targetIndex) {
      throw new Error(`Sanity section "${name}" is outside the selected target.`)
    }

    activeSection = {
      name,
      startedAt: performance.now(),
    }
  }

  function completeSection(name) {
    if (!activeSection || activeSection.name !== name) {
      throw new Error(`Cannot complete inactive sanity section "${name}".`)
    }

    const elapsedMs = performance.now() - activeSection.startedAt
    completedSections.push(name)
    activeSection = null
    log(`Sanity section passed: ${name} (${elapsedMs.toFixed(1)}ms)`)
  }

  function shouldStopAfter(name) {
    return name === selection.targetSection
  }

  function finish() {
    if (activeSection) {
      throw new Error(`Sanity section "${activeSection.name}" was not completed.`)
    }

    const expectedSections = SANITY_SECTIONS.slice(0, targetIndex + 1)
    if (completedSections.join('\n') !== expectedSections.join('\n')) {
      throw new Error(
        `Sanity section coverage mismatch. Expected ${expectedSections.join(', ')}, got ${completedSections.join(', ')}.`
      )
    }

    log(
      `Sanity sections passed: ${completedSections.length}/${SANITY_SECTIONS.length} through ${selection.targetSection} (${(performance.now() - startedAt).toFixed(1)}ms)`
    )
  }

  return {
    listOnly: selection.listOnly,
    printSections,
    beginSection,
    completeSection,
    shouldStopAfter,
    finish,
  }
}

module.exports = {
  SANITY_SECTIONS,
  SANITY_TARGETS,
  createSanityRunner,
}
