import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

let service;

before(async () => {
  process.env.APP_ENV = 'production';
  service = await startService({
    serviceName: 'sample',
    port: 18091,
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

test('production pages render repeatedly with the compiled template cache', async () => {
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${service.baseUrl}/`);
    const $ = load(await response.text());

    assert.equal(response.status, 200);
    assert.equal($('h1').first().text().trim(), 'PocketPages Board');
    assert.equal($('link[href*="/assets/uno.min."]').length, 1);
  }
});

test('production cached templates do not leak request data between requests', async () => {
  const marker = `contract-flash-${Date.now()}`;
  const flashResponse = await fetch(`${service.baseUrl}/boards?__flash=${encodeURIComponent(marker)}`);
  const flashBody = await flashResponse.text();

  assert.equal(flashResponse.status, 200);
  assert.match(flashBody, new RegExp(marker));

  const plainResponse = await fetch(`${service.baseUrl}/boards`);
  const plainBody = await plainResponse.text();

  assert.equal(plainResponse.status, 200);
  assert.doesNotMatch(plainBody, new RegExp(marker));
});

test('production fingerprint assets are immutable and original URLs are not', async () => {
  const pageResponse = await fetch(`${service.baseUrl}/`);
  const $ = load(await pageResponse.text());
  const fingerprintHref = $('link[href*="/assets/uno.min."]').first().attr('href') || '';

  assert.match(fingerprintHref, /^\/assets\/uno\.min\.[^/]+\.css$/);

  const fingerprintResponse = await fetch(`${service.baseUrl}${fingerprintHref}`);
  await fingerprintResponse.arrayBuffer();

  assert.equal(fingerprintResponse.status, 200);
  assert.equal(fingerprintResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const originalResponse = await fetch(`${service.baseUrl}/assets/uno.min.css`);
  await originalResponse.arrayBuffer();

  assert.equal(originalResponse.status, 200);
  assert.doesNotMatch(originalResponse.headers.get('cache-control') || '', /immutable/);
});

test('production error boundary hides exception details', async () => {
  const response = await fetch(`${service.baseUrl}/api/error-lab/throw`);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error, 'Global error boundary caught an unhandled exception.');
  assert.equal(payload.message, '');

  const pageResponse = await fetch(`${service.baseUrl}/error-lab/page-throw`);
  const pageBody = await pageResponse.text();

  assert.equal(pageResponse.status, 500);
  assert.doesNotMatch(pageBody, /Page throw from EJS route/);
});
