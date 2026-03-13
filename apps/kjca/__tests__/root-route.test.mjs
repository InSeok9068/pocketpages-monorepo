import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '../../../scripts/test-support/service-harness.mjs';

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
});
