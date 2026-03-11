/**
 * 인증, 외부 세션, 업무일지 접근 확인 helper를 조립합니다.
 * @param {object} deps 공용 상수, helper, 로그 함수 묶음입니다.
 * @returns {object} 인증과 세션 관련 함수 묶음입니다.
 */
function createKjcaAuth(deps) {
  const {
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
  } = deps;

  /**
   * 관리자 로그인 ID를 KJCA 이메일 형식으로 정규화합니다.
   * @param {unknown} loginId 폼에서 받은 로그인 ID 값입니다.
   * @returns {string} 정규화된 로그인 ID 문자열입니다.
   */
  function normalizeSuperuserLoginId(loginId) {
    const id = String(loginId || '').trim();
    if (!id) return '';
    if (id.includes('@')) return id;
    return `${id}@${KJCA_EMAIL_DOMAIN}`;
  }

  /**
   * 현재 PocketBase 요청에서 관리자 로그인 상태를 읽습니다.
   * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
   * @returns {types.KjcaAuthState} 화면과 API에서 공통으로 쓰는 인증 상태입니다.
   */
  function readAuthState(request) {
    const authRecord = request && request.auth ? request.auth : null;
    const isSignedIn = !!authRecord;
    const isSuperuser = !!(authRecord && typeof authRecord.isSuperuser === 'function' && authRecord.isSuperuser());
    const email = authRecord ? String(authRecord.get('email') || authRecord.email || '').trim() : '';
    return {
      authRecord,
      isSignedIn,
      isSuperuser,
      email,
    };
  }

  function ensureSuperuserRequest(request) {
    const authState = readAuthState(request);
    if (!authState.isSuperuser || !authState.authRecord) {
      throw new Error('PocketBase 슈퍼유저 로그인이 필요합니다.');
    }
    return authState;
  }

  function readMappedKjcaCredentials(request) {
    const authState = ensureSuperuserRequest(request);
    const superuserEmail = String(authState.email || '').trim();
    if (!superuserEmail) {
      throw new Error('슈퍼유저 이메일 정보를 확인할 수 없습니다.');
    }

    let userRecord = null;
    try {
      userRecord = $app.findAuthRecordByEmail('users', superuserEmail);
    } catch (error) {
      userRecord = null;
    }

    if (!userRecord) {
      throw new Error(`users 컬렉션에서 로그인 계정(${superuserEmail})을 찾지 못했습니다.`);
    }

    const mngId = String(userRecord.get('name') || '').trim();
    const mngPw = String(userRecord.get('kjcaPw') || '').trim();
    if (!mngId || !mngPw) {
      throw new Error('KJCA 계정 정보가 필요합니다. (users.name=mng_id, users.kjcaPw=mng_pw)');
    }

    return {
      authState,
      userRecord,
      mngId,
      mngPw,
    };
  }

  /**
   * KJCA 관리자 사이트에 로그인해 재사용 가능한 세션 정보를 만듭니다.
   * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
   * @returns {types.KjcaSession} 이후 요청에서 재사용할 KJCA 세션 정보입니다.
   */
  function createKjcaSession(request) {
    const credentials = readMappedKjcaCredentials(request);

    info('kjca/session:start', {
      email: credentials.authState.email,
    });

    let cookieHeader = '';

    const authInitResponse = $http.send({
      url: KJCA_AUTH_URL,
      method: 'GET',
      timeout: 20,
      headers: buildBrowserLikeHeaders(KJCA_HOST, '', `${KJCA_HOST}/`),
    });
    cookieHeader = mergeSetCookieIntoCookieHeader(cookieHeader, authInitResponse.headers);

    const loginBody =
      `url=${encodeURIComponent('/board/admin')}` + '&sf_mobile_key=' + '&sf_alarm_key=' + `&mng_id=${encodeURIComponent(credentials.mngId)}` + `&mng_pw=${encodeURIComponent(credentials.mngPw)}`;

    const loginResponse = $http.send({
      url: KJCA_LOGIN_URL,
      method: 'POST',
      timeout: 20,
      body: loginBody,
      headers: {
        ...buildBrowserLikeHeaders(KJCA_HOST, cookieHeader, KJCA_AUTH_URL),
        'content-type': 'application/x-www-form-urlencoded',
        Origin: KJCA_HOST,
      },
    });

    cookieHeader = mergeSetCookieIntoCookieHeader(cookieHeader, loginResponse.headers);

    info('kjca/session:login-check', {
      statusCode: loginResponse.statusCode,
      setCookieCount: getHeaderValues(loginResponse.headers, 'Set-Cookie').length,
    });

    if (!cookieHeader) {
      throw new Error('세션 쿠키를 확보하지 못했습니다.');
    }

    return {
      host: KJCA_HOST,
      loginUrl: KJCA_LOGIN_URL,
      staffAuthUrl: KJCA_AUTH_URL,
      cookieHeader,
    };
  }

  function fetchDiaryList(session, scDay) {
    const safeDay = normalizeReportDate(scDay);
    const diaryListUrl =
      `${session.host}/diary/?site=groupware&mn=1450&bd_type=1&sc_sort=bd_insert_date&sc_ord=desc` +
      `&sc_day_start=${encodeURIComponent(safeDay)}` +
      `&sc_day_end=${encodeURIComponent(safeDay)}` +
      '&sc_my_insert=Y&sc_my_appr=Y&sc_appr_type1=&sc_appr_type2=&sc_appr_type3=&sc_sf_name=';

    const diaryResponse = $http.send({
      url: diaryListUrl,
      method: 'GET',
      timeout: 20,
      headers: buildBrowserLikeHeaders(session.host, session.cookieHeader, diaryListUrl),
    });

    session.cookieHeader = mergeSetCookieIntoCookieHeader(session.cookieHeader, diaryResponse.headers);

    const diaryHtml = toString(diaryResponse.body);
    const diaryAuthRequired = detectAuthRequiredHtml(diaryHtml);
    const isDiaryAccessible = diaryResponse.statusCode >= 200 && diaryResponse.statusCode < 300 && !diaryAuthRequired;
    const parsed = isDiaryAccessible ? parseTeamLeadRowsFromDiaryHtml(diaryHtml, session.host) : { rows: [] };

    info('kjca/probe:diary-list', {
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
   * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
   * @param {types.KjcaProbePayload | null | undefined} payload 조회할 일자를 담은 입력값입니다.
   * @param {types.KjcaSession | null | undefined} [session] 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
   * @returns {types.KjcaProbeResult} 접근 가능 여부와 팀장 목록을 담은 결과입니다.
   */
  function probeStaffAuth(request, payload, session = null) {
    const safeSession = session || createKjcaSession(request);
    const scDay = normalizeReportDate(payload && (payload.scDay || payload.reportDate));

    dbg('kjca/probe:start', {
      scDay,
    });

    const result = fetchDiaryList(safeSession, scDay);

    dbg('kjca/probe:response', {
      scDay,
      isDiaryAccessible: result.isDiaryAccessible,
      teamLeadCount: result.teamLeadRows.length,
    });

    return result;
  }

  return {
    normalizeSuperuserLoginId,
    readAuthState,
    ensureSuperuserRequest,
    createKjcaSession,
    probeStaffAuth,
  };
}

module.exports = createKjcaAuth;
