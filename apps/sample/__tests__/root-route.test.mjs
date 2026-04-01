import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

let service;

before(async () => {
  service = await startService({
    serviceName: 'sample',
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

test('GET / returns the sample home page', async () => {
  const response = await fetch(`${service.baseUrl}/`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal($('h1').first().text().trim(), 'PocketPages Board');
  assert.equal($('a[href="/boards"]').first().text().trim(), 'Go to boards');
});

test('GET /patterns returns the pattern reference page', async () => {
  const response = await fetch(`${service.baseUrl}/patterns`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal($('h1').first().text().trim(), 'Sample Workspace');
  assert.equal($('a[href="/"]').first().text().trim(), 'Home');
});

test('GET /api/boards/list returns board list json', async () => {
  const response = await fetch(`${service.baseUrl}/api/boards/list?limit=5`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  assert.equal(payload.meta.limit, 5);
  assert.ok(Array.isArray(payload.items));
});

test('GET /api/boards/[boardSlug] returns board snapshot json', async () => {
  const boardSlug = `api-board-snapshot-${Date.now()}`;
  const boardName = 'API Board Snapshot';
  const createResponse = await fetch(`${service.baseUrl}/xapi/boards/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      name: boardName,
      slug: boardSlug,
      description: 'JSON example board',
    }),
    redirect: 'manual',
  });

  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get('location'), '/boards?__flash=Board%20created.');

  const response = await fetch(`${service.baseUrl}/api/boards/${boardSlug}?limit=3`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  assert.equal(payload.board.slug, boardSlug);
  assert.equal(payload.board.name, boardName);
  assert.equal(payload.meta.recentLimit, 3);
  assert.equal(payload.stats.totalPosts, 0);
  assert.deepEqual(payload.recentPosts, []);
});
