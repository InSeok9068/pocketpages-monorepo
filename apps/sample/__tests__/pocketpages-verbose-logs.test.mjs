import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { readCookieHeader } from '@pocketpages/test-support/auth-cookie';
import { startService } from '@pocketpages/test-support/service-harness';

const PORT = 18093;
const PASSWORD = 'verbose-log-password-1234';
const GARBAGE_COOKIE = 'garbage-cookie-value-verbose';
const INVALID_TOKEN = 'invalid.token.verbose';

let service;
let logs = '';
let authToken = '';

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

before(async () => {
  process.env.PB_SDK_HOST = `http://127.0.0.1:${PORT}`;
  process.env.PP_DEBUG = 'verbose';
  service = await startService({
    serviceName: 'sample',
    port: PORT,
  });

  const startAt = service.output().length;
  const email = `verbose-${Date.now()}@example.com`;
  const registerResponse = await postForm('/xapi/lab/auth/register', { email, password: PASSWORD });
  const cookieHeader = readCookieHeader(registerResponse.headers);

  authToken = JSON.parse(decodeURIComponent(cookieHeader.split('pb_auth=')[1].split(';')[0])).token;

  await (await fetch(`${service.baseUrl}/api/lab/auth-state`, { headers: { Cookie: cookieHeader } })).text();
  await (await postForm('/xapi/lab/auth/sign-in', { email, password: PASSWORD })).text();
  await (await postForm('/xapi/lab/auth/anonymous', {})).text();
  await (await fetch(`${service.baseUrl}/api/lab/auth-state`, { headers: { Cookie: `pb_auth=${GARBAGE_COOKIE}` } })).text();
  await (
    await fetch(`${service.baseUrl}/api/lab/auth-state`, {
      headers: { Cookie: `pb_auth=${encodeURIComponent(JSON.stringify({ token: INVALID_TOKEN }))}` },
    })
  ).text();
  await (await fetch(`${service.baseUrl}/lab`)).text();
  await delay(300);

  logs = service.output().slice(startAt);
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

test('verbose debug logging is actually enabled for request handling', () => {
  assert.match(logs, /Pages middleware request: POST \/xapi\/lab\/auth\/register/);
  assert.match(logs, /signing in and saving pb_auth cookie: \w+/);
  assert.match(logs, /creating passwordless user/);
  assert.match(logs, /invalid auth cookie format/);
  assert.match(logs, /error fetching auth record/);
  assert.match(logs, /created new PocketBase client for http:\/\/127\.0\.0\.1:\d+ with saved auth: \w+/);
});

test('auth tokens, passwords, and raw auth cookies never appear in verbose logs', () => {
  assert.ok(authToken.length > 20);
  assert.equal(logs.includes(authToken), false);
  assert.equal(logs.includes(PASSWORD), false);
  assert.equal(logs.includes(GARBAGE_COOKIE), false);
  assert.equal(logs.includes(INVALID_TOKEN), false);
  assert.doesNotMatch(logs, /paswordless user: /);
  assert.doesNotMatch(logs, /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/);
});

test('JS SDK client logs keep only the auth record id', () => {
  assert.doesNotMatch(logs, /with saved auth: \w+ \S/);
  assert.doesNotMatch(logs, /DEBUG auth object/);
});

test('core response logs keep header and cookie names only', () => {
  assert.match(logs, /DEBUG header: X-Lab-Page\s*$/m);
  assert.match(logs, /DEBUG cookie: lab_seen\s*$/m);
  assert.match(logs, /DEBUG cookie: pb_auth\s*$/m);
  assert.doesNotMatch(logs, /DEBUG header: \S+ \S/);
  assert.doesNotMatch(logs, /DEBUG cookie: \S+=/);
});
