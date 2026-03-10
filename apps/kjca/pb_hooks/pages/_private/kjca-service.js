const KJCA_EMAIL_DOMAIN = "kjca.local";
const KJCA_HOST = "http://www.kjca.co.kr";
const KJCA_LOGIN_URL = `${KJCA_HOST}/staff/auth/login_check`;
const KJCA_AUTH_URL = `${KJCA_HOST}/staff/auth`;
const CACHE_COLLECTION_NAME = "staff_diary_analysis_cache";
const GEMINI_MODEL_NAME = "gemini-2.5-flash-lite";
const PROMPT_VERSION = 4;
const GEMINI_MAX_ATTEMPTS = 3;

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri"];

const weekdayLabelMap = {
  mon: "월",
  tue: "화",
  wed: "수",
  thu: "목",
  fri: "금",
};

function emitLog(ctx, level, eventName, payload) {
  if (!ctx || typeof ctx[level] !== "function") {
    return;
  }

  if (payload === undefined) {
    ctx[level](eventName);
    return;
  }

  ctx[level](eventName, payload);
}

function parseJsonSafely(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

function extractJsonObjectText(text) {
  const normalized = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return "{}";
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
  if (!cookieHeader) return "";

  const cookieMap = {};
  String(cookieHeader)
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => !!chunk)
    .forEach((cookiePair) => {
      const separatorIndex = cookiePair.indexOf("=");
      if (separatorIndex === -1) return;
      const name = cookiePair.slice(0, separatorIndex).trim();
      const value = cookiePair.slice(separatorIndex + 1).trim();
      if (!name) return;
      cookieMap[name] = value;
    });

  return Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join("; ");
}

function extractCookieHeaderFromSetCookie(setCookieHeaders) {
  const cookieMap = {};

  setCookieHeaders.forEach((header) => {
    const cookiePair = String(header).split(";")[0].trim();
    if (!cookiePair) return;

    const separatorIndex = cookiePair.indexOf("=");
    if (separatorIndex === -1) return;

    const name = cookiePair.slice(0, separatorIndex).trim();
    const value = cookiePair.slice(separatorIndex + 1).trim();
    if (!name) return;

    cookieMap[name] = value;
  });

  return Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join("; ");
}

function mergeSetCookieIntoCookieHeader(cookieHeader, responseHeaders) {
  const setCookieHeaders = getHeaderValues(responseHeaders, "Set-Cookie");
  if (!setCookieHeaders.length) return cookieHeader;

  const nextCookie = normalizeCookieHeader(extractCookieHeaderFromSetCookie(setCookieHeaders));
  if (!nextCookie) return cookieHeader;

  const merged = cookieHeader ? `${cookieHeader}; ${nextCookie}` : nextCookie;
  return normalizeCookieHeader(merged);
}

function detectAuthRequiredHtml(html) {
  const text = String(html || "");
  if (text.includes("/staff/auth/login_check") || text.includes('id="mng_id"')) return true;

  const redirectRegex = /location\.href\s*=\s*(?:'|")\s*\/staff\/auth\s*(?:'|")/i;
  return redirectRegex.test(text);
}

function decodeHtmlEntities(text) {
  const source = String(text || "");
  return source
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || "").replace(/<[^>]*>/g, "")).trim();
}

function toAbsoluteKjcaUrl(host, maybeRelativeUrl) {
  const url = String(maybeRelativeUrl || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("?")) return `${host}/diary/${url}`;
  if (url.startsWith("/?") && url.includes("bd_idx=")) return `${host}/diary${url}`;
  if (url.startsWith("/")) return `${host}${url}`;
  return `${host}/${url}`;
}

function isAllowedKjcaUrl(host, url) {
  const normalized = String(url || "").trim();
  return normalized.startsWith(`${host}/`) || normalized.startsWith("http://www.kjca.co.kr/") || normalized.startsWith("https://www.kjca.co.kr/");
}

function extractPrintUrlFromCell(host, cellHtml) {
  const source = decodeHtmlEntities(String(cellHtml || ""));
  if (!source) return "";

  const candidates = [];
  const quotedUrlRegex = /['"]((?:https?:\/\/|\/|\?)[^'"]+)['"]/gi;
  let urlMatch = null;
  while ((urlMatch = quotedUrlRegex.exec(source))) {
    const candidate = String(urlMatch[1] || "").trim();
    if (!candidate) continue;
    candidates.push(candidate);
  }

  const normalized = candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => !!candidate)
    .filter((candidate) => candidate !== "#")
    .filter((candidate) => !/^javascript:/i.test(candidate))
    .filter((candidate) => !/^void\(0\)/i.test(candidate));

  if (!normalized.length) return "";

  const preferred = normalized.find((candidate) => candidate.includes("bd_idx=")) || normalized.find((candidate) => candidate.includes("/diary/") || candidate.startsWith("?site=")) || normalized[0];

  return toAbsoluteKjcaUrl(host, preferred);
}

function parseTeamLeadRowsFromDiaryHtml(diaryHtml, host) {
  const html = String(diaryHtml || "");
  const rows = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch = null;

  while ((trMatch = trRegex.exec(html))) {
    const trInner = trMatch[1] || "";
    if (!trInner.includes("data-label")) continue;

    const cellHtmlByLabel = {};
    const tdRegex = /<td\b[^>]*data-label\s*=\s*(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch = null;
    while ((tdMatch = tdRegex.exec(trInner))) {
      const label = stripTags(tdMatch[2]);
      const cellInner = tdMatch[3] || "";
      if (!label) continue;
      cellHtmlByLabel[label] = cellInner;
    }

    const position = stripTags(cellHtmlByLabel["직책"] || "");
    if (position !== "팀장") continue;

    const dept = stripTags(cellHtmlByLabel["부서"] || "");
    const staffName = stripTags(cellHtmlByLabel["성명"] || "");
    const printCell = String(cellHtmlByLabel["인쇄"] || "");
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
    const key = row.dept || "";
    if (!key || seen[key]) return;
    seen[key] = true;
    uniqueRows.push(row);
  });

  return { rows: uniqueRows };
}

function buildBrowserLikeHeaders(host, cookieHeader, referer) {
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "identity",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    Host: host.replace(/^https?:\/\//i, ""),
  };

  if (cookieHeader) headers.Cookie = cookieHeader;
  if (referer) headers.Referer = referer;
  return headers;
}

function buildTodayDateText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 날짜 입력값을 `YYYY-MM-DD` 형식으로 정규화합니다.
 * @param {string | string[] | null | undefined} value 폼이나 params에서 받은 날짜 값입니다.
 * @returns {string} 정규화된 날짜 문자열입니다.
 */
function normalizeReportDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return buildTodayDateText();
}

/**
 * 화면에서 쓰는 기본 폼 상태를 원본 입력값에서 정규화합니다.
 * @param {types.KjcaFormStateInput | null | undefined} value 페이지나 폼에서 받은 원본 입력값입니다.
 * @returns {types.KjcaFormState} 화면에서 바로 쓸 수 있는 폼 상태입니다.
 */
function buildFormState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    reportDate: normalizeReportDate(source.reportDate),
    testOneOnly: normalizeBool(source.testOneOnly),
  };
}

function escapeFilterValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function hashText(text) {
  const source = String(text || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${source.length}`;
}

function extractDivInnerHtmlByClasses(html, requiredClasses) {
  const source = String(html || "");
  if (!source) return "";

  const divStartRegex = /<div\b[^>]*class\s*=\s*(['"])([^'"]*)\1[^>]*>/gi;
  let match = null;
  while ((match = divStartRegex.exec(source))) {
    const classValue = String(match[2] || "");
    const ok = requiredClasses.every((cls) => new RegExp(`\\b${cls}\\b`).test(classValue));
    if (!ok) continue;

    const openTagEndIndex = match.index + match[0].length;
    const tokenRegex = /<\/?div\b/gi;
    tokenRegex.lastIndex = openTagEndIndex;
    let depth = 1;

    let tokenMatch = null;
    while ((tokenMatch = tokenRegex.exec(source))) {
      const token = String(tokenMatch[0] || "").toLowerCase();
      if (token === "<div") {
        depth += 1;
        continue;
      }

      if (token === "</div") {
        depth -= 1;
        if (depth === 0) {
          const closeTagStartIndex = tokenMatch.index;
          return source.slice(openTagEndIndex, closeTagStartIndex);
        }
      }
    }

    return "";
  }

  return "";
}

function htmlToText(html) {
  const normalized = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ");
  return decodeHtmlEntities(normalized.replace(/<[^>]*>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\t+/g, " | ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter((item) => !!item);
}

function isNumericByteArray(value) {
  if (!Array.isArray(value)) return false;
  if (!value.length) return false;
  return value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
}

function normalizeJsonArrayField(value) {
  if (Array.isArray(value)) {
    if (isNumericByteArray(value)) {
      const text = String(toString(value) || "").trim();
      if (!text) return [];
      const parsedFromBytes = parseJsonSafely(text, null);
      if (Array.isArray(parsedFromBytes)) return normalizeStringArray(parsedFromBytes);
      return [];
    }
    return normalizeStringArray(value);
  }

  if (value === null || value === undefined) return [];

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = parseJsonSafely(trimmed, null);
    if (Array.isArray(parsed)) return normalizeStringArray(parsed);
    return normalizeStringArray([trimmed]);
  }

  return [];
}

function inferGemini429Cause(message, detailsText) {
  const source = `${String(message || "")} ${String(detailsText || "")}`.toLowerCase();
  if (!source.trim()) return "unknown";

  const hasQuotaSignal = source.includes("quota") || source.includes("billing") || source.includes("free tier") || source.includes("resource_exhausted");
  if (hasQuotaSignal) return "quota-or-billing-limit";

  const hasRateSignal = source.includes("rate") || source.includes("too many requests") || source.includes("per minute") || source.includes("retry");
  if (hasRateSignal) return "request-rate-limit";

  return "unknown";
}

function stringifyGeminiErrorDetails(details) {
  if (!Array.isArray(details)) return "";
  return details
    .map((detail) => {
      if (detail === null || detail === undefined) return "";
      const text = `${detail}`;
      return text === "[object Object]" ? JSON.stringify(detail) : text;
    })
    .join(" | ");
}

function parseDateText(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date();
  const [year, month, day] = text.split("-").map((unit) => Number(unit));
  return new Date(year, month - 1, day);
}

function formatDateText(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
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
  if (day === 1) return "mon";
  if (day === 2) return "tue";
  if (day === 3) return "wed";
  if (day === 4) return "thu";
  return "fri";
}

/**
 * 다양한 요일 표현을 내부 요일 키로 정규화합니다.
 * @param {unknown} value 문자열 또는 외부 입력으로 받은 요일 값입니다.
 * @returns {types.KjcaWeekday | ""} 인식 가능한 경우 내부 요일 키, 아니면 빈 문자열입니다.
 */
function normalizeWeekday(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (text === "mon" || text === "monday" || text === "월") return "mon";
  if (text === "tue" || text === "tuesday" || text === "화") return "tue";
  if (text === "wed" || text === "wednesday" || text === "수") return "wed";
  if (text === "thu" || text === "thursday" || text === "목") return "thu";
  if (text === "fri" || text === "friday" || text === "금") return "fri";
  return "";
}

function buildDateMatchParams(dateText) {
  const normalized = formatDateText(parseDateText(dateText));
  return {
    exact: normalized,
    like: `${normalized}%`,
  };
}

function normalizeNullableInt(value) {
  if (value === null || value === undefined || value === "") return null;
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
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (text === "true" || text === "1" || text === "y" || text === "yes" || text === "on") return true;
  return false;
}

function normalizeRecruitingExtract(value) {
  const source = value && typeof value === "object" ? value : {};
  const dailyPlanRaw = Array.isArray(source.dailyPlan) ? source.dailyPlan : [];
  const dailyPlan = dailyPlanRaw
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const weekday = normalizeWeekday(row.weekday);
      if (!weekday) return null;

      return {
        weekday,
        channelName: String(row.channelName || "").trim(),
        promotionContent: String(row.promotionContent || "").trim(),
        targetCount: normalizeNullableInt(row.targetCount),
        ownerName: String(row.ownerName || "").trim(),
        note: String(row.note || "").trim(),
      };
    })
    .filter((item) => !!item);

  const weekTableRowsRaw = Array.isArray(source.weekTableRows) ? source.weekTableRows : [];
  const weekTableRowsNormalized = weekTableRowsRaw
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const weekday = normalizeWeekday(row.weekday);
      if (!weekday) return null;

      return {
        weekday,
        channelName: String(row.channelName || row.promotionChannel || "").trim(),
        weeklyPlan: String(row.weeklyPlan || row.plan || "").trim(),
        promotionContent: String(row.promotionContent || "").trim(),
        targetText: String(row.targetText || row.target || "").trim(),
        resultText: String(row.resultText || row.result || "").trim(),
        recruitCountText: String(row.recruitCountText || row.countText || "").trim(),
        ownerName: String(row.ownerName || "").trim(),
        note: String(row.note || "").trim(),
        sortOrder: Math.max(0, Math.trunc(Number(row.sortOrder || 0))),
      };
    })
    .filter((item) => !!item);

  const weekTableRowsFallback = dailyPlan
    .map((row, index) => ({
      weekday: row.weekday,
      channelName: row.channelName,
      weeklyPlan: "",
      promotionContent: row.promotionContent,
      targetText: row.targetCount === null ? "" : String(row.targetCount),
      resultText: "",
      recruitCountText: "",
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
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return normalizeRecruitingExtract({});
    return normalizeRecruitingExtract(parseJsonSafely(text, {}));
  }
  if (Array.isArray(value)) {
    const isByteArray = value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
    if (!isByteArray) return normalizeRecruitingExtract({});
    const text = String(toString(value) || "").trim();
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
      const item = row && typeof row === "object" ? row : {};
      return {
        dept: String(item.dept || "").trim(),
        position: String(item.position || "").trim(),
        staffName: String(item.staffName || "").trim(),
        printUrl: String(item.printUrl || "").trim(),
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
    dept: String((item && item.dept) || "").trim(),
    position: String((item && item.position) || "").trim(),
    staffName: String((item && item.staffName) || "").trim(),
    ok: !(item && item.ok === false),
    error: String((item && item.error) || "").trim(),
    promotion: Array.isArray(item && item.promotion) ? item.promotion.map((entry) => String(entry || "").trim()).filter(Boolean) : [],
    vacation: Array.isArray(item && item.vacation) ? item.vacation.map((entry) => String(entry || "").trim()).filter(Boolean) : [],
    special: Array.isArray(item && item.special) ? item.special.map((entry) => String(entry || "").trim()).filter(Boolean) : [],
    recruiting: normalizeRecruitingExtract(item && item.recruiting),
    printUrl: String((item && item.printUrl) || "").trim(),
  }));
}

function normalizeWeekTextRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((item, index) => {
      const row = item && typeof item === "object" ? item : {};
      const weekday = normalizeWeekday(row.weekday);
      if (!weekday) return null;

      return {
        weekday,
        channelName: String(row.channelName || "").trim(),
        weeklyPlan: String(row.weeklyPlan || "").trim(),
        promotionContent: String(row.promotionContent || "").trim(),
        targetText: String(row.targetText || "").trim(),
        resultText: String(row.resultText || "").trim(),
        recruitCountText: String(row.recruitCountText || "").trim(),
        ownerName: String(row.ownerName || "").trim(),
        note: String(row.note || "").trim(),
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
        channelName: "",
        weeklyPlan: "",
        promotionContent: "",
        targetText: "",
        resultText: "",
        recruitCountText: "",
        ownerName: "",
        note: "",
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
      !!String(row.channelName || "").trim() ||
      !!String(row.weeklyPlan || "").trim() ||
      !!String(row.promotionContent || "").trim() ||
      !!String(row.targetText || "").trim() ||
      !!String(row.resultText || "").trim() ||
      !!String(row.recruitCountText || "").trim() ||
      !!String(row.ownerName || "").trim() ||
      !!String(row.note || "").trim(),
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
          !!String(row.channelName || "").trim() ||
          !!String(row.weeklyPlan || "").trim() ||
          !!String(row.promotionContent || "").trim() ||
          !!String(row.targetText || "").trim() ||
          !!String(row.resultText || "").trim() ||
          !!String(row.recruitCountText || "").trim() ||
          !!String(row.ownerName || "").trim() ||
          !!String(row.note || "").trim(),
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
      const source = item && typeof item === "object" ? item : {};
      return {
        dept: String(source.dept || "").trim(),
        todayWeekday: normalizeWeekday(source.todayWeekday) || "fri",
        rows: ensureWeekdayRows(source.rows),
      };
    })
    .filter((item) => !!item.dept)
    .sort((a, b) => a.dept.localeCompare(b.dept, "ko"));
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
      const source = item && typeof item === "object" ? item : {};
      return {
        dept: String(source.dept || "").trim(),
        monthTarget: normalizeNullableInt(source.monthTarget),
        weekTarget: normalizeNullableInt(source.weekTarget),
        rows: Array.isArray(source.rows)
          ? source.rows
              .map((row) => ({
                weekday: normalizeWeekday(row && row.weekday) || "mon",
                target: normalizeRequiredInt(row && row.target, 0),
                actual: normalizeRequiredInt(row && row.actual, 0),
                gap: Number.isFinite(Number(row && row.gap)) ? Math.trunc(Number(row.gap)) : 0,
              }))
              .filter((row) => !!row.weekday)
          : [],
        today:
          source.today && typeof source.today === "object"
            ? {
                weekday: normalizeWeekday(source.today.weekday) || "fri",
                target: normalizeRequiredInt(source.today.target, 0),
                actual: normalizeRequiredInt(source.today.actual, 0),
                gap: Number.isFinite(Number(source.today.gap)) ? Math.trunc(Number(source.today.gap)) : 0,
              }
            : {
                weekday: "fri",
                target: 0,
                actual: 0,
                gap: 0,
              },
        cumulative:
          source.cumulative && typeof source.cumulative === "object"
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
    .sort((a, b) => a.dept.localeCompare(b.dept, "ko"));
}

/**
 * 대시보드 렌더링에 필요한 전체 상태를 정규화합니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} input 페이지나 상호작용 응답에서 만든 원본 상태입니다.
 * @returns {types.KjcaDashboardState} 화면에서 바로 쓸 수 있는 대시보드 상태입니다.
 */
function buildDashboardState(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    reportDate: normalizeReportDate(source.reportDate),
    testOneOnly: normalizeBool(source.testOneOnly),
    noticeMessage: String(source.noticeMessage || "").trim(),
    errorMessage: String(source.errorMessage || "").trim(),
    warnings: Array.isArray(source.warnings) ? source.warnings.map((item) => String(item || "").trim()).filter(Boolean) : [],
    stoppedReason: String(source.stoppedReason || "").trim(),
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
  const text = String(value || "").trim();
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
      .map((row) => String(extractor(row) || "").trim())
      .filter(Boolean)
      .join(" / ");

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
  const text = String(dateText || "").trim();
  const matched = text.match(/^\d{4}-(\d{2})-\d{2}$/);
  if (!matched) return "금월";
  const month = Number(matched[1]);
  if (!Number.isFinite(month) || month < 1 || month > 12) return "금월";
  return `${month}월`;
}

/**
 * 부서 카드 상단에 표시할 요약 문구를 만듭니다.
 * @param {types.KjcaDeptSummaryParams | null | undefined} params 요약에 필요한 부서명, 날짜, 분석 결과입니다.
 * @returns {string} 화면에 표시할 요약 문구입니다.
 */
function buildDeptSummaryText(params) {
  const dept = String((params && params.dept) || "").trim();
  const reportDate = String((params && params.reportDate) || "").trim();
  const analysisResults = Array.isArray(params && params.analysisResults) ? params.analysisResults : [];
  const item = analysisResults.find((row) => row.dept === dept && row.ok);
  const monthTarget = item && item.recruiting ? item.recruiting.monthTarget : null;
  const monthAssignedCurrent = item && item.recruiting ? item.recruiting.monthAssignedCurrent : null;
  const monthTargetText = monthTarget === null ? "-" : `${monthTarget}건`;
  const monthAssignedText = monthAssignedCurrent === null ? "-" : `${monthAssignedCurrent}명`;
  const monthLabel = buildMonthLabel(reportDate);
  return `월 배정목표 : ${monthTargetText} / ${monthLabel} 현재 달성 : 배정 ${monthAssignedText}`;
}

/**
 * 관리자 로그인 ID를 KJCA 이메일 형식으로 정규화합니다.
 * @param {unknown} loginId 폼에서 받은 로그인 ID 값입니다.
 * @returns {string} 정규화된 로그인 ID 문자열입니다.
 */
function normalizeSuperuserLoginId(loginId) {
  const id = String(loginId || "").trim();
  if (!id) return "";
  if (id.includes("@")) return id;
  return `${id}@${KJCA_EMAIL_DOMAIN}`;
}

/**
 * 현재 PocketBase 요청에서 관리자 로그인 상태를 읽습니다.
 * @param {types.KjcaAuthStateParams | null | undefined} params 요청 객체가 들어있는 컨텍스트입니다.
 * @returns {types.KjcaAuthState} 화면과 API에서 공통으로 쓰는 인증 상태입니다.
 */
function readAuthState(params) {
  const request = params && params.request ? params.request : null;
  const authRecord = request && request.auth ? request.auth : null;
  const isSignedIn = !!authRecord;
  const isSuperuser = !!(authRecord && typeof authRecord.isSuperuser === "function" && authRecord.isSuperuser());
  const email = authRecord ? String(authRecord.get("email") || authRecord.email || "").trim() : "";
  return {
    authRecord,
    isSignedIn,
    isSuperuser,
    email,
  };
}

function ensureSuperuserRequest(ctx) {
  const authState = readAuthState(ctx);
  if (!authState.isSuperuser || !authState.authRecord) {
    throw new Error("PocketBase 슈퍼유저 로그인이 필요합니다.");
  }
  return authState;
}

function readMappedKjcaCredentials(ctx) {
  const authState = ensureSuperuserRequest(ctx);
  const superuserEmail = String(authState.email || "").trim();
  if (!superuserEmail) {
    throw new Error("슈퍼유저 이메일 정보를 확인할 수 없습니다.");
  }

  let userRecord = null;
  try {
    userRecord = $app.findAuthRecordByEmail("users", superuserEmail);
  } catch (error) {
    userRecord = null;
  }

  if (!userRecord) {
    throw new Error(`users 컬렉션에서 로그인 계정(${superuserEmail})을 찾지 못했습니다.`);
  }

  const mngId = String(userRecord.get("name") || "").trim();
  const mngPw = String(userRecord.get("kjcaPw") || "").trim();
  if (!mngId || !mngPw) {
    throw new Error("KJCA 계정 정보가 필요합니다. (users.name=mng_id, users.kjcaPw=mng_pw)");
  }

  return {
    authState,
    userRecord,
    mngId,
    mngPw,
  };
}

function buildServiceContext(ctx) {
  const source = ctx && typeof ctx === "object" ? ctx : {};
  return {
    ...source,
    dt: source.dt && typeof source.dt === "object" ? source.dt : {},
  };
}

/**
 * KJCA 관리자 사이트에 로그인해 재사용 가능한 세션 정보를 만듭니다.
 * @param {types.KjcaServiceContext | null | undefined} ctx 로그와 인증 정보를 포함한 서비스 컨텍스트입니다.
 * @returns {types.KjcaSession} 이후 요청에서 재사용할 KJCA 세션 정보입니다.
 */
function createKjcaSession(ctx) {
  const safeCtx = buildServiceContext(ctx);
  const credentials = readMappedKjcaCredentials(safeCtx);

  emitLog(safeCtx, "info", "kjca/session:start", {
    email: credentials.authState.email,
  });

  let cookieHeader = "";

  const authInitResponse = $http.send({
    url: KJCA_AUTH_URL,
    method: "GET",
    timeout: 20,
    headers: buildBrowserLikeHeaders(KJCA_HOST, "", `${KJCA_HOST}/`),
  });
  cookieHeader = mergeSetCookieIntoCookieHeader(cookieHeader, authInitResponse.headers);

  const loginBody =
    `url=${encodeURIComponent("/board/admin")}` + "&sf_mobile_key=" + "&sf_alarm_key=" + `&mng_id=${encodeURIComponent(credentials.mngId)}` + `&mng_pw=${encodeURIComponent(credentials.mngPw)}`;

  const loginResponse = $http.send({
    url: KJCA_LOGIN_URL,
    method: "POST",
    timeout: 20,
    body: loginBody,
    headers: {
      ...buildBrowserLikeHeaders(KJCA_HOST, cookieHeader, KJCA_AUTH_URL),
      "content-type": "application/x-www-form-urlencoded",
      Origin: KJCA_HOST,
    },
  });

  cookieHeader = mergeSetCookieIntoCookieHeader(cookieHeader, loginResponse.headers);

  emitLog(safeCtx, "info", "kjca/session:login-check", {
    statusCode: loginResponse.statusCode,
    setCookieCount: getHeaderValues(loginResponse.headers, "Set-Cookie").length,
  });

  if (!cookieHeader) {
    throw new Error("세션 쿠키를 확보하지 못했습니다.");
  }

  return {
    host: KJCA_HOST,
    loginUrl: KJCA_LOGIN_URL,
    staffAuthUrl: KJCA_AUTH_URL,
    cookieHeader,
  };
}

function fetchDiaryList(ctx, session, scDay) {
  const safeDay = normalizeReportDate(scDay);
  const diaryListUrl =
    `${session.host}/diary/?site=groupware&mn=1450&bd_type=1&sc_sort=bd_insert_date&sc_ord=desc` +
    `&sc_day_start=${encodeURIComponent(safeDay)}` +
    `&sc_day_end=${encodeURIComponent(safeDay)}` +
    "&sc_my_insert=Y&sc_my_appr=Y&sc_appr_type1=&sc_appr_type2=&sc_appr_type3=&sc_sf_name=";

  const diaryResponse = $http.send({
    url: diaryListUrl,
    method: "GET",
    timeout: 20,
    headers: buildBrowserLikeHeaders(session.host, session.cookieHeader, diaryListUrl),
  });

  session.cookieHeader = mergeSetCookieIntoCookieHeader(session.cookieHeader, diaryResponse.headers);

  const diaryHtml = toString(diaryResponse.body);
  const diaryAuthRequired = detectAuthRequiredHtml(diaryHtml);
  const isDiaryAccessible = diaryResponse.statusCode >= 200 && diaryResponse.statusCode < 300 && !diaryAuthRequired;
  const parsed = isDiaryAccessible ? parseTeamLeadRowsFromDiaryHtml(diaryHtml, session.host) : { rows: [] };

  emitLog(ctx, "info", "kjca/probe:diary-list", {
    scDay: safeDay,
    statusCode: diaryResponse.statusCode,
    isDiaryAccessible,
    teamLeadCount: parsed.rows.length,
  });

  return {
    ok: true,
    isDiaryAccessible,
    teamLeadRows: parsed.rows.map((row) => ({
      dept: row.dept,
      position: row.position,
      staffName: row.staffName,
      printUrl: row.printUrl,
    })),
  };
}

/**
 * 특정 일자의 KJCA 업무일지 접근 가능 여부와 팀장 목록을 확인합니다.
 * @param {types.KjcaServiceContext | null | undefined} ctx 로그와 인증 정보를 포함한 서비스 컨텍스트입니다.
 * @param {types.KjcaProbePayload | null | undefined} payload 조회할 일자를 담은 입력값입니다.
 * @param {types.KjcaSession | null | undefined} session 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
 * @returns {types.KjcaProbeResult} 접근 가능 여부와 팀장 목록을 담은 결과입니다.
 */
function probeStaffAuth(ctx, payload, session) {
  const safeCtx = buildServiceContext(ctx);
  const safeSession = session || createKjcaSession(safeCtx);
  const scDay = normalizeReportDate(payload && (payload.scDay || payload.reportDate));

  emitLog(safeCtx, "dbg", "kjca/probe:start", {
    scDay,
  });

  const result = fetchDiaryList(safeCtx, safeSession, scDay);

  emitLog(safeCtx, "dbg", "kjca/probe:response", {
    scDay,
    isDiaryAccessible: result.isDiaryAccessible,
    teamLeadCount: result.teamLeadRows.length,
  });

  return result;
}

function parseRetryAfterMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed * 1000);
}

function computeRetryDelayMs(attempt, retryAfterHeader) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs > 0) return retryAfterMs;
  const step = Math.max(0, Number(attempt) - 1);
  const backoffMs = 1500 * 2 ** step;
  const jitterMs = Math.trunc(Math.random() * 400);
  return backoffMs + jitterMs;
}

function isRetryableGeminiHttp(statusCode, rateLimitCauseGuess) {
  if (statusCode === 429 && rateLimitCauseGuess === "quota-or-billing-limit") return false;
  return statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function isRetryableGeminiTransportError(errorText) {
  const text = String(errorText || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("timeout") ||
    text.includes("deadline") ||
    text.includes("temporarily unavailable") ||
    text.includes("connection reset") ||
    text.includes("connection refused") ||
    text.includes("eof")
  );
}

function requestGeminiWithRetry(ctx, geminiPayload, context) {
  let lastStatusCode = 0;
  let lastResponseBody = "";
  let lastHeaders = {};
  let lastTransportError = "";
  let attempts = 0;

  while (attempts < GEMINI_MAX_ATTEMPTS) {
    attempts += 1;
    const attemptStartedAt = Date.now();

    try {
      const response = $http.send({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${context.geminiApiKey}`,
        method: "POST",
        timeout: 60,
        body: JSON.stringify(geminiPayload),
        headers: {
          "content-type": "application/json",
        },
      });

      const elapsedMs = Date.now() - attemptStartedAt;
      const statusCode = Number(response.statusCode || 0);
      const responseBody = toString(response.body);
      const headers = response.headers || {};
      const retryAfter = getHeaderValues(headers, "Retry-After")[0] || "";
      const parsedErrorBody = parseJsonSafely(responseBody, {});
      const geminiError = parsedErrorBody && parsedErrorBody.error ? parsedErrorBody.error : {};
      const geminiErrorMessage = String(geminiError.message || "").trim();
      const geminiErrorDetailsText = stringifyGeminiErrorDetails(geminiError.details);
      const rateLimitCauseGuess = statusCode === 429 ? inferGemini429Cause(geminiErrorMessage, geminiErrorDetailsText) : "";

      lastStatusCode = statusCode;
      lastResponseBody = responseBody;
      lastHeaders = headers;
      lastTransportError = "";

      if (statusCode >= 200 && statusCode < 300) {
        return {
          statusCode,
          responseBody,
          headers,
          attempts,
          elapsedMs,
          transportError: "",
        };
      }

      const canRetry = attempts < GEMINI_MAX_ATTEMPTS && isRetryableGeminiHttp(statusCode, rateLimitCauseGuess);
      if (!canRetry) {
        return {
          statusCode,
          responseBody,
          headers,
          attempts,
          elapsedMs,
          transportError: "",
        };
      }

      const delayMs = computeRetryDelayMs(attempts, retryAfter);
      emitLog(ctx, "warn", "kjca/analyze:gemini-retry", {
        index: context.index,
        dept: context.dept,
        attempt: attempts,
        statusCode,
        delayMs,
      });
      sleep(delayMs);
    } catch (error) {
      const elapsedMs = Date.now() - attemptStartedAt;
      const errorText = String(error || "").trim();
      lastStatusCode = 0;
      lastResponseBody = "";
      lastHeaders = {};
      lastTransportError = errorText;

      const canRetry = attempts < GEMINI_MAX_ATTEMPTS && isRetryableGeminiTransportError(errorText);
      if (!canRetry) {
        return {
          statusCode: 0,
          responseBody: "",
          headers: {},
          attempts,
          elapsedMs,
          transportError: errorText,
        };
      }

      const delayMs = computeRetryDelayMs(attempts);
      emitLog(ctx, "warn", "kjca/analyze:gemini-retry-transport", {
        index: context.index,
        dept: context.dept,
        attempt: attempts,
        error: errorText,
        delayMs,
      });
      sleep(delayMs);
    }
  }

  return {
    statusCode: lastStatusCode,
    responseBody: lastResponseBody,
    headers: lastHeaders,
    attempts,
    elapsedMs: 0,
    transportError: lastTransportError,
  };
}

function buildAnalyzeResult(params) {
  return {
    dept: String(params.dept || "").trim(),
    position: String(params.position || "").trim(),
    staffName: String(params.staffName || "").trim(),
    ok: params.ok !== false,
    error: String(params.error || "").trim(),
    promotion: normalizeStringArray(params.promotion),
    vacation: normalizeStringArray(params.vacation),
    special: normalizeStringArray(params.special),
    recruiting: normalizeRecruitingExtract(params.recruiting),
    printUrl: String(params.printUrl || "").trim(),
  };
}

function buildPrompt(params) {
  return (
    '아래는 업무일지 본문 텍스트야. 부서별로 "모집/홍보", "휴가", "특이사항"을 최대한 빠짐없이 추출해.\n' +
    '"모집"과 "홍보"는 같은 범주로 보고 모두 promotion 배열에 넣어.\n' +
    "추가로 모집/현황 비교에 필요한 구조화 정보(recruiting)도 함께 추출해.\n" +
    "recruiting.dailyPlan은 요일별 계획표(월~금)를 읽어 배열로 만들어.\n" +
    "recruiting.dailyActualCount는 당일 모집 실적(예: 모집 1명)을 숫자로 넣어.\n" +
    'recruiting.weekTableRows에는 "요일, 주간 홍보계획, 결과, 담당자, 비고, 모집홍보처, 모집 홍보내용, 모집목표, 모집 건수"를 텍스트로 최대한 보존해.\n' +
    "값이 없거나 판단 불가면 반드시 null을 넣어.\n" +
    "반드시 코드펜스 없이 JSON 객체만 반환해.\n" +
    "추출할 내용이 없으면 해당 배열은 빈 배열([])로 반환.\n" +
    "\n" +
    "응답 스키마:\n" +
    "{\n" +
    '  "promotion": ["string"],\n' +
    '  "vacation": ["string"],\n' +
    '  "special": ["string"],\n' +
    '  "recruiting": {\n' +
    '    "monthTarget": number | null,\n' +
    '    "monthAssignedCurrent": number | null,\n' +
    '    "weekTarget": number | null,\n' +
    '    "dailyPlan": [\n' +
    "      {\n" +
    '        "weekday": "mon" | "tue" | "wed" | "thu" | "fri",\n' +
    '        "channelName": "string",\n' +
    '        "promotionContent": "string",\n' +
    '        "targetCount": number | null,\n' +
    '        "ownerName": "string",\n' +
    '        "note": "string"\n' +
    "      }\n" +
    "    ],\n" +
    '    "dailyActualCount": number | null,\n' +
    '    "weekTableRows": [\n' +
    "      {\n" +
    '        "weekday": "mon" | "tue" | "wed" | "thu" | "fri",\n' +
    '        "channelName": "string",\n' +
    '        "weeklyPlan": "string",\n' +
    '        "promotionContent": "string",\n' +
    '        "targetText": "string",\n' +
    '        "resultText": "string",\n' +
    '        "recruitCountText": "string",\n' +
    '        "ownerName": "string",\n' +
    '        "note": "string"\n' +
    "      }\n" +
    "    ]\n" +
    "  }\n" +
    "}\n" +
    "\n" +
    `부서: ${params.dept}\n` +
    (params.staffName ? `성명: ${params.staffName}\n` : "") +
    "\n" +
    "본문:\n" +
    params.docText
  );
}

function buildCacheIdentityFilter(params) {
  const reportDateExact = String(params.reportDate || "").trim();
  const reportDateLike = `${reportDateExact}%`;
  return (
    `(reportDate = '${escapeFilterValue(reportDateExact)}' || reportDate ~ '${escapeFilterValue(reportDateLike)}')` +
    ` && dept = '${escapeFilterValue(params.dept)}'` +
    ` && printUrl = '${escapeFilterValue(params.printUrl)}'` +
    ` && sourceHash = '${escapeFilterValue(params.sourceHash)}'` +
    ` && promptVersion = ${Number(params.promptVersion) || 1}`
  );
}

function findSuccessCache(params) {
  const filter = `${buildCacheIdentityFilter(params)} && status = 'success'`;
  try {
    return $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, filter);
  } catch (error) {
    return null;
  }
}

function upsertSuccessCache(ctx, params) {
  const collection = $app.findCollectionByNameOrId(CACHE_COLLECTION_NAME);
  const lookupFilter = buildCacheIdentityFilter(params);
  let record = null;

  try {
    record = $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, lookupFilter);
  } catch (error) {
    record = null;
  }

  const targetRecord = record || new Record(collection);
  targetRecord.set("reportDate", params.reportDate);
  targetRecord.set("dept", params.dept);
  targetRecord.set("staffName", params.staffName);
  targetRecord.set("printUrl", params.printUrl);
  targetRecord.set("sourceHash", params.sourceHash);
  targetRecord.set("promotion", params.promotion || []);
  targetRecord.set("vacation", params.vacation || []);
  targetRecord.set("special", params.special || []);
  targetRecord.set("recruiting", params.recruiting || {});
  targetRecord.set("status", "success");
  targetRecord.set("errorMessage", "");
  targetRecord.set("model", GEMINI_MODEL_NAME);
  targetRecord.set("promptVersion", params.promptVersion);

  const createCacheDT = ctx.dt.createStaffDiaryAnalysisCacheDT;
  if (typeof createCacheDT === "function") {
    const cacheDT = createCacheDT(targetRecord);
    if (!cacheDT.canSaveSuccess()) {
      emitLog(ctx, "warn", "kjca/analyze:cache-skip", {
        dept: params.dept,
        reportDate: params.reportDate,
      });
      return;
    }
  }

  $app.save(targetRecord);
}

/**
 * 팀장 업무일지 본문을 읽어 AI 분석 결과 목록으로 변환합니다.
 * @param {types.KjcaServiceContext | null | undefined} ctx 로그와 DT 팩토리를 포함한 서비스 컨텍스트입니다.
 * @param {types.KjcaAnalyzePayload | null | undefined} payload 분석 날짜와 대상 목록을 담은 입력값입니다.
 * @param {types.KjcaSession | null | undefined} session 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
 * @returns {types.KjcaAnalyzeCallResult} 분석 결과 목록과 중단 사유를 담은 결과입니다.
 */
function analyzeStaffDiary(ctx, payload, session) {
  const safeCtx = buildServiceContext(ctx);
  const safeSession = session || createKjcaSession(safeCtx);
  const targets = Array.isArray(payload && payload.targets) ? payload.targets : [];
  const reportDate = normalizeReportDate(payload && payload.reportDate);
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_AI_KEY;

  if (!targets.length) {
    throw new Error("targets가 필요합니다.");
  }
  if (targets.length > 50) {
    throw new Error("targets는 최대 50개까지 지원합니다.");
  }
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY (또는 GEMINI_AI_KEY)가 설정되지 않았습니다.");
  }

  emitLog(safeCtx, "info", "kjca/analyze:start", {
    reportDate,
    targetsCount: targets.length,
  });

  const results = [];
  let stoppedReason = "";
  let alertMessage = "";

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index] || {};
    const dept = String(target.dept || "").trim();
    const position = String(target.position || "").trim();
    const staffName = String(target.staffName || "").trim();
    const printUrl = toAbsoluteKjcaUrl(safeSession.host, String(target.printUrl || "").trim());

    if (!dept || !printUrl) {
      emitLog(safeCtx, "warn", "kjca/analyze:target-skip-missing", {
        index,
        dept,
      });
      continue;
    }
    if (!isAllowedKjcaUrl(safeSession.host, printUrl)) {
      emitLog(safeCtx, "warn", "kjca/analyze:target-skip-url", {
        index,
        dept,
        printUrl,
      });
      continue;
    }

    const detailResponse = $http.send({
      url: printUrl,
      method: "GET",
      timeout: 20,
      headers: buildBrowserLikeHeaders(safeSession.host, safeSession.cookieHeader, printUrl),
    });
    safeSession.cookieHeader = mergeSetCookieIntoCookieHeader(safeSession.cookieHeader, detailResponse.headers);

    const detailHtml = toString(detailResponse.body);
    if (detailResponse.statusCode < 200 || detailResponse.statusCode >= 300) {
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: false,
          error: `원본 페이지 조회 실패 (HTTP ${detailResponse.statusCode})`,
          printUrl,
        }),
      );
      continue;
    }

    if (detectAuthRequiredHtml(detailHtml)) {
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: false,
          error: "로그인이 필요합니다.",
          printUrl,
        }),
      );
      continue;
    }

    const docInnerHtml = extractDivInnerHtmlByClasses(detailHtml, ["doc_text", "editor"]) || extractDivInnerHtmlByClasses(detailHtml, ["doc_text"]);
    const docText = htmlToText(docInnerHtml);
    const sourceHash = hashText(docText);

    if (!docText) {
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: false,
          error: `본문 영역(doc_text)을 찾지 못했습니다. (HTTP ${detailResponse.statusCode})`,
          printUrl,
        }),
      );
      continue;
    }

    const cachedRecord = findSuccessCache({
      reportDate,
      dept,
      printUrl,
      sourceHash,
      promptVersion: PROMPT_VERSION,
    });

    if (cachedRecord) {
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: true,
          promotion: normalizeJsonArrayField(cachedRecord.get("promotion")),
          vacation: normalizeJsonArrayField(cachedRecord.get("vacation")),
          special: normalizeJsonArrayField(cachedRecord.get("special")),
          recruiting: normalizeCachedRecruitingField(cachedRecord.get("recruiting")),
          printUrl,
        }),
      );
      continue;
    }

    const geminiAttemptResult = requestGeminiWithRetry(
      safeCtx,
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildPrompt({
                  dept,
                  staffName,
                  docText,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      },
      {
        index,
        dept,
        geminiApiKey,
      },
    );

    const responseBody = String(geminiAttemptResult.responseBody || "");
    const geminiStatusCode = Number(geminiAttemptResult.statusCode || 0);
    const parsedErrorBody = parseJsonSafely(responseBody, {});
    const geminiError = parsedErrorBody && parsedErrorBody.error ? parsedErrorBody.error : {};
    const geminiErrorMessage = String(geminiError.message || "").trim();
    const geminiErrorDetailsText = stringifyGeminiErrorDetails(geminiError.details);
    const rateLimitCauseGuess = geminiStatusCode === 429 ? inferGemini429Cause(geminiErrorMessage, geminiErrorDetailsText) : "";

    if (!(geminiStatusCode >= 200 && geminiStatusCode < 300)) {
      const errorText = geminiStatusCode > 0 ? `AI 요청 실패 (HTTP ${geminiStatusCode})` : `AI 요청 실패 (네트워크/타임아웃) ${String(geminiAttemptResult.transportError || "").trim()}`;

      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: false,
          error: errorText,
          printUrl,
        }),
      );

      if (rateLimitCauseGuess === "quota-or-billing-limit") {
        stoppedReason = "quota-exceeded";
        alertMessage = "Gemini 무료 쿼터가 소진되어 분석을 중단했습니다. 잠시 후 다시 시도하거나 과금/플랜을 확인해주세요.";
        break;
      }

      continue;
    }

    const geminiPayloadJson = parseJsonSafely(responseBody, {});
    const geminiText =
      geminiPayloadJson &&
      geminiPayloadJson.candidates &&
      geminiPayloadJson.candidates[0] &&
      geminiPayloadJson.candidates[0].content &&
      geminiPayloadJson.candidates[0].content.parts &&
      geminiPayloadJson.candidates[0].content.parts[0]
        ? geminiPayloadJson.candidates[0].content.parts[0].text || ""
        : "";
    const parsed = parseJsonSafely(extractJsonObjectText(geminiText), {});
    const promotion = normalizeStringArray(parsed && parsed.promotion);
    const vacation = normalizeStringArray(parsed && parsed.vacation);
    const special = normalizeStringArray(parsed && parsed.special);
    const recruiting = normalizeRecruitingExtract(parsed && parsed.recruiting);

    upsertSuccessCache(safeCtx, {
      reportDate,
      dept,
      staffName,
      printUrl,
      sourceHash,
      promptVersion: PROMPT_VERSION,
      promotion,
      vacation,
      special,
      recruiting,
    });

    results.push(
      buildAnalyzeResult({
        dept,
        position,
        staffName,
        ok: true,
        promotion,
        vacation,
        special,
        recruiting,
        printUrl,
      }),
    );
  }

  return {
    ok: true,
    results,
    stoppedReason,
    alertMessage,
  };
}

function shouldRetryAnalyzeError(errorText) {
  const text = String(errorText || "").toLowerCase();
  if (!text) return false;
  return text.includes("http 503") || text.includes("http 429") || text.includes("timeout") || text.includes("temporarily unavailable") || text.includes("connection reset");
}

function findWeekTextPlan(weekStartDate, dept) {
  const weekDate = buildDateMatchParams(weekStartDate);
  try {
    return $app.findFirstRecordByFilter("recruiting_week_text_plans", "(weekStartDate = {:exact} || weekStartDate ~ {:like}) && dept = {:dept}", {
      exact: weekDate.exact,
      like: weekDate.like,
      dept,
    });
  } catch (error) {
    return null;
  }
}

function findWeekTextRows(planId) {
  try {
    return $app.findRecordsByFilter("recruiting_week_text_rows", "planId = {:planId}", "weekday,sortOrder,created", 1000, 0, { planId });
  } catch (error) {
    return [];
  }
}

function isUniqueValueError(error) {
  return String(error || "").includes("Value must be unique");
}

function upsertWeekTextPlan(ctx, params) {
  const safeWeekStartDate = formatDateText(parseDateText(params.weekStartDate));
  const dept = String(params.dept || "").trim();
  if (!dept) return { ok: false, reason: "dept-empty" };

  const planCollection = $app.findCollectionByNameOrId("recruiting_week_text_plans");
  const rowCollection = $app.findCollectionByNameOrId("recruiting_week_text_rows");

  let plan = findWeekTextPlan(safeWeekStartDate, dept);
  const wasNew = !plan;
  if (!plan) plan = new Record(planCollection);

  plan.set("weekStartDate", safeWeekStartDate);
  plan.set("dept", dept);
  plan.set("status", "confirmed");

  const createPlanDT = ctx.dt.createRecruitingWeekTextPlanDT;
  if (typeof createPlanDT === "function") {
    const planDT = createPlanDT(plan);
    if (!planDT.canSaveConfirmed()) {
      return { ok: false, reason: "plan-invalid" };
    }
  }

  try {
    $app.save(plan);
  } catch (error) {
    if (!wasNew || !isUniqueValueError(error)) throw error;
    const existing = findWeekTextPlan(safeWeekStartDate, dept);
    if (!existing) throw error;
    existing.set("weekStartDate", safeWeekStartDate);
    existing.set("dept", dept);
    existing.set("status", "confirmed");
    $app.save(existing);
    plan = existing;
  }

  const nextRows = ensureWeekdayRows(params.rows);
  findWeekTextRows(plan.id).forEach((row) => {
    $app.delete(row);
  });

  const createRowDT = ctx.dt.createRecruitingWeekTextRowDT;
  nextRows.forEach((row) => {
    const record = new Record(rowCollection);
    record.set("planId", plan.id);
    record.set("weekday", row.weekday);
    record.set("channelName", row.channelName);
    record.set("weeklyPlan", row.weeklyPlan);
    record.set("promotionContent", row.promotionContent);
    record.set("targetText", row.targetText);
    record.set("resultText", row.resultText);
    record.set("recruitCountText", row.recruitCountText);
    record.set("ownerName", row.ownerName);
    record.set("note", row.note);
    record.set("sortOrder", row.sortOrder);

    if (typeof createRowDT === "function") {
      const rowDT = createRowDT(record);
      if (!rowDT.canSave()) return;
    }

    $app.save(record);
  });

  return { ok: true, planId: plan.id };
}

function upsertWeekTextRowsForWeekday(ctx, params) {
  const safeWeekStartDate = formatDateText(parseDateText(params.weekStartDate));
  const dept = String(params.dept || "").trim();
  const weekday = normalizeWeekday(params.weekday);
  if (!dept) return { ok: false, reason: "dept-empty" };
  if (!weekday) return { ok: false, reason: "weekday-empty" };

  let plan = findWeekTextPlan(safeWeekStartDate, dept);
  if (!plan) {
    const created = upsertWeekTextPlan(ctx, {
      weekStartDate: safeWeekStartDate,
      dept,
      rows: [],
    });
    if (!created.ok) return created;
    plan = findWeekTextPlan(safeWeekStartDate, dept);
  }
  if (!plan) return { ok: false, reason: "plan-create-failed" };

  const rowCollection = $app.findCollectionByNameOrId("recruiting_week_text_rows");
  findWeekTextRows(plan.id)
    .filter((row) => normalizeWeekday(row.get("weekday")) === weekday)
    .forEach((row) => {
      $app.delete(row);
    });

  const weekdayRows = normalizeWeekTextRows(params.rows).filter((row) => row.weekday === weekday);
  if (weekdayRows.length === 0) return { ok: true, reason: "weekday-empty-rows" };

  const createRowDT = ctx.dt.createRecruitingWeekTextRowDT;
  weekdayRows.forEach((row, index) => {
    const record = new Record(rowCollection);
    record.set("planId", plan.id);
    record.set("weekday", row.weekday);
    record.set("channelName", row.channelName);
    record.set("weeklyPlan", row.weeklyPlan);
    record.set("promotionContent", row.promotionContent);
    record.set("targetText", row.targetText);
    record.set("resultText", row.resultText);
    record.set("recruitCountText", row.recruitCountText);
    record.set("ownerName", row.ownerName);
    record.set("note", row.note);
    record.set("sortOrder", index);

    if (typeof createRowDT === "function") {
      const rowDT = createRowDT(record);
      if (!rowDT.canSave()) return;
    }

    $app.save(record);
  });

  return { ok: true };
}

function findWeekPlan(weekStartDate, dept) {
  const weekDate = buildDateMatchParams(weekStartDate);
  try {
    return $app.findFirstRecordByFilter("recruiting_week_plans", "(weekStartDate = {:exact} || weekStartDate ~ {:like}) && dept = {:dept}", { exact: weekDate.exact, like: weekDate.like, dept });
  } catch (error) {
    return null;
  }
}

function findWeekPlanItems(planId) {
  try {
    return $app.findRecordsByFilter("recruiting_week_plan_items", "planId = {:planId}", "weekday,sortOrder,created", 500, 0, { planId });
  } catch (error) {
    return [];
  }
}

function findWeekResults(weekStartDate, dept) {
  const weekDate = buildDateMatchParams(weekStartDate);
  try {
    return $app.findRecordsByFilter("recruiting_daily_results", "(weekStartDate = {:exact} || weekStartDate ~ {:like}) && dept = {:dept}", "reportDate", 500, 0, {
      exact: weekDate.exact,
      like: weekDate.like,
      dept,
    });
  } catch (error) {
    return [];
  }
}

function upsertRecruitingWeekPlan(ctx, params) {
  const dept = String((params && params.dept) || "").trim();
  if (!dept) return { ok: false, reason: "dept-empty" };

  const safeWeekStartDate = formatDateText(parseDateText(params.weekStartDate));
  const planCollection = $app.findCollectionByNameOrId("recruiting_week_plans");
  const itemCollection = $app.findCollectionByNameOrId("recruiting_week_plan_items");

  let plan = findWeekPlan(safeWeekStartDate, dept);
  const wasNew = !plan;
  if (!plan) plan = new Record(planCollection);

  plan.set("weekStartDate", safeWeekStartDate);
  plan.set("dept", dept);
  plan.set("monthTarget", params.monthTarget);
  plan.set("weekTarget", params.weekTarget);
  plan.set("status", "confirmed");

  const createPlanDT = ctx.dt.createRecruitingWeekPlanDT;
  if (typeof createPlanDT === "function") {
    const planDT = createPlanDT(plan);
    if (!planDT.canSaveConfirmed()) {
      return { ok: false, reason: "plan-invalid" };
    }
  }

  try {
    $app.save(plan);
  } catch (error) {
    if (!wasNew || !isUniqueValueError(error)) throw error;

    const existing = findWeekPlan(safeWeekStartDate, dept);
    if (!existing) throw error;

    existing.set("weekStartDate", safeWeekStartDate);
    existing.set("dept", dept);
    existing.set("monthTarget", params.monthTarget);
    existing.set("weekTarget", params.weekTarget);
    existing.set("status", "confirmed");
    $app.save(existing);
    plan = existing;
  }

  findWeekPlanItems(plan.id).forEach((item) => {
    $app.delete(item);
  });

  const normalizedItems = (Array.isArray(params.items) ? params.items : [])
    .map((item, index) => ({
      weekday: normalizeWeekday(item.weekday),
      channelName: String(item.channelName || "").trim(),
      promotionContent: String(item.promotionContent || "").trim(),
      targetCount: normalizeNullableInt(item.targetCount),
      ownerName: String(item.ownerName || "").trim(),
      note: String(item.note || "").trim(),
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Math.trunc(Number(item.sortOrder)) : index,
    }))
    .filter((item) => !!item.weekday);

  const fallbackWeekTarget = normalizeNullableInt(params.weekTarget);
  let nextItems = normalizedItems;

  if (nextItems.length === 0 && (fallbackWeekTarget || 0) > 0) {
    const base = Math.floor(fallbackWeekTarget / WEEKDAY_ORDER.length);
    let remain = fallbackWeekTarget % WEEKDAY_ORDER.length;
    nextItems = WEEKDAY_ORDER.map((weekday, index) => {
      const add = remain > 0 ? 1 : 0;
      if (remain > 0) remain -= 1;
      return {
        weekday,
        channelName: "",
        promotionContent: "",
        targetCount: base + add,
        ownerName: "",
        note: "주목표 자동분배",
        sortOrder: index,
      };
    });
  }

  const createItemDT = ctx.dt.createRecruitingWeekPlanItemDT;
  nextItems.forEach((item) => {
    const record = new Record(itemCollection);
    record.set("planId", plan.id);
    record.set("weekday", item.weekday);
    record.set("channelName", item.channelName);
    record.set("promotionContent", item.promotionContent);
    record.set("targetCount", item.targetCount);
    record.set("ownerName", item.ownerName);
    record.set("note", item.note);
    record.set("sortOrder", item.sortOrder);

    if (typeof createItemDT === "function") {
      const itemDT = createItemDT(record);
      if (!itemDT.canSave()) return;
    }

    $app.save(record);
  });

  return { ok: true };
}

function upsertRecruitingDailyResult(ctx, params) {
  const dept = String((params && params.dept) || "").trim();
  if (!dept) return { ok: false, reason: "dept-empty" };

  const safeReportDate = formatDateText(parseDateText(params.reportDate));
  const safeWeekStartDate = formatDateText(parseDateText(params.weekStartDate));
  const safeWeekday = normalizeWeekday(params.weekday) || toWeekdayKey(safeReportDate);
  const safeActualCount = normalizeNullableInt(params.actualCount);
  if (safeActualCount === null) return { ok: false, reason: "actualCount-invalid" };

  const collection = $app.findCollectionByNameOrId("recruiting_daily_results");
  const reportDate = buildDateMatchParams(safeReportDate);

  let record = null;
  try {
    record = $app.findFirstRecordByFilter("recruiting_daily_results", "(reportDate = {:exact} || reportDate ~ {:like}) && dept = {:dept}", { exact: reportDate.exact, like: reportDate.like, dept });
  } catch (error) {
    record = null;
  }

  const target = record || new Record(collection);
  target.set("reportDate", safeReportDate);
  target.set("weekStartDate", safeWeekStartDate);
  target.set("dept", dept);
  target.set("weekday", safeWeekday);
  target.set("actualCount", safeActualCount);
  target.set("sourceType", "ai");
  target.set("memo", "AI 자동 추출");

  const createDailyResultDT = ctx.dt.createRecruitingDailyResultDT;
  if (typeof createDailyResultDT === "function") {
    const dailyResultDT = createDailyResultDT(target);
    if (!dailyResultDT.canSaveAiResult()) {
      return { ok: false, reason: "daily-result-invalid" };
    }
  }

  try {
    $app.save(target);
  } catch (error) {
    if (!!record || !isUniqueValueError(error)) throw error;

    const existing = $app.findFirstRecordByFilter("recruiting_daily_results", "(reportDate = {:exact} || reportDate ~ {:like}) && dept = {:dept}", {
      exact: reportDate.exact,
      like: reportDate.like,
      dept,
    });

    existing.set("reportDate", safeReportDate);
    existing.set("weekStartDate", safeWeekStartDate);
    existing.set("dept", dept);
    existing.set("weekday", safeWeekday);
    existing.set("actualCount", safeActualCount);
    existing.set("sourceType", "ai");
    existing.set("memo", "AI 자동 추출");
    $app.save(existing);
  }

  return { ok: true };
}

/**
 * 특정 날짜와 부서의 분석 캐시를 삭제합니다.
 * @param {types.KjcaServiceContext | null | undefined} ctx 로그와 인증 정보를 포함한 서비스 컨텍스트입니다.
 * @param {types.KjcaCacheClearPayload | null | undefined} payload 삭제 대상 날짜와 부서를 담은 입력값입니다.
 * @returns {types.KjcaCacheClearResult} 삭제 결과 요약입니다.
 */
function clearAnalysisCache(ctx, payload) {
  const safeCtx = buildServiceContext(ctx);
  ensureSuperuserRequest(safeCtx);

  const reportDate = normalizeReportDate(payload && payload.reportDate);
  const dept = String((payload && payload.dept) || "").trim();
  if (!dept) {
    throw new Error("부서(dept)가 필요합니다.");
  }

  const filter = `(reportDate = '${escapeFilterValue(reportDate)}' || reportDate ~ '${escapeFilterValue(`${reportDate}%`)}')` + ` && dept = '${escapeFilterValue(dept)}'`;

  let rows = [];
  try {
    rows = $app.findRecordsByFilter(CACHE_COLLECTION_NAME, filter, "created", 1000, 0);
  } catch (error) {
    rows = [];
  }

  rows.forEach((row) => {
    $app.delete(row);
  });

  return {
    ok: true,
    reportDate,
    dept,
    deletedCount: rows.length,
  };
}

/**
 * 특정 날짜 기준으로 업무일지 분석과 주간 집계를 한 번에 수행합니다.
 * @param {types.KjcaServiceContext | null | undefined} ctx 로그와 DT 팩토리를 포함한 서비스 컨텍스트입니다.
 * @param {types.KjcaCollectPayload | null | undefined} payload 집계 날짜와 테스트 옵션을 담은 입력값입니다.
 * @returns {types.KjcaCollectResult} 집계 후 화면 구성에 필요한 전체 결과입니다.
 */
function collectWeekly(ctx, payload) {
  const safeCtx = buildServiceContext(ctx);
  ensureSuperuserRequest(safeCtx);

  const reportDate = normalizeReportDate(payload && payload.reportDate);
  const weekStartDate = buildWeekStartDate(reportDate);
  const reportWeekday = toWeekdayKey(reportDate);
  const testOneOnly = normalizeBool(payload && payload.testOneOnly);
  const warnings = [];

  const session = createKjcaSession(safeCtx);

  const todayProbe = probeStaffAuth(safeCtx, { scDay: reportDate }, session);
  const teamLeadRows = normalizeTeamLeadRows(todayProbe.teamLeadRows);
  const todayTargets = buildUniqueTargets(teamLeadRows);
  const collectTargets = testOneOnly ? todayTargets.slice(0, 1) : todayTargets;

  if (!collectTargets.length) {
    throw new Error("해당 일자 팀장 일지를 찾지 못했습니다.");
  }

  const missingPlanDepts = collectTargets.map((target) => target.dept).filter((dept) => !findWeekPlan(weekStartDate, dept));

  if (missingPlanDepts.length > 0) {
    let mondayTargetsSource = todayTargets;

    if (reportDate !== weekStartDate) {
      const mondayProbe = probeStaffAuth(safeCtx, { scDay: weekStartDate }, session);
      mondayTargetsSource = buildUniqueTargets(normalizeTeamLeadRows(mondayProbe.teamLeadRows));
    }

    const mondayTargetMap = new Map(mondayTargetsSource.map((target) => [target.dept, target]));
    const bootstrapTargets = missingPlanDepts.map((dept) => mondayTargetMap.get(dept)).filter((target) => !!target);

    if (bootstrapTargets.length > 0) {
      const mondayAnalyze = analyzeStaffDiary(
        safeCtx,
        {
          reportDate: weekStartDate,
          targets: bootstrapTargets,
        },
        session,
      );

      (Array.isArray(mondayAnalyze.results) ? mondayAnalyze.results : [])
        .filter((item) => item && item.ok !== false)
        .forEach((item) => {
          const recruiting = normalizeRecruitingExtract(item.recruiting);
          if (!hasWeekPlanData(recruiting)) return;

          try {
            const result = upsertRecruitingWeekPlan(safeCtx, {
              weekStartDate,
              dept: String(item.dept || "").trim(),
              monthTarget: recruiting.monthTarget,
              weekTarget: recruiting.weekTarget,
              items: recruiting.dailyPlan,
            });
            if (!result.ok) warnings.push(`weekPlan skip: ${String(item.dept || "-")} (${result.reason || "unknown"})`);
          } catch (error) {
            warnings.push(`weekPlan error: ${String(item.dept || "-")} (${String(error)})`);
          }

          try {
            const textPlanResult = upsertWeekTextPlan(safeCtx, {
              weekStartDate,
              dept: String(item.dept || "").trim(),
              rows: ensureWeekdayRows(recruiting.weekTableRows),
            });
            if (!textPlanResult.ok) {
              warnings.push(`weekTextPlan skip: ${String(item.dept || "-")} (${textPlanResult.reason || "unknown"})`);
            }
          } catch (error) {
            warnings.push(`weekTextPlan error: ${String(item.dept || "-")} (${String(error)})`);
          }
        });
    }
  }

  const todayAnalyze = analyzeStaffDiary(
    safeCtx,
    {
      reportDate,
      targets: collectTargets,
    },
    session,
  );

  let finalAlertMessage = String(todayAnalyze.alertMessage || "").trim();
  let finalStoppedReason = String(todayAnalyze.stoppedReason || "").trim();
  let analysisResults = normalizeAnalyzeResults(todayAnalyze.results);

  const targetKeyMap = new Map();
  collectTargets.forEach((target) => {
    const dept = String((target && target.dept) || "").trim();
    const printUrl = String((target && target.printUrl) || "").trim();
    if (!dept || !printUrl) return;
    targetKeyMap.set(`${dept}||${printUrl}`, {
      dept,
      position: String(target.position || "").trim(),
      staffName: String(target.staffName || "").trim(),
      printUrl,
    });
  });

  const retryTargets = analysisResults
    .filter((item) => !item.ok && shouldRetryAnalyzeError(item.error))
    .map((item) => targetKeyMap.get(`${item.dept}||${item.printUrl}`))
    .filter((item, index, array) => {
      if (!item) return false;
      return array.findIndex((candidate) => `${candidate.dept}||${candidate.printUrl}` === `${item.dept}||${item.printUrl}`) === index;
    });

  if (retryTargets.length > 0) {
    warnings.push(`AI 재시도 시작: ${retryTargets.length}건`);
    sleep(1200);
    try {
      const retryAnalyze = analyzeStaffDiary(
        safeCtx,
        {
          reportDate,
          targets: retryTargets,
        },
        session,
      );

      const retriedResults = normalizeAnalyzeResults(retryAnalyze.results);
      const retriedMap = new Map(retriedResults.map((item) => [`${item.dept}||${item.printUrl}`, item]));
      let recoveredCount = 0;

      analysisResults = analysisResults.map((item) => {
        const key = `${item.dept}||${item.printUrl}`;
        const retried = retriedMap.get(key);
        if (!retried) return item;
        if (retried.ok) recoveredCount += 1;
        return retried;
      });

      warnings.push(`AI 재시도 완료: 성공 ${recoveredCount}건 / 대상 ${retryTargets.length}건`);
      if (!finalAlertMessage) finalAlertMessage = String(retryAnalyze.alertMessage || "").trim();
      if (!finalStoppedReason) finalStoppedReason = String(retryAnalyze.stoppedReason || "").trim();
    } catch (error) {
      warnings.push(`AI 재시도 호출 실패: ${String(error)}`);
    }
  }

  analysisResults
    .filter((item) => item.ok)
    .forEach((item) => {
      const safeDept = String(item.dept || "").trim();
      if (!safeDept) {
        warnings.push("dailyResult skip: dept-empty");
        return;
      }

      const allWeekTextRows = normalizeWeekTextRows(item.recruiting.weekTableRows);
      const canReplaceWeekTable = hasWeekTextContent(allWeekTextRows) && getDistinctWeekdayCount(allWeekTextRows) >= WEEKDAY_ORDER.length;

      if (canReplaceWeekTable) {
        try {
          const textPlanResult = upsertWeekTextPlan(safeCtx, {
            weekStartDate,
            dept: safeDept,
            rows: allWeekTextRows,
          });
          if (!textPlanResult.ok) warnings.push(`weekTextPlan skip: ${safeDept} (${textPlanResult.reason || "unknown"})`);
        } catch (error) {
          warnings.push(`weekTextPlan error: ${safeDept} (${String(error)})`);
        }
      } else {
        const todayTextRows = allWeekTextRows.filter((row) => row.weekday === reportWeekday);
        if (todayTextRows.length > 0) {
          try {
            const textUpdateResult = upsertWeekTextRowsForWeekday(safeCtx, {
              weekStartDate,
              dept: safeDept,
              weekday: reportWeekday,
              rows: todayTextRows,
            });
            if (!textUpdateResult.ok) warnings.push(`weekTextDaily skip: ${safeDept} (${textUpdateResult.reason || "unknown"})`);
          } catch (error) {
            warnings.push(`weekTextDaily error: ${safeDept} (${String(error)})`);
          }
        }
      }

      const safeActual = normalizeNullableInt(item.recruiting.dailyActualCount);
      if (safeActual === null) {
        warnings.push(`dailyResult skip: ${item.dept || "-"} (actualCount-empty)`);
        return;
      }

      try {
        const result = upsertRecruitingDailyResult(safeCtx, {
          reportDate,
          weekStartDate,
          dept: safeDept,
          weekday: reportWeekday,
          actualCount: normalizeRequiredInt(safeActual, 0),
        });
        if (!result.ok) warnings.push(`dailyResult skip: ${safeDept} (${result.reason || "unknown"})`);
      } catch (error) {
        warnings.push(`dailyResult error: ${safeDept} (${String(error)})`);
      }
    });

  const deptWeekTables = collectTargets
    .map((target) => {
      const plan = findWeekTextPlan(weekStartDate, target.dept);
      const planRows = plan
        ? findWeekTextRows(plan.id).map((row) => ({
            weekday: normalizeWeekday(row.get("weekday")) || "mon",
            channelName: String(row.get("channelName") || "").trim(),
            weeklyPlan: String(row.get("weeklyPlan") || "").trim(),
            promotionContent: String(row.get("promotionContent") || "").trim(),
            targetText: String(row.get("targetText") || "").trim(),
            resultText: String(row.get("resultText") || "").trim(),
            recruitCountText: String(row.get("recruitCountText") || "").trim(),
            ownerName: String(row.get("ownerName") || "").trim(),
            note: String(row.get("note") || "").trim(),
            sortOrder: Math.trunc(Number(row.get("sortOrder") || 0)),
          }))
        : [];
      return {
        dept: target.dept,
        todayWeekday: reportWeekday,
        rows: ensureWeekdayRows(planRows),
      };
    })
    .sort((a, b) => a.dept.localeCompare(b.dept, "ko"));

  const deptSnapshots = collectTargets
    .map((target) => {
      const plan = findWeekPlan(weekStartDate, target.dept);
      const planItems = plan ? findWeekPlanItems(plan.id) : [];
      const weekResults = findWeekResults(weekStartDate, target.dept);
      const rows = buildSnapshotRows(
        planItems.map((item) => ({
          weekday: item.get("weekday"),
          targetCount: item.get("targetCount"),
        })),
        weekResults.map((item) => ({
          weekday: item.get("weekday"),
          actualCount: item.get("actualCount"),
        })),
      );
      const today = rows.find((row) => row.weekday === reportWeekday) || {
        weekday: reportWeekday,
        target: 0,
        actual: 0,
        gap: 0,
      };
      const endIndex = WEEKDAY_ORDER.findIndex((weekday) => weekday === reportWeekday);
      const cumulative = rows.slice(0, endIndex + 1).reduce(
        (acc, row) => {
          acc.target += row.target;
          acc.actual += row.actual;
          acc.gap += row.gap;
          return acc;
        },
        { target: 0, actual: 0, gap: 0 },
      );
      return {
        dept: target.dept,
        monthTarget: plan ? normalizeNullableInt(plan.get("monthTarget")) : null,
        weekTarget: plan ? normalizeNullableInt(plan.get("weekTarget")) : null,
        rows,
        today,
        cumulative,
      };
    })
    .sort((a, b) => a.dept.localeCompare(b.dept, "ko"));

  return {
    ok: true,
    isDiaryAccessible: !!todayProbe.isDiaryAccessible,
    teamLeadRows,
    analysisResults,
    deptSnapshots,
    deptWeekTables,
    alertMessage: finalAlertMessage,
    stoppedReason: finalStoppedReason,
    warnings,
  };
}

/**
 * 수집 결과를 화면용 대시보드 상태로 변환합니다.
 * @param {Partial<types.KjcaCollectResult> | null | undefined} result 수집 API가 돌려준 결과입니다.
 * @param {types.KjcaFormStateInput | null | undefined} formState 현재 화면의 폼 상태 입력값입니다.
 * @returns {types.KjcaDashboardState} 렌더링에 바로 쓸 수 있는 대시보드 상태입니다.
 */
function buildDashboardStateFromCollectResult(result, formState) {
  const safeFormState = buildFormState(formState);
  const deptWeekTables = normalizeDeptWeekTables(result && result.deptWeekTables);
  const alertMessage = String((result && result.alertMessage) || "").trim();
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
  KJCA_EMAIL_DOMAIN,
  WEEKDAY_ORDER,
  weekdayLabelMap,
  normalizeSuperuserLoginId,
  readAuthState,
  buildFormState,
  buildDashboardState,
  buildDashboardStateFromCollectResult,
  parseDashboardState,
  serializeDashboardState,
  normalizeReportDate,
  normalizeBool,
  normalizeWeekday,
  normalizeAnalyzeResults,
  normalizeTeamLeadRows,
  normalizeDeptWeekTables,
  normalizeDeptSnapshots,
  buildWeekStartDate,
  toWeekdayKey,
  isFocusWeekday,
  getWeekdayMergedRow,
  buildDeptSummaryText,
  createKjcaSession,
  probeStaffAuth,
  analyzeStaffDiary,
  collectWeekly,
  clearAnalysisCache,
};
