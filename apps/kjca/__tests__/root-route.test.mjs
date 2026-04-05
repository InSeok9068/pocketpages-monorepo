import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

let service;

before(async () => {
  service = await startService({
    serviceName: 'kjca',
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

test('GET / returns the KJCA dashboard page', async () => {
  const response = await fetch(`${service.baseUrl}/`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal($('h1').first().text().trim(), 'KJCA 업무일지 자동 취합');
  assert.equal($('a[href="/sign-in"]').first().text().trim(), '로그인');
  assert.equal($('p').filter((_, element) => $(element).text().trim() === '관리자 로그인').length, 1);
  assert.equal($('input[type="week"][name="referenceWeek"]').length, 1);
  assert.equal($('form[hx-post="/xapi/kjca/collect-weekly-report-urls"]').length, 1);
  assert.equal(body.includes('주간 보고 원문 취합 실행'), true);
});

test('GET /sign-in returns the login page without template errors', async () => {
  const response = await fetch(`${service.baseUrl}/sign-in`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal($('title').text().trim(), 'KJCA 관리자 로그인');
  assert.equal($('h1').first().text().trim(), '관리자 로그인');
  assert.equal($('form[action="/xapi/auth/sign-in"]').length, 1);
  assert.equal(body.includes('PocketPages Error'), false);
});

test('GET / keeps weekly-only filters visible when collectionMode=weekly is requested', async () => {
  const response = await fetch(`${service.baseUrl}/?collectionMode=weekly&referenceWeek=2026-W13`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal(body.includes("collectionMode: 'weekly'"), true);
  assert.equal($('#kjca-dashboard-form').attr('style')?.includes('display: none;'), true);
  assert.equal($('form[hx-post="/xapi/kjca/collect-weekly-report-urls"]').attr('style')?.includes('display: none;'), false);
});
