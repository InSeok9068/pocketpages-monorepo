import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))

globalThis.__hooks = path.resolve(testDir, '../pb_hooks')

const { htmlToText, parseTeamLeadRowsFromDiaryHtml } = require('../pb_hooks/pages/_private/kjca-core.js')

test('htmlToText keeps table columns and list markers readable', () => {
  const html =
    '<div>' +
    '<p>Month target: 10</p>' +
    '<table>' +
    '<tr><th>Day</th><th>Plan</th><th>Owner</th></tr>' +
    '<tr><td>Mon</td><td>Street promo<br>2 consults</td><td>Kim</td></tr>' +
    '</table>' +
    '<ul><li>Note1</li><li>Note2</li></ul>' +
    '</div>'

  assert.equal(
    htmlToText(html),
    ['Month target: 10', '', 'Day | Plan | Owner', 'Mon | Street promo | Kim', '2 consults', '', '- Note1', '- Note2'].join('\n')
  )
})

test('parseTeamLeadRowsFromDiaryHtml extracts absolute print urls from KJCA rows', () => {
  const labelDept = '\uBD80\uC11C'
  const labelPosition = '\uC9C1\uCC45'
  const labelStaffName = '\uC131\uBA85'
  const labelPrint = '\uC778\uC1C4'
  const teamLead = '\uD300\uC7A5'
  const diaryHtml =
    '<table>' +
    '<tr>' +
    `<td data-label="${labelDept}">Dept A</td>` +
    `<td data-label="${labelPosition}"><strong>${teamLead}</strong></td>` +
    `<td data-label="${labelStaffName}">Kim</td>` +
    `<td data-label="${labelPrint}"><button onclick="window.open('?site=groupware&amp;mn=1450&amp;bd_idx=22')">print</button></td>` +
    '</tr>' +
    '<tr>' +
    `<td data-label="${labelDept}">Dept B</td>` +
    `<td data-label="${labelPosition}">Staff</td>` +
    `<td data-label="${labelStaffName}">Lee</td>` +
    `<td data-label="${labelPrint}"><a href="/diary/?site=groupware&amp;mn=1450&amp;bd_idx=23">print</a></td>` +
    '</tr>' +
    '</table>'

  assert.deepEqual(parseTeamLeadRowsFromDiaryHtml(diaryHtml, 'http://www.kjca.co.kr'), {
    rows: [
      {
        dept: 'Dept A',
        position: teamLead,
        staffName: 'Kim',
        printUrl: 'http://www.kjca.co.kr/diary/?site=groupware&mn=1450&bd_idx=22',
      },
    ],
  })
})
