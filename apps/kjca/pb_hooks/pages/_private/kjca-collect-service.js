const {
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
  parseDateText,
  formatDateText,
} = require('./kjca-core');
const kjcaAuth = require('./kjca-auth');
const kjcaAnalyzeService = require('./kjca-analyze-service');
const { ensureSuperuserRequest, createKjcaSession, probeStaffAuth } = kjcaAuth;
const { analyzeStaffDiary } = kjcaAnalyzeService;

  function shouldRetryAnalyzeError(errorText) {
    const text = String(errorText || '').toLowerCase();
    if (!text) return false;
    return text.includes('http 503') || text.includes('http 429') || text.includes('timeout') || text.includes('temporarily unavailable') || text.includes('connection reset');
  }

  function findWeekTextPlan(weekStartDate, dept) {
    const weekDate = buildDateMatchParams(weekStartDate);
    try {
      return $app.findFirstRecordByFilter('recruiting_week_text_plans', '(weekStartDate = {:exact} || weekStartDate ~ {:like}) && dept = {:dept}', {
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
      return $app.findRecordsByFilter('recruiting_week_text_rows', 'planId = {:planId}', 'weekday,sortOrder,created', 1000, 0, { planId });
    } catch (error) {
      return [];
    }
  }

  function isUniqueValueError(error) {
    return String(error || '').includes('Value must be unique');
  }

  function upsertWeekTextPlan(recruitingWeekTextPlanRole, recruitingWeekTextRowRole, params) {
    const safeWeekStartDate = deps.formatDateText(deps.parseDateText(params.weekStartDate));
    const dept = String(params.dept || '').trim();
    if (!dept) return { ok: false, reason: 'dept-empty' };

    const planCollection = $app.findCollectionByNameOrId('recruiting_week_text_plans');
    const rowCollection = $app.findCollectionByNameOrId('recruiting_week_text_rows');

    let plan = findWeekTextPlan(safeWeekStartDate, dept);
    const wasNew = !plan;
    if (!plan) plan = new Record(planCollection);

    plan.set('weekStartDate', safeWeekStartDate);
    plan.set('dept', dept);
    plan.set('status', 'confirmed');

    if (recruitingWeekTextPlanRole && typeof recruitingWeekTextPlanRole.canSaveConfirmed === 'function') {
      if (!recruitingWeekTextPlanRole.canSaveConfirmed(plan)) {
        return { ok: false, reason: 'plan-invalid' };
      }
    }

    try {
      $app.save(plan);
    } catch (error) {
      if (!wasNew || !isUniqueValueError(error)) throw error;
      const existing = findWeekTextPlan(safeWeekStartDate, dept);
      if (!existing) throw error;
      existing.set('weekStartDate', safeWeekStartDate);
      existing.set('dept', dept);
      existing.set('status', 'confirmed');
      $app.save(existing);
      plan = existing;
    }

    const nextRows = ensureWeekdayRows(params.rows);
    findWeekTextRows(plan.id).forEach((row) => {
      $app.delete(row);
    });

    nextRows.forEach((row) => {
      const record = new Record(rowCollection);
      record.set('planId', plan.id);
      record.set('weekday', row.weekday);
      record.set('channelName', row.channelName);
      record.set('weeklyPlan', row.weeklyPlan);
      record.set('promotionContent', row.promotionContent);
      record.set('targetText', row.targetText);
      record.set('resultText', row.resultText);
      record.set('recruitCountText', row.recruitCountText);
      record.set('ownerName', row.ownerName);
      record.set('note', row.note);
      record.set('sortOrder', row.sortOrder);

      if (recruitingWeekTextRowRole && typeof recruitingWeekTextRowRole.canSave === 'function') {
        if (!recruitingWeekTextRowRole.canSave(record)) return;
      }

      $app.save(record);
    });

    return { ok: true, planId: plan.id };
  }

  function upsertWeekTextRowsForWeekday(recruitingWeekTextPlanRole, recruitingWeekTextRowRole, params) {
    const safeWeekStartDate = deps.formatDateText(deps.parseDateText(params.weekStartDate));
    const dept = String(params.dept || '').trim();
    const weekday = normalizeWeekday(params.weekday);
    if (!dept) return { ok: false, reason: 'dept-empty' };
    if (!weekday) return { ok: false, reason: 'weekday-empty' };

    let plan = findWeekTextPlan(safeWeekStartDate, dept);
    if (!plan) {
      const created = upsertWeekTextPlan(recruitingWeekTextPlanRole, recruitingWeekTextRowRole, {
        weekStartDate: safeWeekStartDate,
        dept,
        rows: [],
      });
      if (!created.ok) return created;
      plan = findWeekTextPlan(safeWeekStartDate, dept);
    }
    if (!plan) return { ok: false, reason: 'plan-create-failed' };

    const rowCollection = $app.findCollectionByNameOrId('recruiting_week_text_rows');
    findWeekTextRows(plan.id)
      .filter((row) => normalizeWeekday(row.get('weekday')) === weekday)
      .forEach((row) => {
        $app.delete(row);
      });

    const weekdayRows = normalizeWeekTextRows(params.rows).filter((row) => row.weekday === weekday);
    if (weekdayRows.length === 0) return { ok: true, reason: 'weekday-empty-rows' };

    weekdayRows.forEach((row, index) => {
      const record = new Record(rowCollection);
      record.set('planId', plan.id);
      record.set('weekday', row.weekday);
      record.set('channelName', row.channelName);
      record.set('weeklyPlan', row.weeklyPlan);
      record.set('promotionContent', row.promotionContent);
      record.set('targetText', row.targetText);
      record.set('resultText', row.resultText);
      record.set('recruitCountText', row.recruitCountText);
      record.set('ownerName', row.ownerName);
      record.set('note', row.note);
      record.set('sortOrder', index);

      if (recruitingWeekTextRowRole && typeof recruitingWeekTextRowRole.canSave === 'function') {
        if (!recruitingWeekTextRowRole.canSave(record)) return;
      }

      $app.save(record);
    });

    return { ok: true };
  }

  function findWeekPlan(weekStartDate, dept) {
    const weekDate = buildDateMatchParams(weekStartDate);
    try {
      return $app.findFirstRecordByFilter('recruiting_week_plans', '(weekStartDate = {:exact} || weekStartDate ~ {:like}) && dept = {:dept}', { exact: weekDate.exact, like: weekDate.like, dept });
    } catch (error) {
      return null;
    }
  }

  function findWeekPlanItems(planId) {
    try {
      return $app.findRecordsByFilter('recruiting_week_plan_items', 'planId = {:planId}', 'weekday,sortOrder,created', 500, 0, { planId });
    } catch (error) {
      return [];
    }
  }

  function findWeekResults(weekStartDate, dept) {
    const weekDate = buildDateMatchParams(weekStartDate);
    try {
      return $app.findRecordsByFilter('recruiting_daily_results', '(weekStartDate = {:exact} || weekStartDate ~ {:like}) && dept = {:dept}', 'reportDate', 500, 0, {
        exact: weekDate.exact,
        like: weekDate.like,
        dept,
      });
    } catch (error) {
      return [];
    }
  }

  function upsertRecruitingWeekPlan(recruitingWeekPlanRole, recruitingWeekPlanItemRole, params) {
    const dept = String((params && params.dept) || '').trim();
    if (!dept) return { ok: false, reason: 'dept-empty' };

    const safeWeekStartDate = deps.formatDateText(deps.parseDateText(params.weekStartDate));
    const planCollection = $app.findCollectionByNameOrId('recruiting_week_plans');
    const itemCollection = $app.findCollectionByNameOrId('recruiting_week_plan_items');

    let plan = findWeekPlan(safeWeekStartDate, dept);
    const wasNew = !plan;
    if (!plan) plan = new Record(planCollection);

    plan.set('weekStartDate', safeWeekStartDate);
    plan.set('dept', dept);
    plan.set('monthTarget', params.monthTarget);
    plan.set('weekTarget', params.weekTarget);
    plan.set('status', 'confirmed');

    if (recruitingWeekPlanRole && typeof recruitingWeekPlanRole.canSaveConfirmed === 'function') {
      if (!recruitingWeekPlanRole.canSaveConfirmed(plan)) {
        return { ok: false, reason: 'plan-invalid' };
      }
    }

    try {
      $app.save(plan);
    } catch (error) {
      if (!wasNew || !isUniqueValueError(error)) throw error;

      const existing = findWeekPlan(safeWeekStartDate, dept);
      if (!existing) throw error;

      existing.set('weekStartDate', safeWeekStartDate);
      existing.set('dept', dept);
      existing.set('monthTarget', params.monthTarget);
      existing.set('weekTarget', params.weekTarget);
      existing.set('status', 'confirmed');
      $app.save(existing);
      plan = existing;
    }

    findWeekPlanItems(plan.id).forEach((item) => {
      $app.delete(item);
    });

    const normalizedItems = (Array.isArray(params.items) ? params.items : [])
      .map((item, index) => ({
        weekday: normalizeWeekday(item.weekday),
        channelName: String(item.channelName || '').trim(),
        promotionContent: String(item.promotionContent || '').trim(),
        targetCount: normalizeNullableInt(item.targetCount),
        ownerName: String(item.ownerName || '').trim(),
        note: String(item.note || '').trim(),
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
          channelName: '',
          promotionContent: '',
          targetCount: base + add,
          ownerName: '',
          note: '주목표 자동분배',
          sortOrder: index,
        };
      });
    }

    nextItems.forEach((item) => {
      const record = new Record(itemCollection);
      record.set('planId', plan.id);
      record.set('weekday', item.weekday);
      record.set('channelName', item.channelName);
      record.set('promotionContent', item.promotionContent);
      record.set('targetCount', item.targetCount);
      record.set('ownerName', item.ownerName);
      record.set('note', item.note);
      record.set('sortOrder', item.sortOrder);

      if (recruitingWeekPlanItemRole && typeof recruitingWeekPlanItemRole.canSave === 'function') {
        if (!recruitingWeekPlanItemRole.canSave(record)) return;
      }

      $app.save(record);
    });

    return { ok: true };
  }

  function upsertRecruitingDailyResult(recruitingDailyResultRole, params) {
    const dept = String((params && params.dept) || '').trim();
    if (!dept) return { ok: false, reason: 'dept-empty' };

    const safeReportDate = deps.formatDateText(deps.parseDateText(params.reportDate));
    const safeWeekStartDate = deps.formatDateText(deps.parseDateText(params.weekStartDate));
    const safeWeekday = normalizeWeekday(params.weekday) || toWeekdayKey(safeReportDate);
    const safeActualCount = normalizeNullableInt(params.actualCount);
    if (safeActualCount === null) return { ok: false, reason: 'actualCount-invalid' };

    const collection = $app.findCollectionByNameOrId('recruiting_daily_results');
    const reportDate = buildDateMatchParams(safeReportDate);

    let record = null;
    try {
      record = $app.findFirstRecordByFilter('recruiting_daily_results', '(reportDate = {:exact} || reportDate ~ {:like}) && dept = {:dept}', { exact: reportDate.exact, like: reportDate.like, dept });
    } catch (error) {
      record = null;
    }

    const target = record || new Record(collection);
    target.set('reportDate', safeReportDate);
    target.set('weekStartDate', safeWeekStartDate);
    target.set('dept', dept);
    target.set('weekday', safeWeekday);
    target.set('actualCount', safeActualCount);
    target.set('sourceType', 'ai');
    target.set('memo', 'AI 자동 추출');

    if (recruitingDailyResultRole && typeof recruitingDailyResultRole.canSaveAiResult === 'function') {
      if (!recruitingDailyResultRole.canSaveAiResult(target)) {
        return { ok: false, reason: 'daily-result-invalid' };
      }
    }

    try {
      $app.save(target);
    } catch (error) {
      if (!!record || !isUniqueValueError(error)) throw error;

      const existing = $app.findFirstRecordByFilter('recruiting_daily_results', '(reportDate = {:exact} || reportDate ~ {:like}) && dept = {:dept}', {
        exact: reportDate.exact,
        like: reportDate.like,
        dept,
      });

      existing.set('reportDate', safeReportDate);
      existing.set('weekStartDate', safeWeekStartDate);
      existing.set('dept', dept);
      existing.set('weekday', safeWeekday);
      existing.set('actualCount', safeActualCount);
      existing.set('sourceType', 'ai');
      existing.set('memo', 'AI 자동 추출');
      $app.save(existing);
    }

    return { ok: true };
  }

  /**
   * 특정 부서와 날짜의 분석 캐시를 삭제합니다.
   * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
   * @param {types.KjcaCacheClearPayload | null | undefined} payload 삭제 대상 날짜와 부서입니다.
   * @returns {types.KjcaCacheClearResult} 삭제 결과와 건수입니다.
   */
  function clearAnalysisCache(request, payload) {
    ensureSuperuserRequest(request);

    const reportDate = normalizeReportDate(payload && payload.reportDate);
    const dept = String((payload && payload.dept) || '').trim();
    if (!dept) throw new Error('부서(dept)가 필요합니다.');

    const filter = `(reportDate = '${escapeFilterValue(reportDate)}' || reportDate ~ '${escapeFilterValue(`${reportDate}%`)}')` + ` && dept = '${escapeFilterValue(dept)}'`;

    let rows = [];
    try {
      rows = $app.findRecordsByFilter(CACHE_COLLECTION_NAME, filter, 'created', 1000, 0);
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
   * 지정한 날짜 기준으로 팀장 일지를 수집하고 주간 집계 결과를 만듭니다.
   * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
   * @param {types.KjcaCollectRoles | null | undefined} roles 저장 전에 적용할 role 묶음입니다.
   * @param {types.KjcaCollectPayload | null | undefined} payload 수집 날짜와 옵션 입력값입니다.
   * @returns {types.KjcaCollectResult} 화면 렌더링에 쓰는 주간 집계 결과입니다.
   */
  function collectWeekly(request, roles, payload) {
    ensureSuperuserRequest(request);
    const safeRoles = roles && typeof roles === 'object' ? roles : {};
    const staffDiaryAnalysisCacheRole = safeRoles.staffDiaryAnalysisCacheRole || null;
    const recruitingWeekPlanRole = safeRoles.recruitingWeekPlanRole || null;
    const recruitingWeekPlanItemRole = safeRoles.recruitingWeekPlanItemRole || null;
    const recruitingDailyResultRole = safeRoles.recruitingDailyResultRole || null;
    const recruitingWeekTextPlanRole = safeRoles.recruitingWeekTextPlanRole || null;
    const recruitingWeekTextRowRole = safeRoles.recruitingWeekTextRowRole || null;

    const reportDate = normalizeReportDate(payload && payload.reportDate);
    const weekStartDate = buildWeekStartDate(reportDate);
    const reportWeekday = toWeekdayKey(reportDate);
    const testOneOnly = normalizeBool(payload && payload.testOneOnly);
    const warnings = [];

    const session = createKjcaSession(request);

    const todayProbe = probeStaffAuth(request, { scDay: reportDate }, session);
    const teamLeadRows = normalizeTeamLeadRows(todayProbe.teamLeadRows);
    const todayTargets = buildUniqueTargets(teamLeadRows);
    const collectTargets = testOneOnly ? todayTargets.slice(0, 1) : todayTargets;

    if (!collectTargets.length) {
      throw new Error('해당 일자 팀장 일지를 찾지 못했습니다.');
    }

    const missingPlanDepts = collectTargets.map((target) => target.dept).filter((dept) => !findWeekPlan(weekStartDate, dept));

    if (missingPlanDepts.length > 0) {
      let mondayTargetsSource = todayTargets;

      if (reportDate !== weekStartDate) {
        const mondayProbe = probeStaffAuth(request, { scDay: weekStartDate }, session);
        mondayTargetsSource = buildUniqueTargets(normalizeTeamLeadRows(mondayProbe.teamLeadRows));
      }

      const mondayTargetMap = new Map(mondayTargetsSource.map((target) => [target.dept, target]));
      const bootstrapTargets = missingPlanDepts.map((dept) => mondayTargetMap.get(dept)).filter((target) => !!target);

      if (bootstrapTargets.length > 0) {
        const mondayAnalyze = analyzeStaffDiary(
          request,
          staffDiaryAnalysisCacheRole,
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
              const result = upsertRecruitingWeekPlan(recruitingWeekPlanRole, recruitingWeekPlanItemRole, {
                weekStartDate,
                dept: String(item.dept || '').trim(),
                monthTarget: recruiting.monthTarget,
                weekTarget: recruiting.weekTarget,
                items: recruiting.dailyPlan,
              });
              if (!result.ok) warnings.push(`weekPlan skip: ${String(item.dept || '-')} (${result.reason || 'unknown'})`);
            } catch (error) {
              warnings.push(`weekPlan error: ${String(item.dept || '-')} (${String(error)})`);
            }

            try {
              const textPlanResult = upsertWeekTextPlan(recruitingWeekTextPlanRole, recruitingWeekTextRowRole, {
                weekStartDate,
                dept: String(item.dept || '').trim(),
                rows: ensureWeekdayRows(recruiting.weekTableRows),
              });
              if (!textPlanResult.ok) warnings.push(`weekTextPlan skip: ${String(item.dept || '-')} (${textPlanResult.reason || 'unknown'})`);
            } catch (error) {
              warnings.push(`weekTextPlan error: ${String(item.dept || '-')} (${String(error)})`);
            }
          });
      }
    }

    const todayAnalyze = analyzeStaffDiary(
      request,
      staffDiaryAnalysisCacheRole,
      {
        reportDate,
        targets: collectTargets,
      },
      session,
    );

    let finalAlertMessage = String(todayAnalyze.alertMessage || '').trim();
    let finalStoppedReason = String(todayAnalyze.stoppedReason || '').trim();
    let analysisResults = normalizeAnalyzeResults(todayAnalyze.results);

    const targetKeyMap = new Map();
    collectTargets.forEach((target) => {
      const dept = String((target && target.dept) || '').trim();
      const printUrl = String((target && target.printUrl) || '').trim();
      if (!dept || !printUrl) return;
      targetKeyMap.set(`${dept}||${printUrl}`, {
        dept,
        position: String(target.position || '').trim(),
        staffName: String(target.staffName || '').trim(),
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
          request,
          staffDiaryAnalysisCacheRole,
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
        if (!finalAlertMessage) finalAlertMessage = String(retryAnalyze.alertMessage || '').trim();
        if (!finalStoppedReason) finalStoppedReason = String(retryAnalyze.stoppedReason || '').trim();
      } catch (error) {
        warnings.push(`AI 재시도 호출 실패: ${String(error)}`);
      }
    }

    analysisResults
      .filter((item) => item.ok)
      .forEach((item) => {
        const safeDept = String(item.dept || '').trim();
        if (!safeDept) {
          warnings.push('dailyResult skip: dept-empty');
          return;
        }

        const allWeekTextRows = normalizeWeekTextRows(item.recruiting.weekTableRows);
        const canReplaceWeekTable = hasWeekTextContent(allWeekTextRows) && getDistinctWeekdayCount(allWeekTextRows) >= WEEKDAY_ORDER.length;

        if (canReplaceWeekTable) {
          try {
            const textPlanResult = upsertWeekTextPlan(recruitingWeekTextPlanRole, recruitingWeekTextRowRole, {
              weekStartDate,
              dept: safeDept,
              rows: allWeekTextRows,
            });
            if (!textPlanResult.ok) warnings.push(`weekTextPlan skip: ${safeDept} (${textPlanResult.reason || 'unknown'})`);
          } catch (error) {
            warnings.push(`weekTextPlan error: ${safeDept} (${String(error)})`);
          }
        } else {
          const todayTextRows = allWeekTextRows.filter((row) => row.weekday === reportWeekday);
          if (todayTextRows.length > 0) {
            try {
              const textUpdateResult = upsertWeekTextRowsForWeekday(recruitingWeekTextPlanRole, recruitingWeekTextRowRole, {
                weekStartDate,
                dept: safeDept,
                weekday: reportWeekday,
                rows: todayTextRows,
              });
              if (!textUpdateResult.ok) warnings.push(`weekTextDaily skip: ${safeDept} (${textUpdateResult.reason || 'unknown'})`);
            } catch (error) {
              warnings.push(`weekTextDaily error: ${safeDept} (${String(error)})`);
            }
          }
        }

        const safeActual = normalizeNullableInt(item.recruiting.dailyActualCount);
        if (safeActual === null) {
          warnings.push(`dailyResult skip: ${item.dept || '-'} (actualCount-empty)`);
          return;
        }

        try {
          const result = upsertRecruitingDailyResult(recruitingDailyResultRole, {
            reportDate,
            weekStartDate,
            dept: safeDept,
            weekday: reportWeekday,
            actualCount: normalizeRequiredInt(safeActual, 0),
          });
          if (!result.ok) warnings.push(`dailyResult skip: ${safeDept} (${result.reason || 'unknown'})`);
        } catch (error) {
          warnings.push(`dailyResult error: ${safeDept} (${String(error)})`);
        }
      });

    const deptWeekTables = collectTargets
      .map((target) => {
        const plan = findWeekTextPlan(weekStartDate, target.dept);
        const planRows = plan
          ? findWeekTextRows(plan.id).map((row) => ({
              weekday: normalizeWeekday(row.get('weekday')) || 'mon',
              channelName: String(row.get('channelName') || '').trim(),
              weeklyPlan: String(row.get('weeklyPlan') || '').trim(),
              promotionContent: String(row.get('promotionContent') || '').trim(),
              targetText: String(row.get('targetText') || '').trim(),
              resultText: String(row.get('resultText') || '').trim(),
              recruitCountText: String(row.get('recruitCountText') || '').trim(),
              ownerName: String(row.get('ownerName') || '').trim(),
              note: String(row.get('note') || '').trim(),
              sortOrder: Math.trunc(Number(row.get('sortOrder') || 0)),
            }))
          : [];
        return {
          dept: target.dept,
          todayWeekday: reportWeekday,
          rows: ensureWeekdayRows(planRows),
        };
      })
      .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'));

    const deptSnapshots = collectTargets
      .map((target) => {
        const plan = findWeekPlan(weekStartDate, target.dept);
        const planItems = plan ? findWeekPlanItems(plan.id) : [];
        const weekResults = findWeekResults(weekStartDate, target.dept);
        const rows = buildSnapshotRows(
          planItems.map((item) => ({
            weekday: item.get('weekday'),
            targetCount: item.get('targetCount'),
          })),
          weekResults.map((item) => ({
            weekday: item.get('weekday'),
            actualCount: item.get('actualCount'),
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
          monthTarget: plan ? normalizeNullableInt(plan.get('monthTarget')) : null,
          weekTarget: plan ? normalizeNullableInt(plan.get('weekTarget')) : null,
          rows,
          today,
          cumulative,
        };
      })
      .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'));

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

module.exports = {
  collectWeekly,
  clearAnalysisCache,
};
