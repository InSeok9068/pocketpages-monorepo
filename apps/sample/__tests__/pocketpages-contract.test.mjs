import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

let service;

before(async () => {
  service = await startService({
    serviceName: 'sample',
    port: 18090,
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

function uniqueSlug(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function postForm(path, fields) {
  return fetch(`${service.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

async function createBoard(name) {
  const slug = uniqueSlug('contract-board');
  const response = await postForm('/xapi/boards/create', {
    name,
    slug,
    description: 'contract test board',
  });

  assert.equal(response.status, 303);

  return slug;
}

test('PocketBase built-in /api/health keeps working next to PocketPages routes', async () => {
  const response = await fetch(`${service.baseUrl}/api/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  assert.equal(payload.code, 200);
});

test('unknown routes and _private files are not served', async () => {
  const paths = [
    '/contract-missing-route',
    '/_private/board-service.js',
    '/_private/board-service',
    '/_private/flash-alert.ejs',
    '/_private/flash-alert',
    '/_private/roles/board.js',
  ];

  for (const path of paths) {
    const response = await fetch(`${service.baseUrl}${path}`, { redirect: 'manual' });
    const body = await response.text();

    assert.equal(response.status, 404, path);
    assert.doesNotMatch(body, /module\.exports|findActiveBoardBySlug|params\.__flash/, path);
  }
});

test('static assets are served and asset() fingerprint URLs resolve', async () => {
  const plainResponse = await fetch(`${service.baseUrl}/assets/style.css`);

  assert.equal(plainResponse.status, 200);
  assert.match(plainResponse.headers.get('content-type') || '', /^text\/css/);
  await plainResponse.arrayBuffer();

  const pageResponse = await fetch(`${service.baseUrl}/`);
  const $ = load(await pageResponse.text());
  const stylesheetHref = $('link[rel="stylesheet"]').first().attr('href') || '';

  assert.match(stylesheetHref, /^\/assets\/style\.[^/]+\.css$/);

  const fingerprintResponse = await fetch(`${service.baseUrl}${stylesheetHref}`);

  assert.equal(fingerprintResponse.status, 200);
  assert.match(fingerprintResponse.headers.get('content-type') || '', /^text\/css/);
  assert.doesNotMatch(fingerprintResponse.headers.get('cache-control') || '', /immutable/);
  await fingerprintResponse.arrayBuffer();
});

test('named slots render into the layout head and body', async () => {
  const response = await fetch(`${service.baseUrl}/datastar`);
  const $ = load(await response.text());

  assert.equal(response.status, 200);
  assert.ok($('head script[src*="datastar"]').length >= 1);
  assert.equal($('main h1').first().text().trim(), 'PocketPages Datastar Sample');
  assert.equal($('title').text().trim(), 'Datastar Sample');
});

test('form POST reads body(), redirects with message, and GET shows the flash', async () => {
  const boardName = 'Contract Flash Board';
  const slug = uniqueSlug('contract-flash');
  const createResponse = await postForm('/xapi/boards/create', {
    name: boardName,
    slug,
    description: 'flash',
  });
  const location = createResponse.headers.get('location') || '';

  assert.equal(createResponse.status, 303);
  assert.equal(location, '/boards?__flash=Board%20created.');

  const listResponse = await fetch(`${service.baseUrl}${location}`);
  const $ = load(await listResponse.text());

  assert.equal(listResponse.status, 200);
  assert.ok($('p').filter((_, element) => $(element).text().trim() === 'Board created.').length === 1);
  assert.ok($('td').filter((_, element) => $(element).text().trim() === boardName).length === 1);

  const plainResponse = await fetch(`${service.baseUrl}/boards`);
  const plainBody = await plainResponse.text();

  assert.equal(plainResponse.status, 200);
  assert.doesNotMatch(plainBody, /Board created\./);
});

test('validation failure redirects back with an error flash', async () => {
  const response = await postForm('/xapi/boards/create', { name: '', slug: '' });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/boards?__flash=Board%20name%20is%20required.');
});

test('route params and hierarchical middleware data reach the page', async () => {
  const boardName = 'Contract Param Board';
  const slug = await createBoard(boardName);
  const response = await fetch(`${service.baseUrl}/boards/${slug}`);
  const $ = load(await response.text());

  assert.equal(response.status, 200);
  assert.equal($('title').text().trim(), `${boardName} | PocketPages Board`);

  const missingResponse = await fetch(`${service.baseUrl}/boards/${uniqueSlug('missing')}`);
  const missing$ = load(await missingResponse.text());

  assert.equal(missingResponse.status, 404);
  assert.equal(missing$('h1').first().text().trim(), 'Board not found');
});

test('post create, nested middleware page, HTMX partial, and delete keep working', async () => {
  const boardSlug = await createBoard('Contract Post Board');
  const postTitle = 'Contract Post Title';
  const postSlug = uniqueSlug('contract-post');
  const createResponse = await postForm('/xapi/posts/create', {
    board: boardSlug,
    title: postTitle,
    slug: postSlug,
    authorName: 'Contract Author',
    content: 'Contract post content',
    status: 'published',
  });
  const postPath = `/boards/${boardSlug}/posts/${postSlug}`;

  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get('location'), `${postPath}?__flash=Post%20created.`);

  const postResponse = await fetch(`${service.baseUrl}${postPath}`);
  const post$ = load(await postResponse.text());

  assert.equal(postResponse.status, 200);
  assert.equal(post$('title').text().trim(), `${postTitle} | Contract Post Board`);

  const panelResponse = await fetch(`${service.baseUrl}/xapi/posts/panel?board=${encodeURIComponent(boardSlug)}`, {
    headers: {
      'HX-Request': 'true',
    },
  });
  const panelBody = await panelResponse.text();

  assert.equal(panelResponse.status, 200);
  assert.match(panelResponse.headers.get('content-type') || '', /^text\/html/);
  assert.doesNotMatch(panelBody, /<!DOCTYPE|<html[\s>]|<head[\s>]|<main[\s>]/i);
  assert.match(panelBody, new RegExp(postTitle));

  const deleteResponse = await postForm('/xapi/posts/delete', {
    board: boardSlug,
    post: postSlug,
  });

  assert.equal(deleteResponse.status, 303);
  assert.equal(deleteResponse.headers.get('location'), `/boards/${boardSlug}?__flash=Post%20deleted.`);

  const deletedResponse = await fetch(`${service.baseUrl}${postPath}`);
  await deletedResponse.arrayBuffer();

  assert.equal(deletedResponse.status, 404);
});

test('PocketBase realtime SSE endpoint still connects', async () => {
  const controller = new AbortController();
  const response = await fetch(`${service.baseUrl}/api/realtime`, {
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  while (!/PB_CONNECT/.test(received)) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    received += decoder.decode(chunk.value, { stream: true });
  }

  controller.abort();

  assert.match(received, /event:\s*PB_CONNECT/);
  assert.match(received, /"clientId"/);
});

test('static route new.ejs wins over the sibling [postSlug] route', async () => {
  const boardName = 'Contract Static Route Board';
  const boardSlug = await createBoard(boardName);
  const response = await fetch(`${service.baseUrl}/boards/${boardSlug}/posts/new`);
  const $ = load(await response.text());

  assert.equal(response.status, 200);
  assert.equal($('title').text().trim(), `Write Post | ${boardName}`);
  assert.equal($('form input[name="board"]').attr('value'), boardSlug);
});

test('post edit page and update flow keep nested middleware data and redirect to the new slug', async () => {
  const boardSlug = await createBoard('Contract Edit Board');
  const postSlug = uniqueSlug('contract-edit');
  const createResponse = await postForm('/xapi/posts/create', {
    board: boardSlug,
    title: 'Before Edit',
    slug: postSlug,
    authorName: 'Contract Author',
    content: 'Before content',
    status: 'draft',
  });

  assert.equal(createResponse.status, 303);

  const editResponse = await fetch(`${service.baseUrl}/boards/${boardSlug}/posts/${postSlug}/edit`);
  const edit$ = load(await editResponse.text());

  assert.equal(editResponse.status, 200);
  assert.equal(edit$('input[name="title"]').attr('value'), 'Before Edit');
  assert.equal(edit$('input[name="post"]').attr('value'), postSlug);

  const nextSlug = `${postSlug}-updated`;
  const updateResponse = await postForm('/xapi/posts/update', {
    board: boardSlug,
    post: postSlug,
    title: 'After Edit',
    slug: nextSlug,
    authorName: 'Contract Author',
    content: 'After content',
    status: 'published',
  });
  const nextPath = `/boards/${boardSlug}/posts/${nextSlug}`;

  assert.equal(updateResponse.status, 303);
  assert.equal(updateResponse.headers.get('location'), `${nextPath}?__flash=Post%20updated.`);

  const updatedResponse = await fetch(`${service.baseUrl}${updateResponse.headers.get('location')}`);
  const updated$ = load(await updatedResponse.text());

  assert.equal(updatedResponse.status, 200);
  assert.equal(updated$('title').text().trim(), 'After Edit | Contract Edit Board');
  assert.ok(updated$('p').filter((_, element) => updated$(element).text().trim() === 'Post updated.').length === 1);

  const oldResponse = await fetch(`${service.baseUrl}/boards/${boardSlug}/posts/${postSlug}`);
  await oldResponse.arrayBuffer();

  assert.equal(oldResponse.status, 404);
});

test('HTMX board list partial reads the query and renders without a layout', async () => {
  const boardSlug = await createBoard('!AAA Contract HTMX List Board');
  const response = await fetch(`${service.baseUrl}/xapi/boards/list?board=${encodeURIComponent(boardSlug)}`, {
    headers: { 'HX-Request': 'true' },
  });
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /<!DOCTYPE|<html[\s>]|<head[\s>]|<main[\s>]/i);
  const selected = $(`[hx-push-url="/patterns?board=${boardSlug}"]`).closest('article');

  assert.equal(selected.length, 1);
  assert.match(selected.attr('class') || '', /border-stone-900 bg-white/);
});

test('HEAD requests on pages return headers without a body', async () => {
  const response = await fetch(`${service.baseUrl}/boards`, { method: 'HEAD' });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/html/);
  assert.equal(body, '');
});

test('trailing slash resolves to the same directory index route', async () => {
  const response = await fetch(`${service.baseUrl}/boards/`, { redirect: 'manual' });
  const $ = load(await response.text());

  assert.equal(response.status, 200);
  assert.equal($('h1').first().text().trim(), 'Boards');
});

test('development renders template changes without restarting the server', async () => {
  const probeFile = new URL('../pb_hooks/pages/xapi/lab/cache-probe.ejs', import.meta.url);
  const original = '<span data-lab="cache-probe">original</span>\n';
  const readProbe = async () => (await (await fetch(`${service.baseUrl}/xapi/lab/cache-probe`)).text()).trim();

  writeFileSync(probeFile, original);

  try {
    assert.equal(await readProbe(), '<span data-lab="cache-probe">original</span>');
    writeFileSync(probeFile, original.replace('original', 'modified'));
    assert.equal(await readProbe(), '<span data-lab="cache-probe">modified</span>');
  } finally {
    writeFileSync(probeFile, original);
  }
});
