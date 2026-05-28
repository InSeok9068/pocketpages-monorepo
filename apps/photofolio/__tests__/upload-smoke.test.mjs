import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(__dirname, '..');
const splitHelperPath = path.join(serviceDir, '__tests__', 'helpers', 'split_tall_capture.py');
const serviceEnv = parseEnvFile(path.join(serviceDir, '.env'));
const loginId = String(process.env.LOGIN_ID || serviceEnv.LOGIN_ID || '').trim();
const loginPw = String(process.env.LOGIN_PW || serviceEnv.LOGIN_PW || '').trim();
const geminiApiKey = String(process.env.GEMINI_APIKEY || process.env.GEMINI_API_KEY || serviceEnv.GEMINI_APIKEY || serviceEnv.GEMINI_API_KEY || '').trim();
const overviewImagePath =
  String(process.env.PHOTOFOLIO_SMOKE_OVERVIEW_IMAGE || '').trim() ||
  'C:/Users/kpcard/Desktop/KakaoTalk_20260417_143122684_01.jpg';
const detailImagePath =
  String(process.env.PHOTOFOLIO_SMOKE_DETAIL_IMAGE || '').trim() ||
  'C:/Users/kpcard/Desktop/KakaoTalk_20260417_143122684.jpg';
const canRunSmoke = !!(loginId && loginPw && geminiApiKey && existsSync(overviewImagePath) && existsSync(detailImagePath));

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

/**
 * .env 파일을 단순 key=value 구조로 읽습니다.
 * @param {string} envFilePath 환경 파일 경로입니다.
 * @returns {Record<string, string>} 읽은 환경 변수 맵입니다.
 */
function parseEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    return {};
  }

  const entries = {};
  const source = readFileSync(envFilePath, 'utf8');

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const separatorIndex = line.indexOf('=');

    if (!line || line.startsWith('#') || separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

/**
 * 응답의 Set-Cookie 헤더를 cookie request header로 바꿉니다.
 * @param {Response} response fetch 응답입니다.
 * @returns {string} 다음 요청에 붙일 cookie header입니다.
 */
function buildCookieHeaderFromResponse(response) {
  const headers = response.headers;
  const setCookieValues =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers.get('set-cookie')
        ? [headers.get('set-cookie')]
        : [];

  return setCookieValues
    .map((value) => String(value || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

/**
 * 업로드 파일 경로에서 mime type을 추론합니다.
 * @param {string} filePath 이미지 경로입니다.
 * @returns {string} mime type입니다.
 */
function inferMimeType(filePath) {
  const lowerPath = String(filePath || '').toLowerCase();

  if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (lowerPath.endsWith('.webp')) {
    return 'image/webp';
  }

  return 'image/png';
}

/**
 * 긴 캡처를 실제 업로드 전처리와 비슷하게 분할합니다.
 * @param {string} filePath 원본 이미지 경로입니다.
 * @param {number} sourceIndex 업로드 순서입니다.
 * @returns {string[]} 업로드할 분할 이미지 경로 목록입니다.
 */
function splitTallCapture(filePath, sourceIndex) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'photofolio-smoke-'));
  const commandResult = spawnSync('python', [splitHelperPath, filePath, tempDir, String(sourceIndex)], {
    encoding: 'utf8',
  });

  assert.equal(commandResult.status, 0, commandResult.stderr || '캡처 분할 helper 실행에 실패했습니다.');

  const splitPaths = String(commandResult.stdout || '')
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);

  assert.equal(splitPaths.length > 0, true, '분할된 이미지 경로를 찾지 못했습니다.');
  return splitPaths;
}

/**
 * 응답 JSON/문자열 필드를 객체로 정리합니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {Record<string, any>} 정규화된 객체입니다.
 */
function normalizeObjectField(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (Array.isArray(value)) {
    try {
      const decodedText = new TextDecoder('utf-8').decode(Uint8Array.from(value));
      return normalizeObjectField(decodedText);
    } catch {
      return {};
    }
  }

  if (typeof value === 'object') {
    return value;
  }

  return {};
}

/**
 * PocketBase 컬렉션 목록을 읽습니다.
 * @param {string} baseUrl 서비스 base URL입니다.
 * @param {string} collectionName 컬렉션 이름입니다.
 * @param {string} token PocketBase auth token입니다.
 * @param {Record<string, string>} query 추가 쿼리입니다.
 * @returns {Promise<any[]>} 레코드 목록입니다.
 */
async function listRecords(baseUrl, collectionName, token, query = {}) {
  const searchParams = new URLSearchParams({
    page: '1',
    perPage: '200',
    ...query,
  });
  const response = await fetch(`${baseUrl}/api/collections/${collectionName}/records?${searchParams.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200, `${collectionName} 목록 조회가 실패했습니다.`);
  return Array.isArray(body.items) ? body.items : [];
}

/**
 * 앱 로그인 경로로 세션 쿠키를 만듭니다.
 * @param {string} baseUrl 서비스 base URL입니다.
 * @returns {Promise<string>} 인증된 cookie header입니다.
 */
async function signInWithAppRoute(baseUrl) {
  const signInBody = new URLSearchParams({
    email: loginId,
    password: loginPw,
  });
  const response = await fetch(`${baseUrl}/xapi/auth/sign-in`, {
    method: 'POST',
    body: signInBody,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    redirect: 'manual',
  });
  const cookieHeader = buildCookieHeaderFromResponse(response);

  assert.equal(response.status, 303);
  assert.equal(String(response.headers.get('location') || '').startsWith('/'), true);
  assert.equal(cookieHeader.includes('pb_auth='), true, '로그인 응답에 pb_auth 쿠키가 없습니다.');

  return cookieHeader;
}

/**
 * PocketBase API 토큰을 발급받습니다.
 * @param {string} baseUrl 서비스 base URL입니다.
 * @returns {Promise<string>} API auth token입니다.
 */
async function signInWithApi(baseUrl) {
  const response = await fetch(`${baseUrl}/api/collections/users/auth-with-password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      identity: loginId,
      password: loginPw,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200, `PocketBase API 로그인 실패: ${JSON.stringify(body)}`);
  assert.equal(typeof body.token, 'string');
  assert.equal(body.token.length > 10, true);

  return body.token;
}

test(
  'photofolio smoke: sign-in, multi-image upload, asset edit, asset delete, and clear assets',
  {
    skip: !canRunSmoke,
    timeout: 180000,
  },
  async () => {
    const tempPathsToCleanup = [];
    const authPageResponse = await fetch(`${service.baseUrl}/auth`);
    const authPageBody = await authPageResponse.text();
    const authPage$ = load(authPageBody);

    assert.equal(authPageResponse.status, 200);
    assert.equal(authPageBody.includes('PocketPages Error'), false);
    assert.equal(authPage$('form[action="/xapi/auth/sign-in"]').length, 1);

    const cookieHeader = await signInWithAppRoute(service.baseUrl);
    const apiToken = await signInWithApi(service.baseUrl);
    const initialClearResponse = await fetch(`${service.baseUrl}/xapi/settings/clear-assets`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
      },
      redirect: 'manual',
    });

    assert.equal(initialClearResponse.status, 303);

    const beforeLatestSnapshots = await listRecords(service.baseUrl, 'asset_snapshots', apiToken, {
      sort: '-updated,-created',
    });
    const beforeLatestSnapshot = beforeLatestSnapshots[0] || null;
    const beforeLatestSnapshotId = beforeLatestSnapshot ? String(beforeLatestSnapshot.id || '') : '';
    const beforeCaptureCount = beforeLatestSnapshotId
      ? (
          await listRecords(service.baseUrl, 'snapshot_capture_images', apiToken, {
            filter: `snapshot_id="${beforeLatestSnapshotId}"`,
            sort: '-image_order,-created',
          })
        ).length
      : 0;

    const uploadFormData = new FormData();
    const splitOverviewPaths = splitTallCapture(overviewImagePath, 1);
    const splitDetailPaths = splitTallCapture(detailImagePath, 2);

    tempPathsToCleanup.push(...splitOverviewPaths.map((filePath) => path.dirname(filePath)));
    tempPathsToCleanup.push(...splitDetailPaths.map((filePath) => path.dirname(filePath)));

    for (const splitPath of [...splitOverviewPaths, ...splitDetailPaths]) {
      uploadFormData.append('captureImage', new File([readFileSync(splitPath)], path.basename(splitPath), { type: inferMimeType(splitPath) }));
    }

    const uploadResponse = await fetch(`${service.baseUrl}/xapi/snapshots/upload`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
      },
      body: uploadFormData,
      redirect: 'manual',
    });

    assert.equal(uploadResponse.status, 303);
    assert.equal(String(uploadResponse.headers.get('location') || '').startsWith('/'), true);

    const settingsResponse = await fetch(`${service.baseUrl}/settings`, {
      headers: {
        cookie: cookieHeader,
      },
    });
    const settingsBody = await settingsResponse.text();

    assert.equal(settingsResponse.status, 200);
    assert.equal(settingsBody.includes('PocketPages Error'), false);
    assert.equal(settingsBody.includes('자산 데이터 초기화'), true);

    const homeResponse = await fetch(`${service.baseUrl}/`, {
      headers: {
        cookie: cookieHeader,
      },
    });
    const homeBody = await homeResponse.text();

    assert.equal(homeResponse.status, 200);
    assert.equal(homeBody.includes('PocketPages Error'), false);
    assert.equal(homeBody.includes('로그아웃'), true);
    assert.equal(homeBody.includes('리밸런싱 차이'), true);
    assert.equal(homeBody.includes('자산 수정'), true);

    const latestSnapshots = await listRecords(service.baseUrl, 'asset_snapshots', apiToken, {
      sort: '-updated,-created',
    });
    const latestSnapshot = latestSnapshots[0];
    const latestSnapshotId = String(latestSnapshot.id || '');
    const rawPayload = normalizeObjectField(latestSnapshot.raw_payload_json);
    const captureSummaries = Array.isArray(rawPayload.captures) ? rawPayload.captures : [];
    const newCaptureIds = captureSummaries.map((item) => String(item.captureImageId || '')).filter(Boolean);

    assert.equal(latestSnapshotId.length > 0, true);
    assert.equal(Number(latestSnapshot.total_amount_krw || 0) >= 220000000, true);
    assert.equal(Number(latestSnapshot.total_amount_krw || 0) <= 300000000, true);
    assert.equal(Number(rawPayload.captureCount || 0), 2);
    assert.equal(captureSummaries.length, 2);
    assert.equal(Number(rawPayload.mergedItemCount || 0) > 0, true);
    assert.equal(captureSummaries.some((item) => Number(item.segmentCount || 0) >= 2), true);

    const latestCaptureRecords = await listRecords(service.baseUrl, 'snapshot_capture_images', apiToken, {
      filter: `snapshot_id="${latestSnapshotId}"`,
      sort: '-image_order,-created',
    });
    const newCaptureRecords = latestCaptureRecords.filter((record) => newCaptureIds.includes(String(record.id || '')));
    const newCapturePageTypes = new Set(newCaptureRecords.map((record) => String(record.page_type || '')));

    assert.equal(newCaptureRecords.length, 2);
    assert.equal(newCapturePageTypes.has('assets_overview'), true);
    assert.equal(
      [...newCapturePageTypes].some((pageType) => pageType === 'invest_overview' || pageType === 'invest_holdings'),
      true
    );
    assert.equal(latestCaptureRecords.length >= beforeCaptureCount + 2 || latestSnapshotId !== beforeLatestSnapshotId, true);

    const latestSectionRecords = await listRecords(service.baseUrl, 'snapshot_sections', apiToken, {
      filter: `snapshot_id="${latestSnapshotId}"`,
      sort: '-created',
    });
    const newSectionRecords = latestSectionRecords.filter((record) => newCaptureIds.includes(String(record.capture_image_id || '')));

    assert.equal(newSectionRecords.length >= 3, true);
    assert.equal(
      newSectionRecords.some((record) => String(record.section_label || '').includes('해외') || String(record.section_label || '').includes('국내')),
      true
    );

    const latestAssetItems = await listRecords(service.baseUrl, 'asset_items', apiToken, {
      filter: `snapshot_id="${latestSnapshotId}"`,
      sort: '-updated,-amount_krw',
    });
    const newAssetItems = latestAssetItems.filter((record) => newCaptureIds.includes(String(record.source_capture_image_id || '')));
    const extractedAssetNames = newAssetItems.map((record) => String(record.asset_name || '').trim()).filter(Boolean);
    const extractedAssetClasses = new Set(newAssetItems.map((record) => String(record.asset_class_code || '')));
    const overviewItems = newAssetItems.filter((record) => {
      const sourceJson = normalizeObjectField(record.source_json);
      return String(sourceJson.source_capture_page_type || '') === 'assets_overview';
    });
    const overviewAssetNames = overviewItems.map((record) => String(record.asset_name || '').trim()).filter(Boolean);

    assert.equal(newAssetItems.length >= 3, true);
    assert.equal(
      extractedAssetNames.some((name) => ['schd', 'jepi', 'jepq', 'spy', 'qqq', 'aapl', 'tsla'].includes(name.toLowerCase())),
      true
    );
    assert.equal(
      extractedAssetNames.some((name) => name.includes('KB온국민') || name.includes('농협') || name.includes('현금성자산')),
      true
    );
    assert.equal(
      [...extractedAssetClasses].some((assetClassCode) => assetClassCode === 'stock_growth' || assetClassCode === 'stock_dividend' || assetClassCode === 'cash'),
      true
    );
    assert.equal(
      overviewItems.every((record) => String(record.asset_class_code || '') === 'cash'),
      true
    );
    assert.equal(
      overviewItems.length >= 1,
      true
    );
    assert.equal(
      overviewAssetNames.some((name) => name.includes('기금계좌') || name.includes('연금저축')),
      false
    );

    const editableItem = latestAssetItems.find((record) => String(record.id || '').trim());

    assert.notEqual(editableItem, undefined, '수정할 자산 항목을 찾지 못했습니다.');

    const editableItemId = String(editableItem.id || '');
    const editableSnapshotId = String(editableItem.snapshot_id || latestSnapshotId);
    const editableOriginalAmount = Number(editableItem.amount_krw || 0);
    const editableOriginalClassCode = String(editableItem.asset_class_code || 'cash');
    const updatedAmount = editableOriginalAmount + 1234567;
    const updatedClassCode = editableOriginalClassCode === 'gold' ? 'bond' : 'gold';
    const expectedUpdatedTotal = Number(latestSnapshot.total_amount_krw || 0) - editableOriginalAmount + updatedAmount;
    const updateResponse = await fetch(`${service.baseUrl}/xapi/asset-items/update`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        itemId: editableItemId,
        assetClassCode: updatedClassCode,
        amountKrw: String(updatedAmount),
      }),
      redirect: 'manual',
    });

    assert.equal(updateResponse.status, 303);
    assert.equal(String(updateResponse.headers.get('location') || '').startsWith('/'), true);

    const updatedItems = await listRecords(service.baseUrl, 'asset_items', apiToken, {
      filter: `id="${editableItemId}"`,
    });
    const updatedItem = updatedItems[0];

    assert.notEqual(updatedItem, undefined, '수정된 자산 항목을 다시 읽지 못했습니다.');
    assert.equal(String(updatedItem.asset_class_code || ''), updatedClassCode);
    assert.equal(Number(updatedItem.amount_krw || 0), updatedAmount);
    assert.equal(Boolean(updatedItem.is_manual_adjusted), true);

    const updatedItemSourceJson = normalizeObjectField(updatedItem.source_json);

    assert.equal(String(updatedItemSourceJson.manual_override?.asset_class_code || ''), updatedClassCode);
    assert.equal(Number(updatedItemSourceJson.manual_override?.amount_krw || 0), updatedAmount);

    const updatedSnapshots = await listRecords(service.baseUrl, 'asset_snapshots', apiToken, {
      filter: `id="${editableSnapshotId}"`,
    });
    const updatedSnapshot = updatedSnapshots[0];

    assert.notEqual(updatedSnapshot, undefined, '수정 후 스냅샷을 다시 읽지 못했습니다.');
    assert.equal(Number(updatedSnapshot.total_amount_krw || 0), expectedUpdatedTotal);

    const deletableItem = latestAssetItems.find((record) => String(record.id || '') !== editableItemId);

    assert.notEqual(deletableItem, undefined, '삭제할 별도 자산 항목을 찾지 못했습니다.');

    const deletableItemId = String(deletableItem.id || '');
    const deletableAmount = Number(deletableItem.amount_krw || 0);
    const expectedDeletedTotal = expectedUpdatedTotal - deletableAmount;
    const deleteResponse = await fetch(`${service.baseUrl}/xapi/asset-items/delete`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        itemId: deletableItemId,
      }),
      redirect: 'manual',
    });

    assert.equal(deleteResponse.status, 303);
    assert.equal(String(deleteResponse.headers.get('location') || '').startsWith('/'), true);

    const deletedItems = await listRecords(service.baseUrl, 'asset_items', apiToken, {
      filter: `id="${deletableItemId}"`,
    });

    assert.equal(deletedItems.length, 0);

    const deletedSnapshots = await listRecords(service.baseUrl, 'asset_snapshots', apiToken, {
      filter: `id="${editableSnapshotId}"`,
    });
    const deletedSnapshot = deletedSnapshots[0];

    assert.notEqual(deletedSnapshot, undefined, '삭제 후 스냅샷을 다시 읽지 못했습니다.');
    assert.equal(Number(deletedSnapshot.total_amount_krw || 0), expectedDeletedTotal);

    const clearResponse = await fetch(`${service.baseUrl}/xapi/settings/clear-assets`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
      },
      redirect: 'manual',
    });

    assert.equal(clearResponse.status, 303);
    assert.equal(String(clearResponse.headers.get('location') || '').startsWith('/settings'), true);

    const clearedSnapshots = await listRecords(service.baseUrl, 'asset_snapshots', apiToken, {
      sort: '-updated,-created',
    });
    const clearedCaptureRecords = await listRecords(service.baseUrl, 'snapshot_capture_images', apiToken, {
      sort: '-created',
    });
    const clearedSectionRecords = await listRecords(service.baseUrl, 'snapshot_sections', apiToken, {
      sort: '-created',
    });
    const clearedAssetItems = await listRecords(service.baseUrl, 'asset_items', apiToken, {
      sort: '-updated,-created',
    });

    assert.equal(clearedSnapshots.length, 0);
    assert.equal(clearedCaptureRecords.length, 0);
    assert.equal(clearedSectionRecords.length, 0);
    assert.equal(clearedAssetItems.length, 0);

    for (const tempDir of new Set(tempPathsToCleanup)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
);
