const { globalApi } = require('pocketpages');
const { dbg, info, warn, error } = globalApi;
const createKjcaAuth = require('./kjca-auth');
const createKjcaAnalyzeService = require('./kjca-analyze-service');
const createKjcaCollectService = require('./kjca-collect-service');

const KJCA_EMAIL_DOMAIN = 'kjca.local';
const KJCA_HOST = 'http://www.kjca.co.kr';
const KJCA_LOGIN_URL = `${KJCA_HOST}/staff/auth/login_check`;
const KJCA_AUTH_URL = `${KJCA_HOST}/staff/auth`;
const CACHE_COLLECTION_NAME = 'staff_diary_analysis_cache';
const GEMINI_MODEL_NAME = 'gemini-2.5-flash-lite';
const PROMPT_VERSION = 4;
const GEMINI_MAX_ATTEMPTS = 3;

const WEEKDAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri'];

const weekdayLabelMap = {
  mon: '월',
  tue: '화',
  wed: '수',
  thu: '목',
  fri: '금',
};

function parseJsonSafely(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

function extractJsonObjectText(text) {
  const normalized = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const objectStart = normalized.indexOf('{');
  const objectEnd = normalized.lastIndexOf('}');
  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return '{}';
  }
  return normalized.slice(objectStart, objectEnd + 1).trim();
}

function getHeaderValues(headers, key) {
  if (!headers) return [];

  const direct = headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()];
  if (Array.isArray(direct)) return direct.map((item) => String(item));
  if (direct !== undefined && direct !== null) return [String(direct)];

  const matchedKey = Object.keys(headers).find((headerKey) => headerKey.toLowerCase() === key.toLowerCase());
  if (!matchedKey) return [];

  const matchedValue = headers[matchedKey];
  if (Array.isArray(matchedValue)) return matchedValue.map((item) => String(item));
  if (matchedValue !== undefined && matchedValue !== null) return [String(matchedValue)];

  return [];
}

function normalizeCookieHeader(cookieHeader) {
  if (!cookieHeader) return '';

  const cookieMap = {};
  String(cookieHeader)
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => !!chunk)
    .forEach((cookiePair) => {
      const separatorIndex = cookiePair.indexOf('=');
      if (separatorIndex === -1) return;
      const name = cookiePair.slice(0, separatorIndex).trim();
      const value = cookiePair.slice(separatorIndex + 1).trim();
      if (!name) return;
      cookieMap[name] = value;
    });

  return Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join('; ');
}

function extractCookieHeaderFromSetCookie(setCookieHeaders) {
  const cookieMap = {};

  setCookieHeaders.forEach((header) => {
    const cookiePair = String(header).split(';')[0].trim();
    if (!cookiePair) return;

    const separatorIndex = cookiePair.indexOf('=');
    if (separatorIndex === -1) return;

    const name = cookiePair.slice(0, separatorIndex).trim();
    const value = cookiePair.slice(separatorIndex + 1).trim();
    if (!name) return;

    cookieMap[name] = value;
  });

  return Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join('; ');
}

function mergeSetCookieIntoCookieHeader(cookieHeader, responseHeaders) {
  const setCookieHeaders = getHeaderValues(responseHeaders, 'Set-Cookie');
  if (!setCookieHeaders.length) return cookieHeader;

  const nextCookie = normalizeCookieHeader(extractCookieHeaderFromSetCookie(setCookieHeaders));
  if (!nextCookie) return cookieHeader;

  const merged = cookieHeader ? `${cookieHeader}; ${nextCookie}` : nextCookie;
  return normalizeCookieHeader(merged);
}

function detectAuthRequiredHtml(html) {
  const text = String(html || '');
  if (text.includes('/staff/auth/login_check') || text.includes('id="mng_id"')) return true;

  const redirectRegex = /location\.href\s*=\s*(?:'|")\s*\/staff\/auth\s*(?:'|")/i;
  return redirectRegex.test(text);
}

function decodeHtmlEntities(text) {
  const source = String(text || '');
  return source
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]*>/g, '')).trim();
}

function toAbsoluteKjcaUrl(host, maybeRelativeUrl) {
  const url = String(maybeRelativeUrl || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('?')) return `${host}/diary/${url}`;
  if (url.startsWith('/?') && url.includes('bd_idx=')) return `${host}/diary${url}`;
  if (url.startsWith('/')) return `${host}${url}`;
  return `${host}/${url}`;
}

function isAllowedKjcaUrl(host, url) {
  const normalized = String(url || '').trim();
  return normalized.startsWith(`${host}/`) || normalized.startsWith('http://www.kjca.co.kr/') || normalized.startsWith('https://www.kjca.co.kr/');
}

function extractPrintUrlFromCell(host, cellHtml) {
  const source = decodeHtmlEntities(String(cellHtml || ''));
  if (!source) return '';

  const candidates = [];
  const quotedUrlRegex = /['"]((?:https?:\/\/|\/|\?)[^'"]+)['"]/gi;
  let urlMatch = null;
  while ((urlMatch = quotedUrlRegex.exec(source))) {
    const candidate = String(urlMatch[1] || '').trim();
    if (!candidate) continue;
    candidates.push(candidate);
  }

  const normalized = candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => !!candidate)
    .filter((candidate) => candidate !== '#')
    .filter((candidate) => !/^javascript:/i.test(candidate))
    .filter((candidate) => !/^void\(0\)/i.test(candidate));

  if (!normalized.length) return '';

  const preferred = normalized.find((candidate) => candidate.includes('bd_idx=')) || normalized.find((candidate) => candidate.includes('/diary/') || candidate.startsWith('?site=')) || normalized[0];

  return toAbsoluteKjcaUrl(host, preferred);
}

function parseTeamLeadRowsFromDiaryHtml(diaryHtml, host) {
  const html = String(diaryHtml || '');
  const rows = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch = null;

  while ((trMatch = trRegex.exec(html))) {
    const trInner = trMatch[1] || '';
    if (!trInner.includes('data-label')) continue;

    const cellHtmlByLabel = {};
    const tdRegex = /<td\b[^>]*data-label\s*=\s*(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch = null;
    while ((tdMatch = tdRegex.exec(trInner))) {
      const label = stripTags(tdMatch[2]);
      const cellInner = tdMatch[3] || '';
      if (!label) continue;
      cellHtmlByLabel[label] = cellInner;
    }

    const position = stripTags(cellHtmlByLabel['직책'] || '');
    if (position !== '팀장') continue;

    const dept = stripTags(cellHtmlByLabel['부서'] || '');
    const staffName = stripTags(cellHtmlByLabel['성명'] || '');
    const printCell = String(cellHtmlByLabel['인쇄'] || '');
    const printUrl = extractPrintUrlFromCell(host, printCell);

    rows.push({
      dept,
      position,
      staffName,
      printUrl,
    });
  }

  const seen = {};
  const uniqueRows = [];
  rows.forEach((row) => {
    const key = row.dept || '';
    if (!key || seen[key]) return;
    seen[key] = true;
    uniqueRows.push(row);
  });

  return { rows: uniqueRows };
}

function buildBrowserLikeHeaders(host, cookieHeader, referer) {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    Host: host.replace(/^https?:\/\//i, ''),
  };

  if (cookieHeader) headers.Cookie = cookieHeader;
  if (referer) headers.Referer = referer;
  return headers;
}

function buildTodayDateText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 날짜 입력값을 `YYYY-MM-DD` 형식으로 정규화합니다.
 * @param {string | string[] | null | undefined} value 폼이나 params에서 받은 날짜 값입니다.
 * @returns {string} 정규화된 날짜 문자열입니다.
 */
function normalizeReportDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return buildTodayDateText();
}

/**
 * 화면에서 쓰는 기본 폼 상태를 원본 입력값에서 정규화합니다.
 * @param {types.KjcaFormStateInput | null | undefined} value 페이지나 폼에서 받은 원본 입력값입니다.
 * @returns {types.KjcaFormState} 화면에서 바로 쓸 수 있는 폼 상태입니다.
 */
function buildFormState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    reportDate: normalizeReportDate(source.reportDate),
    testOneOnly: normalizeBool(source.testOneOnly),
  };
}

function escapeFilterValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function hashText(text) {
  const source = String(text || '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${source.length}`;
}

function extractDivInnerHtmlByClasses(html, requiredClasses) {
  const source = String(html || '');
  if (!source) return '';

  const divStartRegex = /<div\b[^>]*class\s*=\s*(['"])([^'"]*)\1[^>]*>/gi;
  let match = null;
  while ((match = divStartRegex.exec(source))) {
    const classValue = String(match[2] || '');
    const ok = requiredClasses.every((cls) => new RegExp(`\\b${cls}\\b`).test(classValue));
    if (!ok) continue;

    const openTagEndIndex = match.index + match[0].length;
    const tokenRegex = /<\/?div\b/gi;
    tokenRegex.lastIndex = openTagEndIndex;
    let depth = 1;

    let tokenMatch = null;
    while ((tokenMatch = tokenRegex.exec(source))) {
      const token = String(tokenMatch[0] || '').toLowerCase();
      if (token === '<div') {
        depth += 1;
        continue;
      }

      if (token === '</div') {
        depth -= 1;
        if (depth === 0) {
          const closeTagStartIndex = tokenMatch.index;
          return source.slice(openTagEndIndex, closeTagStartIndex);
        }
      }
    }

    return '';
  }

  return '';
}

function htmlToText(html) {
  const normalized = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ');
  return decodeHtmlEntities(normalized.replace(/<[^>]*>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\t+/g, ' | ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter((item) => !!item);
}

function isNumericByteArray(value) {
  if (!Array.isArray(value)) return false;
  if (!value.length) return false;
  return value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
}

function normalizeJsonArrayField(value) {
  if (Array.isArray(value)) {
    if (isNumericByteArray(value)) {
      const text = String(toString(value) || '').trim();
      if (!text) return [];
      const parsedFromBytes = parseJsonSafely(text, null);
      if (Array.isArray(parsedFromBytes)) return normalizeStringArray(parsedFromBytes);
      return [];
    }
    return normalizeStringArray(value);
  }

  if (value === null || value === undefined) return [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = parseJsonSafely(trimmed, null);
    if (Array.isArray(parsed)) return normalizeStringArray(parsed);
    return normalizeStringArray([trimmed]);
  }

  return [];
}

function inferGemini429Cause(message, detailsText) {
  const source = `${String(message || '')} ${String(detailsText || '')}`.toLowerCase();
  if (!source.trim()) return 'unknown';

  const hasQuotaSignal = source.includes('quota') || source.includes('billing') || source.includes('free tier') || source.includes('resource_exhausted');
  if (hasQuotaSignal) return 'quota-or-billing-limit';

  const hasRateSignal = source.includes('rate') || source.includes('too many requests') || source.includes('per minute') || source.includes('retry');
  if (hasRateSignal) return 'request-rate-limit';

  return 'unknown';
}

function stringifyGeminiErrorDetails(details) {
  if (!Array.isArray(details)) return '';
  return details
    .map((detail) => {
      if (detail === null || detail === undefined) return '';
      const text = `${detail}`;
      return text === '[object Object]' ? JSON.stringify(detail) : text;
    })
    .join(' | ');
}

function parseDateText(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date();
  const [year, month, day] = text.split('-').map((unit) => Number(unit));
  return new Date(year, month - 1, day);
}

function formatDateText(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 주어진 날짜가 속한 주의 월요일 날짜를 계산합니다.
 * @param {unknown} dateText 기준이 되는 날짜 값입니다.
 * @returns {string} 해당 주 월요일의 날짜 문자열입니다.
 */
function buildWeekStartDate(dateText) {
  const date = parseDateText(dateText);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diff);
  return formatDateText(monday);
}

/**
 * 날짜를 기준으로 업무일지 집계용 요일 키를 계산합니다.
 * @param {unknown} dateText 기준이 되는 날짜 값입니다.
 * @returns {types.KjcaWeekday} `mon`부터 `fri` 중 하나의 요일 키입니다.
 */
function toWeekdayKey(dateText) {
  const day = parseDateText(dateText).getDay();
  if (day === 1) return 'mon';
  if (day === 2) return 'tue';
  if (day === 3) return 'wed';
  if (day === 4) return 'thu';
  return 'fri';
}

/**
 * 다양한 요일 표현을 내부 요일 키로 정규화합니다.
 * @param {unknown} value 문자열 또는 외부 입력으로 받은 요일 값입니다.
 * @returns {types.KjcaWeekday | ""} 인식 가능한 경우 내부 요일 키, 아니면 빈 문자열입니다.
 */
function normalizeWeekday(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (text === 'mon' || text === 'monday' || text === '월') return 'mon';
  if (text === 'tue' || text === 'tuesday' || text === '화') return 'tue';
  if (text === 'wed' || text === 'wednesday' || text === '수') return 'wed';
  if (text === 'thu' || text === 'thursday' || text === '목') return 'thu';
  if (text === 'fri' || text === 'friday' || text === '금') return 'fri';
  return '';
}

function buildDateMatchParams(dateText) {
  const normalized = formatDateText(parseDateText(dateText));
  return {
    exact: normalized,
    like: `${normalized}%`,
  };
}

function normalizeNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeRequiredInt(value, fallback) {
  const parsed = normalizeNullableInt(value);
  if (parsed === null) return fallback;
  return parsed;
}

/**
 * 다양한 불리언 표현을 실제 boolean 값으로 정규화합니다.
 * @param {boolean | string | string[] | null | undefined} value 폼이나 params에서 받은 원본 값입니다.
 * @returns {boolean} 정규화된 불리언 값입니다.
 */
function normalizeBool(value) {
  if (value === true || value === false) return value;
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (text === 'true' || text === '1' || text === 'y' || text === 'yes' || text === 'on') return true;
  return false;
}

function normalizeRecruitingExtract(value) {
  const source = value && typeof value === 'object' ? value : {};
  const dailyPlanRaw = Array.isArray(source.dailyPlan) ? source.dailyPlan : [];
  const dailyPlan = dailyPlanRaw
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const weekday = normalizeWeekday(row.weekday);
      if (!weekday) return null;

      return {
        weekday,
        channelName: String(row.channelName || '').trim(),
        promotionContent: String(row.promotionContent || '').trim(),
        targetCount: normalizeNullableInt(row.targetCount),
        ownerName: String(row.ownerName || '').trim(),
        note: String(row.note || '').trim(),
      };
    })
    .filter((item) => !!item);

  const weekTableRowsRaw = Array.isArray(source.weekTableRows) ? source.weekTableRows : [];
  const weekTableRowsNormalized = weekTableRowsRaw
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const weekday = normalizeWeekday(row.weekday);
      if (!weekday) return null;

      return {
        weekday,
        channelName: String(row.channelName || row.promotionChannel || '').trim(),
        weeklyPlan: String(row.weeklyPlan || row.plan || '').trim(),
        promotionContent: String(row.promotionContent || '').trim(),
        targetText: String(row.targetText || row.target || '').trim(),
        resultText: String(row.resultText || row.result || '').trim(),
        recruitCountText: String(row.recruitCountText || row.countText || '').trim(),
        ownerName: String(row.ownerName || '').trim(),
        note: String(row.note || '').trim(),
        sortOrder: Math.max(0, Math.trunc(Number(row.sortOrder || 0))),
      };
    })
    .filter((item) => !!item);

  const weekTableRowsFallback = dailyPlan
    .map((row, index) => ({
      weekday: row.weekday,
      channelName: row.channelName,
      weeklyPlan: '',
      promotionContent: row.promotionContent,
      targetText: row.targetCount === null ? '' : String(row.targetCount),
      resultText: '',
      recruitCountText: '',
      ownerName: row.ownerName,
      note: row.note,
      sortOrder: index,
    }))
    .filter((row) => !!row.channelName || !!row.weeklyPlan || !!row.promotionContent || !!row.targetText || !!row.resultText || !!row.recruitCountText || !!row.ownerName || !!row.note);

  return {
    monthTarget: normalizeNullableInt(source.monthTarget),
    monthAssignedCurrent: normalizeNullableInt(source.monthAssignedCurrent),
    weekTarget: normalizeNullableInt(source.weekTarget),
    dailyPlan,
    dailyActualCount: normalizeNullableInt(source.dailyActualCount),
    weekTableRows: weekTableRowsNormalized.length > 0 ? weekTableRowsNormalized : weekTableRowsFallback,
  };
}

function normalizeCachedRecruitingField(value) {
  if (value === null || value === undefined) return normalizeRecruitingExtract({});
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return normalizeRecruitingExtract({});
    return normalizeRecruitingExtract(parseJsonSafely(text, {}));
  }
  if (Array.isArray(value)) {
    const isByteArray = value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
    if (!isByteArray) return normalizeRecruitingExtract({});
    const text = String(toString(value) || '').trim();
    if (!text) return normalizeRecruitingExtract({});
    return normalizeRecruitingExtract(parseJsonSafely(text, {}));
  }
  return normalizeRecruitingExtract(value);
}

/**
 * 팀장 목록 응답을 화면에서 쓰는 행 배열로 정리합니다.
 * @param {unknown} value 외부 응답이나 저장값에서 받은 팀장 목록 값입니다.
 * @returns {types.KjcaTeamLeadRow[]} 정규화된 팀장 행 목록입니다.
 */
function normalizeTeamLeadRows(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((row) => {
      const item = row && typeof row === 'object' ? row : {};
      return {
        dept: String(item.dept || '').trim(),
        position: String(item.position || '').trim(),
        staffName: String(item.staffName || '').trim(),
        printUrl: String(item.printUrl || '').trim(),
      };
    })
    .filter((row) => !!row.dept && !!row.printUrl);
}

/**
 * 분석 결과 목록을 화면과 후속 저장에 맞는 shape로 정리합니다.
 * @param {unknown} value 분석 API나 캐시에서 받은 결과 목록 값입니다.
 * @returns {types.KjcaAnalyzeResult[]} 정규화된 분석 결과 목록입니다.
 */
function normalizeAnalyzeResults(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((item) => ({
    dept: String((item && item.dept) || '').trim(),
    position: String((item && item.position) || '').trim(),
    staffName: String((item && item.staffName) || '').trim(),
    ok: !(item && item.ok === false),
    error: String((item && item.error) || '').trim(),
    promotion: Array.isArray(item && item.promotion) ? item.promotion.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    vacation: Array.isArray(item && item.vacation) ? item.vacation.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    special: Array.isArray(item && item.special) ? item.special.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    recruiting: normalizeRecruitingExtract(item && item.recruiting),
    printUrl: String((item && item.printUrl) || '').trim(),
  }));
}

function normalizeWeekTextRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((item, index) => {
      const row = item && typeof item === 'object' ? item : {};
      const weekday = normalizeWeekday(row.weekday);
      if (!weekday) return null;

      return {
        weekday,
        channelName: String(row.channelName || '').trim(),
        weeklyPlan: String(row.weeklyPlan || '').trim(),
        promotionContent: String(row.promotionContent || '').trim(),
        targetText: String(row.targetText || '').trim(),
        resultText: String(row.resultText || '').trim(),
        recruitCountText: String(row.recruitCountText || '').trim(),
        ownerName: String(row.ownerName || '').trim(),
        note: String(row.note || '').trim(),
        sortOrder: Number.isFinite(Number(row.sortOrder)) ? Math.trunc(Number(row.sortOrder)) : index,
      };
    })
    .filter((row) => !!row);
}

function ensureWeekdayRows(rows) {
  const normalized = normalizeWeekTextRows(rows);
  const byWeekday = new Map();
  normalized.forEach((row) => {
    const key = row.weekday;
    if (!byWeekday.has(key)) byWeekday.set(key, []);
    byWeekday.get(key).push(row);
  });

  const result = [];
  WEEKDAY_ORDER.forEach((weekday) => {
    const items = byWeekday.get(weekday) || [];
    if (items.length === 0) {
      result.push({
        weekday,
        channelName: '',
        weeklyPlan: '',
        promotionContent: '',
        targetText: '',
        resultText: '',
        recruitCountText: '',
        ownerName: '',
        note: '',
        sortOrder: 0,
      });
      return;
    }

    items.sort((a, b) => a.sortOrder - b.sortOrder).forEach((item, index) => result.push({ ...item, sortOrder: index }));
  });

  return result;
}

function hasWeekTextContent(rows) {
  return rows.some(
    (row) =>
      !!String(row.channelName || '').trim() ||
      !!String(row.weeklyPlan || '').trim() ||
      !!String(row.promotionContent || '').trim() ||
      !!String(row.targetText || '').trim() ||
      !!String(row.resultText || '').trim() ||
      !!String(row.recruitCountText || '').trim() ||
      !!String(row.ownerName || '').trim() ||
      !!String(row.note || '').trim(),
  );
}

function getDistinctWeekdayCount(rows) {
  const weekdaySet = new Set();
  rows.forEach((row) => {
    const weekday = normalizeWeekday(row.weekday);
    if (weekday) weekdaySet.add(weekday);
  });
  return weekdaySet.size;
}

function buildUniqueTargets(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (map.has(row.dept)) return;
    map.set(row.dept, {
      dept: row.dept,
      position: row.position,
      staffName: row.staffName,
      printUrl: row.printUrl,
    });
  });
  return Array.from(map.values());
}

function hasWeekPlanData(recruiting) {
  return (
    recruiting.monthTarget !== null ||
    recruiting.weekTarget !== null ||
    (Array.isArray(recruiting.weekTableRows) &&
      recruiting.weekTableRows.some(
        (row) =>
          !!String(row.channelName || '').trim() ||
          !!String(row.weeklyPlan || '').trim() ||
          !!String(row.promotionContent || '').trim() ||
          !!String(row.targetText || '').trim() ||
          !!String(row.resultText || '').trim() ||
          !!String(row.recruitCountText || '').trim() ||
          !!String(row.ownerName || '').trim() ||
          !!String(row.note || '').trim(),
      )) ||
    recruiting.dailyPlan.some((item) => item.targetCount !== null || !!item.channelName || !!item.promotionContent || !!item.ownerName || !!item.note)
  );
}

function buildSnapshotRows(planItems, weekResults) {
  const targetMap = {
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
  };

  const actualMap = {
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
  };

  planItems.forEach((item) => {
    const weekday = normalizeWeekday(item.weekday);
    if (!weekday) return;
    targetMap[weekday] += Math.max(0, Math.trunc(Number(item.targetCount || 0)));
  });

  weekResults.forEach((item) => {
    const weekday = normalizeWeekday(item.weekday);
    if (!weekday) return;
    actualMap[weekday] += Math.max(0, Math.trunc(Number(item.actualCount || 0)));
  });

  return WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    target: targetMap[weekday],
    actual: actualMap[weekday],
    gap: actualMap[weekday] - targetMap[weekday],
  }));
}

/**
 * 부서별 주간 텍스트 테이블 목록을 화면용 shape로 정리합니다.
 * @param {unknown} value 수집 결과나 저장값에서 받은 테이블 목록 값입니다.
 * @returns {types.KjcaDeptWeekTable[]} 정규화된 부서별 주간 테이블 목록입니다.
 */
function normalizeDeptWeekTables(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        dept: String(source.dept || '').trim(),
        todayWeekday: normalizeWeekday(source.todayWeekday) || 'fri',
        rows: ensureWeekdayRows(source.rows),
      };
    })
    .filter((item) => !!item.dept)
    .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'));
}

/**
 * 부서별 주간 스냅샷 목록을 화면용 shape로 정리합니다.
 * @param {unknown} value 수집 결과나 저장값에서 받은 스냅샷 목록 값입니다.
 * @returns {types.KjcaDeptSnapshot[]} 정규화된 부서별 스냅샷 목록입니다.
 */
function normalizeDeptSnapshots(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        dept: String(source.dept || '').trim(),
        monthTarget: normalizeNullableInt(source.monthTarget),
        weekTarget: normalizeNullableInt(source.weekTarget),
        rows: Array.isArray(source.rows)
          ? source.rows
              .map((row) => ({
                weekday: normalizeWeekday(row && row.weekday) || 'mon',
                target: normalizeRequiredInt(row && row.target, 0),
                actual: normalizeRequiredInt(row && row.actual, 0),
                gap: Number.isFinite(Number(row && row.gap)) ? Math.trunc(Number(row.gap)) : 0,
              }))
              .filter((row) => !!row.weekday)
          : [],
        today:
          source.today && typeof source.today === 'object'
            ? {
                weekday: normalizeWeekday(source.today.weekday) || 'fri',
                target: normalizeRequiredInt(source.today.target, 0),
                actual: normalizeRequiredInt(source.today.actual, 0),
                gap: Number.isFinite(Number(source.today.gap)) ? Math.trunc(Number(source.today.gap)) : 0,
              }
            : {
                weekday: 'fri',
                target: 0,
                actual: 0,
                gap: 0,
              },
        cumulative:
          source.cumulative && typeof source.cumulative === 'object'
            ? {
                target: normalizeRequiredInt(source.cumulative.target, 0),
                actual: normalizeRequiredInt(source.cumulative.actual, 0),
                gap: Number.isFinite(Number(source.cumulative.gap)) ? Math.trunc(Number(source.cumulative.gap)) : 0,
              }
            : {
                target: 0,
                actual: 0,
                gap: 0,
              },
      };
    })
    .filter((item) => !!item.dept)
    .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'));
}

/**
 * 대시보드 렌더링에 필요한 전체 상태를 정규화합니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} input 페이지나 상호작용 응답에서 만든 원본 상태입니다.
 * @returns {types.KjcaDashboardState} 화면에서 바로 쓸 수 있는 대시보드 상태입니다.
 */
function buildDashboardState(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    reportDate: normalizeReportDate(source.reportDate),
    testOneOnly: normalizeBool(source.testOneOnly),
    noticeMessage: String(source.noticeMessage || '').trim(),
    errorMessage: String(source.errorMessage || '').trim(),
    warnings: Array.isArray(source.warnings) ? source.warnings.map((item) => String(item || '').trim()).filter(Boolean) : [],
    stoppedReason: String(source.stoppedReason || '').trim(),
    isDiaryAccessible: source.isDiaryAccessible === true ? true : source.isDiaryAccessible === false ? false : null,
    teamLeadRows: normalizeTeamLeadRows(source.teamLeadRows),
    analysisResults: normalizeAnalyzeResults(source.analysisResults),
    deptWeekTables: normalizeDeptWeekTables(source.deptWeekTables),
    deptSnapshots: normalizeDeptSnapshots(source.deptSnapshots),
  };
}

/**
 * 대시보드 상태를 hidden field 전송용 문자열로 직렬화합니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} state 직렬화할 대시보드 상태입니다.
 * @returns {string} URL 인코딩된 대시보드 상태 문자열입니다.
 */
function serializeDashboardState(state) {
  const normalized = buildDashboardState(state);
  return encodeURIComponent(JSON.stringify(normalized));
}

/**
 * 직렬화된 대시보드 상태를 다시 화면용 상태로 복원합니다.
 * @param {unknown} value hidden field나 요청값으로 받은 직렬화 문자열입니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} fallback 복원 실패 시 기본값으로 쓸 상태입니다.
 * @returns {types.KjcaDashboardState} 복원된 대시보드 상태입니다.
 */
function parseDashboardState(value, fallback) {
  const fallbackState = buildDashboardState(fallback);
  const text = String(value || '').trim();
  if (!text) return fallbackState;

  try {
    const decoded = decodeURIComponent(text);
    return buildDashboardState({
      ...fallbackState,
      ...parseJsonSafely(decoded, {}),
    });
  } catch (error) {
    return fallbackState;
  }
}

/**
 * 같은 요일의 여러 텍스트 행을 한 줄 요약용 값으로 합칩니다.
 * @param {types.KjcaWeekTextRow[] | null | undefined} rows 병합할 주간 텍스트 행 목록입니다.
 * @param {types.KjcaWeekday | string} weekday 선택할 요일 키입니다.
 * @returns {types.KjcaMergedWeekdayRow} 화면 표시용 병합 행입니다.
 */
function getWeekdayMergedRow(rows, weekday) {
  const items = (Array.isArray(rows) ? rows : []).filter((row) => row.weekday === weekday).sort((a, b) => a.sortOrder - b.sortOrder);

  const joinValues = (extractor) =>
    items
      .map((row) => String(extractor(row) || '').trim())
      .filter(Boolean)
      .join(' / ');

  return {
    channelName: joinValues((row) => row.channelName),
    weeklyPlan: joinValues((row) => row.weeklyPlan),
    promotionContent: joinValues((row) => row.promotionContent),
    targetText: joinValues((row) => row.targetText),
    resultText: joinValues((row) => row.resultText),
    recruitCountText: joinValues((row) => row.recruitCountText),
    ownerName: joinValues((row) => row.ownerName),
    note: joinValues((row) => row.note),
  };
}

/**
 * 현재 표시 중인 요일이 오늘 강조 대상인지 확인합니다.
 * @param {types.KjcaWeekday | string} weekday 비교할 행의 요일 키입니다.
 * @param {types.KjcaWeekday | string} todayWeekday 오늘 기준 요일 키입니다.
 * @returns {boolean} 오늘 강조 대상이면 `true`입니다.
 */
function isFocusWeekday(weekday, todayWeekday) {
  return weekday === todayWeekday;
}

function buildMonthLabel(dateText) {
  const text = String(dateText || '').trim();
  const matched = text.match(/^\d{4}-(\d{2})-\d{2}$/);
  if (!matched) return '금월';
  const month = Number(matched[1]);
  if (!Number.isFinite(month) || month < 1 || month > 12) return '금월';
  return `${month}월`;
}

/**
 * 부서 카드 상단에 표시할 요약 문구를 만듭니다.
 * @param {types.KjcaDeptSummaryParams | null | undefined} params 요약에 필요한 부서명, 날짜, 분석 결과입니다.
 * @returns {string} 화면에 표시할 요약 문구입니다.
 */
function buildDeptSummaryText(params) {
  const dept = String((params && params.dept) || '').trim();
  const reportDate = String((params && params.reportDate) || '').trim();
  const analysisResults = Array.isArray(params && params.analysisResults) ? params.analysisResults : [];
  const item = analysisResults.find((row) => row.dept === dept && row.ok);
  const monthTarget = item && item.recruiting ? item.recruiting.monthTarget : null;
  const monthAssignedCurrent = item && item.recruiting ? item.recruiting.monthAssignedCurrent : null;
  const monthTargetText = monthTarget === null ? '-' : `${monthTarget}건`;
  const monthAssignedText = monthAssignedCurrent === null ? '-' : `${monthAssignedCurrent}명`;
  const monthLabel = buildMonthLabel(reportDate);
  return `월 배정목표 : ${monthTargetText} / ${monthLabel} 현재 달성 : 배정 ${monthAssignedText}`;
}

const kjcaAuth = createKjcaAuth({
  KJCA_EMAIL_DOMAIN,
  KJCA_HOST,
  KJCA_LOGIN_URL,
  KJCA_AUTH_URL,
  getHeaderValues,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  parseTeamLeadRowsFromDiaryHtml,
  buildBrowserLikeHeaders,
  normalizeReportDate,
  info,
  dbg,
});

const { normalizeSuperuserLoginId, readAuthState, ensureSuperuserRequest, createKjcaSession, probeStaffAuth } = kjcaAuth;

const kjcaAnalyzeService = createKjcaAnalyzeService({
  CACHE_COLLECTION_NAME,
  GEMINI_MODEL_NAME,
  PROMPT_VERSION,
  GEMINI_MAX_ATTEMPTS,
  parseJsonSafely,
  extractJsonObjectText,
  getHeaderValues,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  toAbsoluteKjcaUrl,
  isAllowedKjcaUrl,
  buildBrowserLikeHeaders,
  normalizeReportDate,
  escapeFilterValue,
  hashText,
  extractDivInnerHtmlByClasses,
  htmlToText,
  normalizeStringArray,
  normalizeJsonArrayField,
  inferGemini429Cause,
  stringifyGeminiErrorDetails,
  normalizeRecruitingExtract,
  normalizeCachedRecruitingField,
  createKjcaSession,
  warn,
  info,
});

const { analyzeStaffDiary } = kjcaAnalyzeService;

const kjcaCollectService = createKjcaCollectService({
  CACHE_COLLECTION_NAME,
  WEEKDAY_ORDER,
  normalizeReportDate,
  escapeFilterValue,
  buildWeekStartDate,
  toWeekdayKey,
  normalizeWeekday,
  buildDateMatchParams,
  normalizeNullableInt,
  normalizeRequiredInt,
  normalizeBool,
  normalizeRecruitingExtract,
  normalizeTeamLeadRows,
  normalizeAnalyzeResults,
  normalizeWeekTextRows,
  ensureWeekdayRows,
  hasWeekTextContent,
  getDistinctWeekdayCount,
  buildUniqueTargets,
  hasWeekPlanData,
  buildSnapshotRows,
  ensureSuperuserRequest,
  createKjcaSession,
  probeStaffAuth,
  analyzeStaffDiary,
  parseDateText,
  formatDateText,
});

const { collectWeekly, clearAnalysisCache } = kjcaCollectService;

/**
 * 수집 결과를 화면용 대시보드 상태로 변환합니다.
 * @param {Partial<types.KjcaCollectResult> | null | undefined} result 수집 API가 돌려준 결과입니다.
 * @param {types.KjcaFormStateInput | null | undefined} formState 현재 화면의 폼 상태 입력값입니다.
 * @returns {types.KjcaDashboardState} 렌더링에 바로 쓸 수 있는 대시보드 상태입니다.
 */
function buildDashboardStateFromCollectResult(result, formState) {
  const safeFormState = buildFormState(formState);
  const deptWeekTables = normalizeDeptWeekTables(result && result.deptWeekTables);
  const alertMessage = String((result && result.alertMessage) || '').trim();
  const noticeMessage = alertMessage || `자동 취합 완료 (${deptWeekTables.length}개 부서)`;

  return buildDashboardState({
    reportDate: safeFormState.reportDate,
    testOneOnly: safeFormState.testOneOnly,
    noticeMessage,
    warnings: result && result.warnings,
    isDiaryAccessible: result && result.isDiaryAccessible,
    teamLeadRows: result && result.teamLeadRows,
    analysisResults: result && result.analysisResults,
    deptWeekTables,
    deptSnapshots: result && result.deptSnapshots,
    stoppedReason: result && result.stoppedReason,
  });
}

module.exports = {
  WEEKDAY_ORDER,
  weekdayLabelMap,
  normalizeSuperuserLoginId,
  readAuthState,
  buildFormState,
  buildDashboardState,
  buildDashboardStateFromCollectResult,
  parseDashboardState,
  serializeDashboardState,
  isFocusWeekday,
  getWeekdayMergedRow,
  buildDeptSummaryText,
  probeStaffAuth,
  analyzeStaffDiary,
  collectWeekly,
  clearAnalysisCache,
};
