import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))

globalThis.__hooks = path.resolve(testDir, '../pb_hooks')

const { htmlToText, parseTeamLeadRowsFromDiaryHtml, parseJobStatusTableFromDiaryHtml } = require('../pb_hooks/pages/_private/kjca-core.js')

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

test('parseJobStatusTableFromDiaryHtml removes empty trailing columns and keeps a single staff column', () => {
  const html =
    '<div class="doc_text editor">' +
    '<strong>3. 알선취업자 현황</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>임수라</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>월 알선취업 목표</td><td>1</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>금일 알선건수</td><td>0</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>1</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>0</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>0</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
    '</table>' +
    '</div>'

  assert.deepEqual(parseJobStatusTableFromDiaryHtml(html), {
    title: '알선취업자 현황',
    staffNames: ['임수라'],
    rows: [
      { key: 'month-target', label: '월 알선취업 목표', values: [{ text: '1', valueNumber: 1 }] },
      { key: 'daily-count', label: '금일 알선건수', values: [{ text: '0', valueNumber: 0 }] },
      { key: 'scheduled-count', label: '알선취업 예정자 수', values: [{ text: '1', valueNumber: 1 }] },
      { key: 'interview-count', label: '알선자 면접건수', values: [{ text: '0', valueNumber: 0 }] },
      { key: 'cumulative-count', label: '알선취업 누적건수', values: [{ text: '0', valueNumber: 0 }] },
    ],
  })
})

test('parseJobStatusTableFromDiaryHtml treats html entity blanks as empty values', () => {
  const html =
    '<div class="doc_text editor">' +
    '<strong>3. 알선취업자 현황</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>임수라</td><td>&amp;nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>월 알선취업 목표</td><td>&amp;nbsp;1</td><td>&amp;nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>금일 알선건수</td><td>&amp;nbsp;0</td><td>&amp;nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>&amp;nbsp;1</td><td>&amp;nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>&amp;nbsp;0</td><td>&amp;nbsp;</td><td>&nbsp;</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>&amp;nbsp;0</td><td>&amp;nbsp;</td><td>&nbsp;</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseJobStatusTableFromDiaryHtml(html)

  assert.deepEqual(parsed.staffNames, ['임수라'])
  assert.deepEqual(
    parsed.rows.map((row) => row.values[0].text),
    ['1', '0', '1', '0', '0']
  )
})

test('parseJobStatusTableFromDiaryHtml keeps multiple staff columns and month-prefixed labels', () => {
  const html =
    '<div class="doc_text editor">' +
    '<span><strong>3. 알선취업자 현황</strong></span>' +
    '<table>' +
    '<tr><td>구분</td><td>김보라</td><td>김소라</td><td>박소정</td><td>김상미</td><td>길준석</td><td>유재은</td></tr>' +
    '<tr><td>4월 알선취업 목표</td><td>1</td><td>2</td><td>1</td><td>2</td><td>3</td><td>1</td></tr>' +
    '<tr><td>금일 알선건수</td><td>0</td><td>8</td><td>2</td><td>5</td><td>2</td><td>0</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>0</td><td>1</td><td>0</td><td>3</td><td>2</td><td>0</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>1</td><td>12</td><td>10</td><td>19</td><td>6</td><td>4</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>1</td><td>0</td><td>4</td><td>9</td><td>3</td><td>0</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseJobStatusTableFromDiaryHtml(html)

  assert.deepEqual(parsed.staffNames, ['김보라', '김소라', '박소정', '김상미', '길준석', '유재은'])
  assert.equal(parsed.rows[0].key, 'month-target')
  assert.equal(parsed.rows[0].values[1].valueNumber, 2)
  assert.equal(parsed.rows[1].key, 'daily-count')
  assert.equal(parsed.rows[1].values[3].text, '5')
  assert.equal(parsed.rows[4].key, 'cumulative-count')
  assert.equal(parsed.rows[4].values[4].valueNumber, 3)
})

test('parseJobStatusTableFromDiaryHtml preserves mixed text cells such as leave markers', () => {
  const html =
    '<div class="doc_text editor">' +
    '<strong>3. 알선취업자 현황/ 팀알선 8건</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>채영미</td><td>노정숙</td><td>임다예</td><td>이영미</td><td>장세은</td><td>곽경림</td></tr>' +
    '<tr><td>4월 알선취업 목표</td><td>1</td><td>1</td><td>1</td><td>2</td><td>1</td><td>1</td></tr>' +
    '<tr><td>금일 알선건수</td><td>2</td><td>1</td><td>연차</td><td>2</td><td>1</td><td>2</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>0</td><td>1</td><td>0</td><td>0</td><td>1</td><td>0</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>1</td><td>1</td><td>0</td><td>3</td><td>1</td><td>2</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseJobStatusTableFromDiaryHtml(html)

  assert.equal(parsed.title, '알선취업자 현황/ 팀알선 8건')
  assert.equal(parsed.rows[1].key, 'daily-count')
  assert.equal(parsed.rows[1].values[2].text, '연차')
  assert.equal(parsed.rows[1].values[2].valueNumber, null)
})
