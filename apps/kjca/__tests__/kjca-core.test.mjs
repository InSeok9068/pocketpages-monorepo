import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))

globalThis.__hooks = path.resolve(testDir, '../pb_hooks')

const {
  htmlToText,
  buildPromotionDisplayItems,
  parseTeamLeadRowsFromDiaryHtml,
  parseRecruitingExtractFromDiaryHtml,
  parseJobStatusTableFromDiaryHtml,
  parseMiscSectionFromDiaryHtml,
} = require('../pb_hooks/pages/_private/kjca-core.js')

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

test('parseJobStatusTableFromDiaryHtml recognizes shortened title variant and mixed text metrics', () => {
  const html =
    '<div class="doc_text editor">' +
    '<strong>3.&nbsp;</strong><strong>알선취업&nbsp;</strong><a><strong>현황</strong></a>' +
    '<table>' +
    '<tr><td>구분</td><td>백단비</td><td>강수현</td><td>정윤경</td><td>방인정</td><td>정수민</td><td>정령빈</td></tr>' +
    '<tr><td>2월 알선취업 목표</td><td>1</td><td>2</td><td>2</td><td>2</td><td>2</td><td>1</td></tr>' +
    '<tr><td>금일 알선건수</td><td>0</td><td>10</td><td>-</td><td>7</td><td>2</td><td>-</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>&nbsp;</td><td>이수정/0401</td><td>최희창/0316<br>김지현/0401</td><td>&nbsp;</td><td>권우희/0323</td><td>백서현/0316<br>박진우/0401</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>&nbsp;</td><td>백승연/0319</td><td>김원석/0325</td><td>&nbsp;</td><td>추정엽/0401</td><td>정형진/0320</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>0</td><td>1</td><td>3</td><td>2</td><td>2</td><td>1</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseJobStatusTableFromDiaryHtml(html)

  assert.equal(parsed.title, '알선취업 현황')
  assert.deepEqual(parsed.staffNames, ['백단비', '강수현', '정윤경', '방인정', '정수민', '정령빈'])
  assert.equal(parsed.rows[0].key, 'month-target')
  assert.equal(parsed.rows[2].values[1].text, '이수정/0401')
  assert.equal(parsed.rows[2].values[1].valueNumber, null)
  assert.equal(parsed.rows[3].key, 'interview-count')
})

test('parseJobStatusTableFromDiaryHtml recognizes counselor employment support status alias', () => {
  const html =
    '<div class="doc_text editor">' +
    '<table><tr><td><span><strong>○상담사 취업지원현황</strong></span>' +
    '<table>' +
    '<tr><td>구분</td><td>황수연</td><td>김경태</td><td>진윤아</td><td>이기영</td><td>정향주</td></tr>' +
    '<tr><td>월 알선목표</td><td>2</td><td>3</td><td>4</td><td>4</td><td>3</td></tr>' +
    '<tr><td>금일 알선건수</td><td>0</td><td>&nbsp;</td><td>2</td><td>4</td><td>2</td></tr>' +
    '<tr><td>알선취업예정자수</td><td>0</td><td>0</td><td>1</td><td>1</td><td>0</td></tr>' +
    '<tr><td>금일 알선면접건수</td><td>0</td><td>0</td><td>0</td><td>1</td><td>0</td></tr>' +
    '<tr><td>알선취업 누적</td><td>&nbsp;</td><td>2</td><td>8</td><td>6</td><td>1</td></tr>' +
    '</table>' +
    '</td></tr></table>' +
    '</div>'

  const parsed = parseJobStatusTableFromDiaryHtml(html)

  assert.equal(parsed.title, '상담사 취업지원현황')
  assert.deepEqual(parsed.staffNames, ['황수연', '김경태', '진윤아', '이기영', '정향주'])
  assert.deepEqual(
    parsed.rows.map((row) => row.key),
    ['month-target', 'daily-count', 'scheduled-count', 'interview-count', 'cumulative-count']
  )
  assert.equal(parsed.rows[4].values[0].text, '')
  assert.equal(parsed.rows[4].values[1].valueNumber, 2)
})

test('parseRecruitingExtractFromDiaryHtml parses standard weekly recruiting table without AI help', () => {
  const html =
    '<div class="doc_text editor">' +
    '<strong>2. 모집. 홍보</strong>' +
    '<table>' +
    '<tr><td colspan="7">월 배정목표 : 60건 / 4월 현재 달성 : 배정 3명</td></tr>' +
    '<tr><td>요일</td><td colspan="3">주간 홍보계획</td><td>결과</td><td>담당자(홍보)</td><td>비고</td></tr>' +
    '<tr><td>모집홍보처</td><td>모집 홍보내용</td><td>모집목표</td><td>모집 건수</td></tr>' +
    '<tr><td>월</td><td>올댓뷰티</td><td>훈련생 TM</td><td>3건</td><td>0건</td><td>백단비</td><td>올댓뷰티연계 2명 추가</td></tr>' +
    '<tr><td>화</td><td>KH</td><td>훈련생 TM</td><td>3건</td><td>2건</td><td>백단비</td><td></td></tr>' +
    '<tr><td>수</td><td>SBS게임아카데미</td><td>방문일정재협의</td><td>협약일정확인</td><td>4/9 방문예정</td><td>백단비</td><td></td></tr>' +
    '<tr><td>목</td><td>아텐츠아카데미</td><td>훈련생 TM</td><td>3건</td><td>0건</td><td></td><td>익일 신청자 2명 연계</td></tr>' +
    '<tr><td>금</td><td>KH</td><td>담당자 미팅 및 협약</td><td>3건</td><td>1건</td><td></td><td>금일방문예정 신청건 차주 일정변경</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseRecruitingExtractFromDiaryHtml(html, '2026-04-03')

  assert.equal(parsed.monthTarget, 60)
  assert.equal(parsed.monthAssignedCurrent, 3)
  assert.equal(parsed.weekTarget, 12)
  assert.equal(parsed.dailyActualCount, 1)
  assert.equal(parsed.weekTableRows.length, 5)
  assert.equal(parsed.weekTableRows[0].channelName, '올댓뷰티')
  assert.equal(parsed.weekTableRows[1].recruitCountText, '2건')
  assert.equal(parsed.weekTableRows[2].targetText, '협약일정확인')
  assert.equal(parsed.dailyPlan[2].targetCount, null)
  assert.equal(parsed.dailyPlan[4].targetCount, 3)
})

test('parseRecruitingExtractFromDiaryHtml handles count-only recruiting schema and weekday rowspans', () => {
  const html =
    '<div class="doc_text editor">' +
    '<span><strong>○ 홍보 모집</strong></span>' +
    '<table>' +
    '<tr><td colspan="7">월 배정목표:45건/모집배정목표20건 /3월 현재 달성: 배정 건 모집 :0건</td></tr>' +
    '<tr><td rowspan="3">요일</td><td colspan="3">주간홍보계획</td><td>결과</td><td rowspan="2">담당자(홍보)</td><td rowspan="2">비고</td></tr>' +
    '<tr><td>모집홍보기관</td><td>모집홍보내용</td><td>모집건수</td><td></td></tr>' +
    '<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>' +
    '<tr><td>월</td><td>동부고용센터</td><td>실업급여 만료 대상자 홍보</td><td>3</td><td>참여신청서 작성 2건 제출예정 1건</td><td>이기영</td><td></td></tr>' +
    '<tr><td>화</td><td>경북대학교 현장채용설명회 외부 홍보</td><td>설명회장 입퇴장자 대상 외부 홍보</td><td></td><td>고등학생 많음</td><td>김경태, 김나연</td><td>SBS-1건 작성</td></tr>' +
    '<tr><td>수</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>' +
    '<tr><td rowspan="2">목</td><td>동부고용센터</td><td>실업급여 만료 대상자 홍보</td><td>1</td><td></td><td>정향주</td><td></td></tr>' +
    '<tr><td>동대구간호학원외2곳</td><td>기관홍보 협조및 설명회요청</td><td></td><td>9월에 설명회예정</td><td>진윤아,정향주</td><td></td></tr>' +
    '<tr><td>금</td><td>배움디지털</td><td>협약홍보 협조요청, 설명회요청</td><td></td><td>4/9일 설명회</td><td>황수연, 이기영김나연</td><td></td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseRecruitingExtractFromDiaryHtml(html, '2026-03-30')

  assert.equal(parsed.monthTarget, 45)
  assert.equal(parsed.monthAssignedCurrent, 0)
  assert.equal(parsed.weekTarget, 4)
  assert.equal(parsed.dailyActualCount, 3)
  assert.equal(parsed.weekTableRows.length, 5)
  assert.equal(parsed.weekTableRows[0].targetText, '3')
  assert.equal(parsed.weekTableRows[0].recruitCountText, '3')
  assert.equal(parsed.weekTableRows[0].note, '참여신청서 작성 2건 제출예정 1건')
  assert.equal(parsed.weekTableRows[2].weekday, 'thu')
  assert.equal(parsed.weekTableRows[2].ownerName, '정향주')
  assert.equal(parsed.weekTableRows[3].weekday, 'thu')
  assert.equal(parsed.weekTableRows[3].note, '9월에 설명회예정')
})

test('parseRecruitingExtractFromDiaryHtml keeps recruiting rows clean when later sections are nested in a wrapper table', () => {
  const html =
    '<div class="doc_text editor">' +
    '<table><tr><td>' +
    '<strong>2. 모집 / 홍보</strong>' +
    '<table>' +
    '<tr><td colspan="7">월 배정목표 : 50건 / 4월 현재 달성 : 배정 9명</td></tr>' +
    '<tr><td>요일</td><td colspan="3">주간 홍보계획</td><td>결과</td><td>담당자(홍보)</td><td>비고</td></tr>' +
    '<tr><td>모집홍보처</td><td>모집 홍보내용</td><td>모집목표</td><td>모집 건수</td></tr>' +
    '<tr><td>목</td><td>안양온누리요양보호사교육원</td><td>홍보</td><td></td><td></td><td>정은선</td><td></td></tr>' +
    '<tr><td>금</td><td>한국직업능력교육원</td><td>설명회</td><td>12명</td><td>1</td><td>김민정</td><td>선물 전달예정</td></tr>' +
    '</table>' +
    '<strong>3. 알선취업자 현황</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>민미경</td><td>최지원</td></tr>' +
    '<tr><td>3월 알선취업 목표</td><td>3</td><td>0</td></tr>' +
    '<tr><td>금일 알선건수</td><td>7</td><td>0</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>03/26 김희주</td><td>03/23 손유진</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>03/16 염혜원</td><td>03/30 송민선</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>6</td><td>2</td></tr>' +
    '</table>' +
    '<strong>4. 기타 사항</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>내용</td></tr>' +
    '<tr><td>고용센터 전달사항</td><td>- 없음</td></tr>' +
    '<tr><td>지점 특이사항</td><td>- 없음</td></tr>' +
    '<tr><td>기타 건의사항</td><td>- 없음</td></tr>' +
    '</table>' +
    '</td></tr></table>' +
    '</div>'

  const parsed = parseRecruitingExtractFromDiaryHtml(html, '2026-04-03')
  const thuRow = parsed.weekTableRows.find((row) => row.weekday === 'thu')
  const friRow = parsed.weekTableRows.find((row) => row.weekday === 'fri')

  assert.equal(parsed.monthTarget, 50)
  assert.equal(parsed.monthAssignedCurrent, 9)
  assert.equal(thuRow.channelName, '안양온누리요양보호사교육원')
  assert.equal(thuRow.ownerName, '정은선')
  assert.equal(friRow.channelName, '한국직업능력교육원')
  assert.equal(friRow.promotionContent, '설명회')
  assert.equal(friRow.targetText, '12명')
  assert.equal(friRow.recruitCountText, '1')
  assert.equal(friRow.ownerName, '김민정')
  assert.equal(friRow.note, '선물 전달예정')
})

test('parseRecruitingExtractFromDiaryHtml still parses a recruiting table when the section title is missing', () => {
  const html =
    '<div class="doc_text editor">' +
    '<table>' +
    '<tr><td colspan="7">월 배정목표 : 40건 / 4월 현재 달성 : 배정 12명</td></tr>' +
    '<tr><td>요일</td><td colspan="3">주간 홍보계획</td><td>결과</td><td>담당자(홍보)</td><td>비고</td></tr>' +
    '<tr><td>모집홍보처</td><td>모집 홍보내용</td><td>모집목표</td><td>모집 건수</td></tr>' +
    '<tr><td>목</td><td>안양온누리요양보호사교육원</td><td>홍보</td><td></td><td></td><td>정은선</td><td></td></tr>' +
    '<tr><td>금</td><td>SBS 게임학원</td><td>MOU</td><td></td><td></td><td>팀장</td><td>3시 진행</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseRecruitingExtractFromDiaryHtml(html, '2026-04-03')

  assert.equal(parsed.monthTarget, 40)
  assert.equal(parsed.monthAssignedCurrent, 12)
  assert.equal(parsed.weekTableRows.length, 2)
  assert.equal(parsed.weekTableRows[1].weekday, 'fri')
  assert.equal(parsed.weekTableRows[1].channelName, 'SBS 게임학원')
  assert.equal(parsed.weekTableRows[1].promotionContent, 'MOU')
  assert.equal(parsed.weekTableRows[1].ownerName, '팀장')
  assert.equal(parsed.weekTableRows[1].note, '3시 진행')
})

test('buildPromotionDisplayItems prefers structured recruiting rows with weekday labels', () => {
  assert.deepEqual(
    buildPromotionDisplayItems({
      promotion: ['알선취업 예정자 2명', '모집 홍보 원문'],
      recruiting: {
        weekTableRows: [
          { weekday: 'mon', channelName: '올댓뷰티', promotionContent: '훈련생 TM' },
          { weekday: 'tue', channelName: 'KH', promotionContent: '담당자 미팅' },
          { weekday: 'tue', channelName: 'KH', promotionContent: '담당자 미팅' },
        ],
      },
    }),
    ['(월) 올댓뷰티 / 훈련생 TM', '(화) KH / 담당자 미팅']
  )
})

test('buildPromotionDisplayItems falls back to weekly plan text when structured row has no channel or promotion content', () => {
  assert.deepEqual(
    buildPromotionDisplayItems({
      promotion: ['AI 텍스트'],
      recruiting: {
        weekTableRows: [{ weekday: 'fri', weeklyPlan: '기관 재방문 일정 조율', channelName: '', promotionContent: '' }],
      },
    }),
    ['(금) 기관 재방문 일정 조율']
  )
})

test('buildPromotionDisplayItems falls back to deduped AI promotion text when structured rows are absent', () => {
  assert.deepEqual(
    buildPromotionDisplayItems({
      promotion: ['  외부 홍보  ', '외부 홍보', '기관 방문'],
      recruiting: {},
    }),
    ['외부 홍보', '기관 방문']
  )
})

test('parseMiscSectionFromDiaryHtml parses two-column miscellaneous table', () => {
  const html =
    '<div class="doc_text editor">' +
    '<strong>4. 기타 사항</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>내용</td></tr>' +
    '<tr><td>고용센터 전달사항</td><td>- 4월15일 수원고용센터 간담회</td></tr>' +
    '<tr><td>지점 특이사항</td><td>- 없음</td></tr>' +
    '<tr><td>기타 건의사항</td><td>- 없음</td></tr>' +
    '</table>' +
    '</div>'

  assert.deepEqual(parseMiscSectionFromDiaryHtml(html), {
    title: '기타 사항',
    items: [
      { key: 'employment-center', label: '고용센터 전달사항', content: '- 4월15일 수원고용센터 간담회' },
      { key: 'branch-notes', label: '지점 특이사항', content: '- 없음' },
      { key: 'suggestions', label: '기타 건의사항', content: '- 없음' },
    ],
  })
})

test('parseMiscSectionFromDiaryHtml parses bullet-style miscellaneous blocks', () => {
  const html =
    '<div class="doc_text editor">' +
    '<table><tr><td>' +
    '<span><strong>○ 고용센터 전달사항</strong></span><br>' +
    '&lt;주무관 전달사항&gt;<br>' +
    '-청년 특화프로그램 수당 대상자확인 안내<br>' +
    '<span><strong>○ 지점사항:</strong>최나리 부장님 모니터5대 전달 완료</span><br>' +
    '<span><strong>○ 기타보고(건의사항)</strong></span><br>' +
    '</td></tr></table>' +
    '</div>'

  assert.deepEqual(parseMiscSectionFromDiaryHtml(html), {
    title: '기타 사항',
    items: [
      {
        key: 'employment-center',
        label: '고용센터 전달사항',
        content: '<주무관 전달사항>\n-청년 특화프로그램 수당 대상자확인 안내',
      },
      {
        key: 'branch-notes',
        label: '지점 특이사항',
        content: '최나리 부장님 모니터5대 전달 완료',
      },
    ],
  })
})

test('parseMiscSectionFromDiaryHtml normalizes broken miscellaneous title fragments to the default label', () => {
  const html =
    '<div class="doc_text editor">' +
    '<span style="font-family:맑은 고딕">4. 기타 사항</span>' +
    '<table>' +
    '<tr><td>구분</td><td>내용</td></tr>' +
    '<tr><td>고용센터 전달사항</td><td>- 수원고용센터 간담회</td></tr>' +
    '<tr><td>지점 특이사항</td><td>- 없음</td></tr>' +
    '<tr><td>기타 건의사항</td><td>- 없음</td></tr>' +
    '</table>' +
    '</div>'

  const parsed = parseMiscSectionFromDiaryHtml(html)

  assert.equal(parsed.title, '기타 사항')
})
