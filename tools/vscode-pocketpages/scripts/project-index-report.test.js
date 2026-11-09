'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { buildProjectIndexReport } = require('../packages/language-service/project-index-report')

function fixture(t, files) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketpages-report-'))
  t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }))
  fs.writeFileSync(path.join(appRoot, 'pb_schema.json'), '[]')
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(appRoot, 'pb_hooks/pages', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return buildProjectIndexReport({ appRoot })
}

function impact(report, file) {
  const entry = report.impactByFile.find((item) => item.relativePath === file)
  assert.ok(entry, `Missing impact: ${file}`)
  return entry
}

function routes(report, file) {
  return impact(report, file)
    .affectedRoutes.map((route) => route.routePath)
    .sort()
}

test('scope files have their own impact, with page-local loads and directory boundaries', (t) => {
  const report = fixture(t, {
    '+config.js': 'module.exports = function () { return {} }',
    '+layout.ejs': '<%- slot %>',
    '+middleware.js': 'module.exports = function (api, next) { next() }',
    '+load.js': 'module.exports = function () { return {} }',
    'index.ejs': 'Home',
    '(site)/+layout.ejs': '<%- slot %>',
    '(site)/+middleware.js': 'module.exports = function (api, next) { next() }',
    '(site)/+load.js': "require('../_private/load-data')",
    '(site)/+config.js': 'module.exports = function () { return {} }',
    '(site)/home.ejs': 'Site',
    '(site)/child/index.ejs': 'Child',
    '(sitewide)/other.ejs': 'Other',
    '_private/load-data.js': 'module.exports = {}',
    '_private/+middleware.js': 'module.exports = {}',
    'unused/+middleware.mjs': 'export default {}',
  })
  const unique = ['/', '/child', '/home', '/other']
  assert.deepEqual(routes(report, '+middleware.js'), unique)
  assert.deepEqual(routes(report, '+layout.ejs'), unique)
  assert.deepEqual(routes(report, '+config.js'), unique)
  assert.deepEqual(routes(report, '+load.js'), ['/'])
  assert.deepEqual(routes(report, '(site)/+middleware.js'), ['/child', '/home'])
  assert.deepEqual(routes(report, '(site)/+layout.ejs'), ['/child', '/home'])
  assert.deepEqual(routes(report, '(site)/+load.js'), ['/home'])
  assert.deepEqual(routes(report, '_private/load-data.js'), ['/home'])
  assert.equal(impact(report, '(site)/+layout.ejs').fileKind, 'layout')
  assert.equal(impact(report, '+middleware.js').fileKind, 'middleware')
  for (const file of ['(site)/+config.js', '_private/+middleware.js', 'unused/+middleware.mjs']) {
    assert.equal(
      report.impactByFile.some((entry) => entry.relativePath === file),
      false
    )
  }
})

test('local require requests include members, side effects, hooks roots, and missing targets', (t) => {
  const report = fixture(t, {
    'index.ejs': "<script server>const parent = resolve('parent'); parent.run()</script>",
    '_private/parent.js': [
      "const leaf = require('./leaf'); leaf.read()",
      "require('./side-effect')",
      "require(__hooks + '/pages/_private/hooks.js')",
      "require('./missing')",
      "require('external-package')",
      "require('./' + dynamicName)",
      "require(__hooks + 'not-a-rooted-path')",
      "// require('./comment')",
    ].join('\n'),
    '_private/leaf.js': 'exports.read = function () {}',
    '_private/side-effect.js': 'module.exports = {}',
    '_private/hooks.js': 'module.exports = {}',
  })
  const edges = report.resolveGraph.edges.filter((edge) => edge.sourceRelativePath === '_private/parent.js')
  assert.equal(edges.length, 4)
  assert.ok(edges.every((edge) => edge.sourceType === 'require'))
  assert.deepEqual(
    edges.find((edge) => edge.requestPath === './leaf').referencedMembers.map((m) => m.memberName),
    ['read']
  )
  assert.equal(edges.find((edge) => edge.requestPath === './missing').unresolved, true)
  assert.equal(
    edges.find((edge) => edge.requestPath === '/pages/_private/hooks.js').targetRelativePath,
    '_private/hooks.js'
  )
  for (const file of ['_private/leaf.js', '_private/side-effect.js', '_private/hooks.js']) {
    assert.deepEqual(routes(report, file), ['/'])
    assert.equal(impact(report, file).directCallers[0].sourceType, 'require')
  }
})

test('dependency propagation terminates on cycles and preserves both entry routes', (t) => {
  const report = fixture(t, {
    'a.ejs': "<script server>resolve('a')</script>",
    'b.ejs': "<script server>resolve('b')</script>",
    '_private/a.js': "require('./b')",
    '_private/b.js': "require('./a'); require('./leaf')",
    '_private/leaf.js': 'module.exports = {}',
  })
  for (const file of ['_private/a.js', '_private/b.js', '_private/leaf.js']) {
    assert.deepEqual(routes(report, file), ['/a', '/b'])
  }
})

test('include chains, cycles and modules inherit layout impact, but URL links do not', (t) => {
  const report = fixture(t, {
    '+layout.ejs': "<%- include('shell') %><%- slot %>",
    'a.ejs': '<a href="/b">B</a>',
    'b.ejs': 'B',
    '_private/shell.ejs': "<%- include('badge') %>",
    '_private/badge.ejs': "<script server>resolve('format')</script><%- include('shell') %>",
    '_private/format.js': "require('./leaf')",
    '_private/leaf.js': 'module.exports = {}',
  })
  for (const file of ['_private/shell.ejs', '_private/badge.ejs', '_private/format.js', '_private/leaf.js']) {
    assert.deepEqual(routes(report, file), ['/a', '/b'])
  }
  assert.deepEqual(routes(report, 'b.ejs'), ['/b'])
})

test('out-of-pages modules are direct targets without recursively expanding the scan scope', (t) => {
  const report = fixture(t, {
    'index.ejs': "<script server>require(__hooks + '/lib/parent.js')</script>",
    '../lib/parent.js': "require('./leaf')",
    '../lib/leaf.js': 'module.exports = {}',
  })
  assert.deepEqual(routes(report, '../lib/parent.js'), ['/'])
  assert.equal(report.resolveGraph.edges.length, 1)
  assert.equal(
    report.impactByFile.some((entry) => entry.relativePath === '../lib/leaf.js'),
    false
  )
})

test('actual Todo require wiring propagates todo-data callers to work-view', () => {
  const report = buildProjectIndexReport({ appRoot: path.resolve(__dirname, '../../../apps/todo') })
  const parent = routes(report, '_private/todo-data.js')
  assert.ok(parent.length > 2)
  const child = new Set(routes(report, '_private/work-view.js'))
  assert.ok(parent.every((route) => child.has(route)))
  assert.ok(
    impact(report, '_private/work-view.js').directCallers.some(
      (caller) => caller.sourceType === 'require' && caller.relativePath === '_private/todo-data.js'
    )
  )
  assert.equal(impact(report, '+middleware.js').fileKind, 'middleware')
  assert.ok(routes(report, '+middleware.js').length > 0)
})
