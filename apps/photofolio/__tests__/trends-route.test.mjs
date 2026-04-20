import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

let service;

before(async () => {
  service = await startService({
    serviceName: 'photofolio',
    timeoutMs: 30000,
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

test('GET /trends renders the trend page without template errors', async () => {
  const response = await fetch(`${service.baseUrl}/trends?range=1y`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal($('h1').first().text().trim(), '추이');
  assert.equal(body.includes('원/달러 환율'), true);
  assert.equal(body.includes('미국 기준금리 · 국채 금리'), true);
  assert.equal(body.includes('실업률'), true);
  assert.equal(body.includes('CPI 상승률'), true);
  assert.equal(body.includes('조회 '), true);
  assert.equal(body.includes('PocketPages Error'), false);
});
