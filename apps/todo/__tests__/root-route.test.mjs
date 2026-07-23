import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { readCookieHeader } from '@pocketpages/test-support/auth-cookie'
import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({
    serviceName: 'todo',
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / redirects a guest to the sign-in page', async () => {
  const response = await fetch(`${service.baseUrl}/`)
  const body = await response.text()
  const $ = load(body)

  assert.equal(response.status, 200)
  assert.equal(new URL(response.url).pathname, '/sign-in')
  assert.equal($('h1').first().text().trim(), 'TODO 로그인')
  assert.equal($('[x-data="appToast"]').length, 1)
})

test('a signed-up user can create and complete a work', async () => {
  const email = `todo-${Date.now()}@example.com`
  const password = 'password1234'
  const signUpForm = new URLSearchParams({ email, password, passwordConfirm: password })
  const signUpResponse = await fetch(`${service.baseUrl}/xapi/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: signUpForm,
    redirect: 'manual',
  })
  const cookie = readCookieHeader(signUpResponse.headers)

  assert.equal(signUpResponse.status, 303)
  assert.ok(cookie)

  const createResponse = await fetch(`${service.baseUrl}/xapi/works/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ title: '통합 테스트 업무' }),
    redirect: 'manual',
  })

  assert.equal(createResponse.status, 303)

  const createLocation = createResponse.headers.get('location')
  assert.ok(createLocation)
  const homeResponse = await fetch(new URL(createLocation, service.baseUrl), { headers: { Cookie: cookie } })
  const homeBody = await homeResponse.text()
  const homePage = load(homeBody)
  const workCard = homePage('[data-work-card]')
    .filter((_, element) => homePage(element).text().includes('통합 테스트 업무'))
    .first()
  const workId = workCard.attr('data-work-id')

  assert.equal(homeResponse.status, 200, homeBody)
  assert.equal(homePage('h1').first().text().trim(), '오늘의 업무')
  assert.equal(homePage('[x-data="appToast"]').attr('data-initial-message'), '업무를 등록했습니다.')
  assert.ok(workId)

  const dashboardResponse = await fetch(`${service.baseUrl}/dashboard`, { headers: { Cookie: cookie } })
  const dashboardBody = await dashboardResponse.text()
  const dashboardPage = load(dashboardBody)

  assert.equal(dashboardResponse.status, 200, dashboardBody)
  assert.equal(dashboardPage('h1').first().text().trim(), '업무 현황')
  assert.equal(dashboardPage('section.grid article').first().find('p').first().text().trim(), '1')

  const saveSettingResponse = await fetch(`${service.baseUrl}/xapi/settings/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ days_before: '7' }),
    redirect: 'manual',
  })

  assert.equal(saveSettingResponse.status, 303)

  const settingResponse = await fetch(`${service.baseUrl}/setting`, { headers: { Cookie: cookie } })
  const settingBody = await settingResponse.text()
  const settingPage = load(settingBody)

  assert.equal(settingResponse.status, 200, settingBody)
  assert.equal(settingPage('input[name="days_before"]').attr('value'), '7')

  const detailResponse = await fetch(`${service.baseUrl}/works/${workId}`, { headers: { Cookie: cookie } })
  const detailBody = await detailResponse.text()
  const detailPage = load(detailBody)

  assert.equal(detailResponse.status, 200, detailBody)
  assert.equal(detailPage('#redmine-create-form input[name="work_id"]').attr('value'), workId)
  assert.equal(detailPage('#redmine-dialog').length, 1)
  assert.equal(detailPage('#scheduled-notification-time').length, 1)
  assert.equal(detailPage('input[form="scheduled-notification-create-form"][name="title"]').length, 0)
  assert.equal(detailPage('input[form="scheduled-notification-create-form"][name="message"]').length, 0)
  assert.equal(detailPage('#work-file[name="file"]').length, 1)
  assert.equal(detailPage('link[href*="filepond-4.32.12.min."]').length, 1)
  assert.equal(detailPage('script[src*="filepond-4.32.12.min."]').length, 1)

  const filePondAssetResponse = await fetch(`${service.baseUrl}/assets/vendor/filepond-4.32.12.min.js`)

  assert.equal(filePondAssetResponse.status, 200)

  const updateForm = new FormData()
  updateForm.set('work_id', workId)
  updateForm.set('title', '첨부파일 없이 수정한 업무')
  updateForm.set('state', 'wait')
  updateForm.set('developer', '')
  updateForm.set('due_date', '')
  updateForm.set('redmine', 'https://pms.kpcard.co.kr/issues/123')
  updateForm.set('joplin', 'joplin://x-callback-url/openNote?id=test-note')
  const updateResponse = await fetch(`${service.baseUrl}/xapi/works/update`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: updateForm,
    redirect: 'manual',
  })

  assert.equal(updateResponse.status, 303)
  assert.equal(updateResponse.headers.get('location')?.startsWith(`/works/${workId}`), true)

  const savedDetailResponse = await fetch(new URL(updateResponse.headers.get('location'), service.baseUrl), { headers: { Cookie: cookie } })
  const savedDetailPage = load(await savedDetailResponse.text())

  assert.equal(savedDetailResponse.status, 200)
  assert.equal(savedDetailPage('input[name="title"]').attr('value'), '첨부파일 없이 수정한 업무')
  assert.equal(savedDetailPage('a[aria-label="Redmine 이슈 열기"]').attr('href'), 'https://pms.kpcard.co.kr/issues/123')
  assert.equal(savedDetailPage('a[aria-label="Joplin 링크 열기"]').attr('href'), 'joplin://x-callback-url/openNote?id=test-note')

  const attachmentForm = new FormData()
  attachmentForm.set('work_id', workId)
  attachmentForm.set('title', '첨부파일을 추가한 업무')
  attachmentForm.set('state', 'wait')
  attachmentForm.set('developer', '')
  attachmentForm.set('due_date', '')
  attachmentForm.set('file', new Blob(['attachment contents'], { type: 'text/plain' }), 'attachment.txt')
  const attachmentUpdateResponse = await fetch(`${service.baseUrl}/xapi/works/update`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: attachmentForm,
    redirect: 'manual',
  })

  assert.equal(attachmentUpdateResponse.status, 303)

  const attachmentDetailResponse = await fetch(new URL(attachmentUpdateResponse.headers.get('location'), service.baseUrl), { headers: { Cookie: cookie } })
  const attachmentDetailBody = await attachmentDetailResponse.text()
  const attachmentDetailPage = load(attachmentDetailBody)
  const attachmentHref = attachmentDetailPage('a[aria-label="첨부파일 열기"]').attr('href')

  assert.equal(attachmentDetailResponse.status, 200, attachmentDetailBody)
  assert.equal(attachmentDetailPage('a[aria-label="첨부파일 열기"]').text().trim().includes('attachment.txt'), true)
  assert.equal(attachmentHref?.startsWith(`/api/files/works/${workId}/`), true)

  const attachmentResponse = await fetch(new URL(attachmentHref, service.baseUrl))

  assert.equal(attachmentResponse.status, 200)
  assert.equal(await attachmentResponse.text(), 'attachment contents')

  const scheduleResponse = await fetch(`${service.baseUrl}/xapi/scheduled-notifications/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ work_id: workId, time: '2030-01-02T09:30' }),
    redirect: 'manual',
  })

  assert.equal(scheduleResponse.status, 303)

  const scheduledDetailResponse = await fetch(new URL(scheduleResponse.headers.get('location'), service.baseUrl), { headers: { Cookie: cookie } })
  const scheduledDetailPage = load(await scheduledDetailResponse.text())

  assert.equal(scheduledDetailPage('button[name="scheduled_id"]').length, 1)

  const completeResponse = await fetch(`${service.baseUrl}/xapi/works/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'HX-Request': 'true' },
    body: new URLSearchParams({ work_id: workId }),
  })
  const completeBody = await completeResponse.text()

  assert.equal(completeResponse.status, 200)
  assert.deepEqual(JSON.parse(completeResponse.headers.get('hx-trigger')), {
    'app-toast': {
      message: '업무를 완료했습니다.',
      tone: 'success',
    },
  })
  assert.equal(completeBody.includes('통합 테스트 업무'), false)
})

test('Redmine API requires authentication', async () => {
  const showResponse = await fetch(`${service.baseUrl}/api/redmine/123`)
  const showPayload = await showResponse.json()
  const updateResponse = await fetch(`${service.baseUrl}/api/redmine/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '123' }),
  })
  const updatePayload = await updateResponse.json()

  assert.equal(showResponse.status, 401)
  assert.equal(showPayload.ok, false)
  assert.equal(updateResponse.status, 401)
  assert.equal(updatePayload.ok, false)
})
