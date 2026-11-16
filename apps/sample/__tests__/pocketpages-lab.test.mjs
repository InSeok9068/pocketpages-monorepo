import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { readCookieHeader } from '@pocketpages/test-support/auth-cookie';
import { startService } from '@pocketpages/test-support/service-harness';

const PORT = 18092;

let service;

before(async () => {
  process.env.PB_SDK_HOST = `http://127.0.0.1:${PORT}`;
  service = await startService({
    serviceName: 'sample',
    port: PORT,
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function postForm(path, fields, headers = {}) {
  return fetch(`${service.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

async function readAuthState(headers = {}) {
  const response = await fetch(`${service.baseUrl}/api/lab/auth-state`, { headers });
  const payload = await response.json();

  assert.equal(response.status, 200);

  return { response, payload };
}

function readPbAuthToken(cookieHeader) {
  const raw = cookieHeader
    .split('; ')
    .find((pair) => pair.startsWith('pb_auth='))
    .slice('pb_auth='.length);

  return JSON.parse(decodeURIComponent(raw)).token;
}

function isClearedPbAuth(response) {
  return response.headers.getSetCookie().some((value) => /^pb_auth=;/.test(value) && /Max-Age=0/.test(value));
}

async function registerUser() {
  const email = `${uniqueId('lab-user')}@example.com`;
  const password = 'lab-password-1234';
  const response = await postForm('/xapi/lab/auth/register', { email, password });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/lab/auth?__flash=Registered.');

  const cookieHeader = readCookieHeader(response.headers);

  assert.match(cookieHeader, /pb_auth=/);

  return { email, password, cookieHeader };
}

test('nested layout, request context, cookies, response headers, and nested partials render', async () => {
  const response = await fetch(`${service.baseUrl}/lab?q=${encodeURIComponent('<b>x</b>')}`, {
    headers: {
      'X-Lab': 'header-value',
      Cookie: `lab_pref=${encodeURIComponent(JSON.stringify({ theme: 'dark' }))}`,
    },
  });
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-lab-page'), 'rendered');
  assert.ok(response.headers.getSetCookie().some((value) => value.startsWith('lab_seen=')));
  assert.equal($('title').text().trim(), 'PocketPages Lab');
  assert.equal($('main > #lab-layout h1').first().text().trim(), 'PocketPages Lab');
  assert.equal($('[data-lab="query"]').text().trim(), '<b>x</b>');
  assert.equal(body.includes('<b>x</b>'), false);
  assert.match(body, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal($('[data-lab="header"]').text().trim(), 'header-value');
  assert.equal($('[data-lab="method"]').text().trim(), 'GET');
  assert.equal($('[data-lab="cookie"]').text().trim(), 'dark');
  assert.equal($('[data-lab="url"]').text().trim(), 'lab');
  assert.equal($('[data-lab="stringify"]').text().trim(), '{"lab":"ok"}');
  assert.equal($('[data-lab="env"]').text().trim(), 'development');
  assert.equal($('[data-lab="card"] h2').text().trim(), 'Lab card');
  assert.equal($('[data-lab="card"] [data-lab="badge"]').text().trim(), 'nested');
});

test('+load.js runs for every method and +post.js runs after it only for POST', async () => {
  const getResponse = await fetch(`${service.baseUrl}/lab/loader`);
  const get$ = load(await getResponse.text());

  assert.equal(getResponse.status, 200);
  assert.equal(get$('[data-lab="loaded-by"]').text().trim(), 'load');
  assert.equal(get$('[data-lab="posted-note"]').text().trim(), '');

  const postResponse = await postForm('/lab/loader', { note: 'posted note' });
  const post$ = load(await postResponse.text());

  assert.equal(postResponse.status, 200);
  assert.equal(post$('[data-lab="loaded-by"]').text().trim(), 'load');
  assert.equal(post$('[data-lab="posted-note"]').text().trim(), 'posted note');
  assert.equal(post$('[data-lab="loaded-before-post"]').text().trim(), 'load');
});

test('JSON, form, and query input are parsed for POST, PUT, and DELETE', async () => {
  const jsonResponse = await fetch(`${service.baseUrl}/api/lab/echo?q=search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lab': 'json',
      Cookie: `lab_pref=${encodeURIComponent(JSON.stringify({ theme: 'light' }))}`,
    },
    body: JSON.stringify({ a: 1, nested: { b: [1, 2] } }),
  });
  const jsonPayload = await jsonResponse.json();

  assert.equal(jsonResponse.status, 201);
  assert.match(jsonResponse.headers.get('content-type') || '', /^application\/json/);
  assert.equal(jsonResponse.headers.get('x-lab-echo'), 'POST');
  assert.deepEqual(jsonPayload, {
    method: 'POST',
    pathname: '/api/lab/echo',
    query: { q: 'search' },
    header: 'json',
    body: { a: 1, nested: { b: [1, 2] } },
    formData: { a: 1, nested: { b: [1, 2] } },
    cookie: { theme: 'light' },
  });

  const putResponse = await fetch(`${service.baseUrl}/api/lab/echo`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ x: '1', y: 'two' }),
  });
  const putPayload = await putResponse.json();

  assert.equal(putResponse.status, 201);
  assert.equal(putPayload.method, 'PUT');
  assert.deepEqual(putPayload.body, { x: 1, y: 'two' });
  assert.deepEqual(putPayload.formData, putPayload.body);

  const deleteResponse = await fetch(`${service.baseUrl}/api/lab/echo`, { method: 'DELETE' });
  const deletePayload = await deleteResponse.json();

  assert.equal(deleteResponse.status, 201);
  assert.equal(deletePayload.method, 'DELETE');
  assert.deepEqual(deletePayload.body, {});
});

test('page output that looks like JSON is answered as JSON without a layout', async () => {
  const response = await fetch(`${service.baseUrl}/api/lab/auto-json`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  assert.deepEqual(payload, { auto: true, items: [1, 2, 3] });
});

test('echo() writes to the response before template output', async () => {
  const response = await fetch(`${service.baseUrl}/xapi/lab/echo`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body.trim(), /^echo-first\|\s*<span data-lab="template">template-after<\/span>$/);
});

test('store() persists values across requests and shares $app.store()', async () => {
  const first = await (await fetch(`${service.baseUrl}/api/lab/store`)).json();
  const second = await (await fetch(`${service.baseUrl}/api/lab/store`)).json();

  assert.equal(second.count, first.count + 1);
  assert.equal(second.appStoreCount, second.count);
});

test('redirect() uses 302 by default, honors status, and adds the flash message', async () => {
  const defaultResponse = await fetch(`${service.baseUrl}/xapi/lab/redirect`, { redirect: 'manual' });

  assert.equal(defaultResponse.status, 302);
  assert.equal(defaultResponse.headers.get('location'), '/lab?__flash=Lab%20redirect%20default');

  const seeOtherResponse = await fetch(`${service.baseUrl}/xapi/lab/redirect?status=303&to=loader`, {
    redirect: 'manual',
  });

  assert.equal(seeOtherResponse.status, 303);
  assert.equal(seeOtherResponse.headers.get('location'), '/lab/loader?__flash=Lab%20redirect%20303');
});

test('$app.runInTransaction commits together and rolls back together', async () => {
  const commitSlug = uniqueId('lab-tx-commit');
  const commitPayload = await (await postForm('/api/lab/transaction', { mode: 'commit', slug: commitSlug })).json();

  assert.deepEqual(commitPayload, { mode: 'commit', rolledBack: false, boardExists: true, postCount: 1 });

  const rollbackSlug = uniqueId('lab-tx-rollback');
  const rollbackPayload = await (
    await postForm('/api/lab/transaction', { mode: 'rollback', slug: rollbackSlug })
  ).json();

  assert.deepEqual(rollbackPayload, { mode: 'rollback', rolledBack: true, boardExists: false, postCount: 0 });
});

test('realtime plugin sends only to clients subscribed to the topic', async () => {
  const controller = new AbortController();
  const sseResponse = await fetch(`${service.baseUrl}/api/realtime`, { signal: controller.signal });
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  async function readUntil(pattern) {
    const timeoutAt = Date.now() + 5000;

    while (!pattern.test(received)) {
      if (Date.now() > timeoutAt) {
        throw new Error(`timed out waiting for ${pattern}: ${received}`);
      }

      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      received += decoder.decode(chunk.value, { stream: true });
    }
  }

  try {
    await readUntil(/"clientId"\s*:\s*"[^"]+"/);

    const clientId = received.match(/"clientId"\s*:\s*"([^"]+)"/)[1];
    const topic = uniqueId('lab-topic');
    const subscribeResponse = await fetch(`${service.baseUrl}/api/realtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, subscriptions: [topic] }),
    });

    assert.equal(subscribeResponse.status, 204);

    const otherSend = await postForm('/api/lab/realtime-send', { topic: `${topic}-other`, message: 'not-for-me' });

    assert.equal(otherSend.status, 200);

    const send = await postForm('/api/lab/realtime-send', { topic, message: 'lab-realtime-message' });

    assert.equal(send.status, 200);

    await readUntil(/lab-realtime-message/);

    assert.match(received, new RegExp(`event:\\s*${topic}\\s`));
    assert.doesNotMatch(received, /not-for-me/);
  } finally {
    controller.abort();
  }
});

test('auth plugin registers, reads the cookie, calls the JS SDK with the token, and signs out', async () => {
  const user = await registerUser();
  const { payload } = await readAuthState({ Cookie: user.cookieHeader });

  assert.equal(payload.signedIn, true);
  assert.equal(payload.email, user.email);
  assert.equal(payload.collection, 'users');
  assert.equal(payload.sdkEmail, user.email);
  assert.equal(payload.sdkError, '');

  const pageResponse = await fetch(`${service.baseUrl}/lab/auth`, { headers: { Cookie: user.cookieHeader } });
  const page$ = load(await pageResponse.text());

  assert.equal(page$('[data-lab="auth-email"]').text().trim(), user.email);

  const signOutResponse = await postForm('/xapi/lab/auth/sign-out', {}, { Cookie: user.cookieHeader });

  assert.equal(signOutResponse.status, 303);
  assert.equal(signOutResponse.headers.get('location'), '/lab/auth?__flash=Signed%20out.');
  assert.equal(isClearedPbAuth(signOutResponse), true);
});

test('auth plugin signs in with password and rejects a wrong password', async () => {
  const user = await registerUser();
  const wrongResponse = await postForm('/xapi/lab/auth/sign-in', { email: user.email, password: 'wrong-password-1' });

  assert.equal(wrongResponse.status, 303);
  assert.equal(wrongResponse.headers.get('location'), '/lab/auth?__flash=Sign%20in%20failed.');
  assert.equal(readCookieHeader(wrongResponse.headers).includes('pb_auth='), false);

  const signInResponse = await postForm('/xapi/lab/auth/sign-in', { email: user.email, password: user.password });

  assert.equal(signInResponse.status, 303);
  assert.equal(signInResponse.headers.get('location'), '/lab/auth?__flash=Signed%20in.');

  const { payload } = await readAuthState({ Cookie: readCookieHeader(signInResponse.headers) });

  assert.equal(payload.email, user.email);
});

test('auth plugin signs in anonymously', async () => {
  const response = await postForm('/xapi/lab/auth/anonymous', {});

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/lab/auth?__flash=Anonymous%20signed%20in.');

  const { payload } = await readAuthState({ Cookie: readCookieHeader(response.headers) });

  assert.equal(payload.signedIn, true);
  assert.match(payload.email, /^anonymous-\d+@example\.com$/);
});

test('middleware guard redirects guests and passes auth data to signed-in users', async () => {
  const guestResponse = await fetch(`${service.baseUrl}/lab/auth/private`, { redirect: 'manual' });

  assert.equal(guestResponse.status, 303);
  assert.equal(guestResponse.headers.get('location'), '/lab/auth?__flash=Sign%20in%20required.');

  const user = await registerUser();
  const response = await fetch(`${service.baseUrl}/lab/auth/private`, {
    headers: { Cookie: user.cookieHeader },
    redirect: 'manual',
  });
  const $ = load(await response.text());

  assert.equal(response.status, 200);
  assert.equal($('[data-lab="private-email"]').text().trim(), user.email);
});

test('PocketBase Authorization header sets request.auth without a cookie', async () => {
  const user = await registerUser();
  const token = readPbAuthToken(user.cookieHeader);
  const { payload } = await readAuthState({ Authorization: token });

  assert.equal(payload.signedIn, true);
  assert.equal(payload.email, user.email);
  assert.equal(payload.sdkEmail, user.email);
});

test('auth cookie with invalid JSON or a non-auth token is rejected and cleared', async () => {
  const garbage = await readAuthState({ Cookie: 'pb_auth=not-json' });

  assert.equal(garbage.payload.signedIn, false);
  assert.equal(isClearedPbAuth(garbage.response), true);

  const user = await registerUser();
  const authToken = readPbAuthToken(user.cookieHeader);
  const fileTokenResponse = await fetch(`${service.baseUrl}/api/files/token`, {
    method: 'POST',
    headers: { Authorization: authToken },
  });
  const fileToken = (await fileTokenResponse.json()).token;

  assert.equal(fileTokenResponse.status, 200);
  assert.ok(fileToken);

  const fileTokenCookie = `pb_auth=${encodeURIComponent(JSON.stringify({ token: fileToken }))}`;
  const rejected = await readAuthState({ Cookie: fileTokenCookie });

  assert.equal(rejected.payload.signedIn, false);
  assert.equal(isClearedPbAuth(rejected.response), true);
});

test('loader response stops later loaders and page rendering', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${service.baseUrl}/lab/loader?stop=1`, {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      ...(method === 'POST' ? { body: new URLSearchParams({ note: 'ignored' }) } : {}),
    });
    const payload = await response.json();

    assert.equal(response.status, 200, method);
    assert.match(response.headers.get('content-type') || '', /^application\/json/);
    assert.deepEqual(payload, { stoppedBy: 'load' });
  }
});

test('page response skips layouts, but a Content-Type header alone does not', async () => {
  const jsonResponse = await fetch(`${service.baseUrl}/lab/respond?mode=json`);

  assert.equal(jsonResponse.status, 202);
  assert.deepEqual(await jsonResponse.json(), { respondedBy: 'page' });

  const htmlResponse = await fetch(`${service.baseUrl}/lab/respond?mode=html`);
  const htmlBody = await htmlResponse.text();

  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlBody.trim(), '<p data-lab="raw-html">raw html</p>');

  const headerResponse = await fetch(`${service.baseUrl}/lab/respond?mode=content-type`);
  const header$ = load(await headerResponse.text());

  assert.equal(headerResponse.status, 200);
  assert.equal(header$('main > #lab-layout [data-lab="respond-mode"]').text().trim(), 'content-type');
});

test('resolve() and include() pick the nearest _private and fall back to parents', async () => {
  const response = await fetch(`${service.baseUrl}/lab/scope`);
  const $ = load(await response.text());

  assert.equal(response.status, 200);
  assert.equal($('[data-lab="module-scope"]').text().trim(), 'nearest');
  assert.equal($('[data-lab="partial-scope"]').text().trim(), 'nearest');
  assert.equal($('[data-lab="badge"]').text().trim(), 'parent');

  const rootResponse = await fetch(`${service.baseUrl}/lab/scope-root`);
  const root$ = load(await rootResponse.text());

  assert.equal(rootResponse.status, 200);
  assert.equal(root$('[data-lab="module-scope"]').text().trim(), 'root');
});

test('include() rejects parent traversal, backslash traversal, and drive paths', async () => {
  const response = await fetch(`${service.baseUrl}/lab/scope`);
  const body = await response.text();
  const $ = load(body);
  const results = $('[data-lab="traversal"]')
    .map((_, element) => $(element).text().trim())
    .get();

  assert.equal(response.status, 200);
  assert.deepEqual(results, ['rejected', 'rejected', 'rejected']);
  assert.doesNotMatch(body, /leaked/);
});

test('custom pb_hooks routes and record hooks run alongside PocketPages', async () => {
  const hookResponse = await fetch(`${service.baseUrl}/lab-hook`);

  assert.equal(hookResponse.status, 200);
  assert.deepEqual(await hookResponse.json(), {
    hook: 'routerAdd',
    stringified: '{"via":"globalApi"}',
  });

  const slug = uniqueId('hooked');
  const createResponse = await postForm('/xapi/boards/create', { name: 'Hooked Board', slug, description: 'original' });

  assert.equal(createResponse.status, 303);

  const boardResponse = await fetch(`${service.baseUrl}/api/boards/${slug}`);
  const boardPayload = await boardResponse.json();

  assert.equal(boardResponse.status, 200);
  assert.equal(boardPayload.board.description, 'set by onRecordCreate');
});

test('multipart form fields are parsed by body() and formData()', async () => {
  const form = new FormData();

  form.set('title', 'multipart title');
  form.set('count', '3');

  const response = await fetch(`${service.baseUrl}/api/lab/echo`, { method: 'POST', body: form });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(payload.body, { title: 'multipart title', count: 3 });
  assert.deepEqual(payload.formData, payload.body);
});
