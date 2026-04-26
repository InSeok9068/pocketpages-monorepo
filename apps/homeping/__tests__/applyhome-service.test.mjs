import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))
const servicePath = path.resolve(testDir, '../pb_hooks/pages/_private/applyhome-service.js')
const pocketpagesModulePath = require.resolve('pocketpages')

function installFixedDate(isoDate) {
  const OriginalDate = globalThis.Date
  const fixedTime = new OriginalDate(isoDate + 'T09:00:00Z').getTime()

  class FixedDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedTime)
        return
      }

      super(...args)
    }

    static now() {
      return fixedTime
    }
  }

  FixedDate.UTC = OriginalDate.UTC
  FixedDate.parse = OriginalDate.parse
  globalThis.Date = FixedDate

  return function restoreDate() {
    globalThis.Date = OriginalDate
  }
}

function createApplyhomeRow(input) {
  return {
    RCRIT_PBLANC_DE: input.recruitDate,
    RCEPT_BGNDE: input.applyStartDate,
    RCEPT_ENDDE: input.applyEndDate,
    PRZWNER_PRESNATN_DE: input.winnerDate || '',
    HOUSE_MANAGE_NO: input.houseManageNo || input.name,
    PBLANC_NO: input.pblancNo || input.name,
    HOUSE_DTL_SECD_NM: input.detailName || '민영',
    HOUSE_SECD_NM: input.houseSectionName || 'APT',
    HOUSE_NM: input.name,
    HSSPLY_ADRES: input.address,
    SUBSCRPT_AREA_CODE_NM: '경기',
    BSNS_MBY_NM: '사업주체',
    MDHS_TELNO: '',
    PBLANC_URL: input.url || 'https://applyhome.test/' + encodeURIComponent(input.name),
    MVN_PREARNGE_YM: '',
    TOT_SUPLY_HSHLDCO: input.householdCount || 12,
  }
}

function createLhRow(input) {
  return {
    PAN_ID: input.id || input.name,
    SPL_INF_TP_CD: input.splInfTpCd || '050',
    CCR_CNNT_SYS_DS_CD: input.ccrCnntSysDsCd || '02',
    UPP_AIS_TP_CD: input.uppAisTpCd || '05',
    AIS_TP_CD: input.aisTpCd || '05',
    PAN_DT: input.recruitDate,
    PAN_NT_ST_DT: input.noticeStartDate,
    CLSG_DT: input.closeDate,
    PAN_SS: input.statusLabel || '접수마감',
    PAN_NM: input.name,
    CNP_CD_NM: '경기도',
    AIS_TP_CD_NM: '분양주택',
    DTL_URL: input.url || 'https://lh.test/' + encodeURIComponent(input.name),
  }
}

function createStore() {
  const map = new Map()

  return {
    map,
    fn(key, value) {
      if (arguments.length === 1) {
        return map.get(key)
      }

      map.set(key, value)
      return undefined
    },
  }
}

function createHarness(options = {}) {
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalServiceCache = require.cache[servicePath]
  const originalHttp = globalThis.$http
  const restoreDate = installFixedDate(options.today || '2026-04-26')
  const storeMock = createStore()
  const logs = []
  const requests = []

  require.cache[pocketpagesModulePath] = {
    id: pocketpagesModulePath,
    filename: pocketpagesModulePath,
    loaded: true,
    exports: {
      globalApi: {
        dbg() {},
        info(name, data) {
          logs.push({ name, data })
        },
        store: storeMock.fn,
      },
    },
  }

  delete require.cache[servicePath]

  globalThis.$http = {
    send(config) {
      const requestUrl = new URL(config.url)
      requests.push(requestUrl)

      if (requestUrl.hostname === 'api.odcloud.kr') {
        const pathName = requestUrl.pathname
        const data = options.applyhome && options.applyhome[pathName] ? options.applyhome[pathName] : []

        return {
          statusCode: 200,
          json: {
            data: data,
          },
        }
      }

      if (requestUrl.hostname === 'apis.data.go.kr') {
        if (requestUrl.pathname.indexOf('/lhLeaseNoticeDtlInfo1/') !== -1) {
          return {
            statusCode: 200,
            json: options.lhDetailPayload || [],
          }
        }

        return {
          statusCode: 200,
          json: [
            {
              dsList: options.lhRows || [],
            },
          ],
        }
      }

      throw new Error('Unexpected request URL: ' + config.url)
    },
  }

  const service = require(servicePath)

  return {
    service,
    requests,
    logs,
    storeMap: storeMock.map,
    cleanup() {
      restoreDate()
      globalThis.$http = originalHttp

      if (originalPocketpagesCache) {
        require.cache[pocketpagesModulePath] = originalPocketpagesCache
      } else {
        delete require.cache[pocketpagesModulePath]
      }

      if (originalServiceCache) {
        require.cache[servicePath] = originalServiceCache
      } else {
        delete require.cache[servicePath]
      }
    },
  }
}

function countRequests(requests, host) {
  return requests.filter((requestUrl) => requestUrl.hostname === host).length
}

test('searchRegionNotices filters closed notices by default and includes only recent closed notices when requested', () => {
  const harness = createHarness({
    applyhome: {
      '/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail': [
        createApplyhomeRow({
          name: '안양 접수중 아파트',
          address: '경기도 안양시 동안구',
          recruitDate: '2026-04-20',
          applyStartDate: '2026-04-20',
          applyEndDate: '2026-05-03',
        }),
        createApplyhomeRow({
          name: '안양 최근 마감 아파트',
          address: '경기도 안양시 만안구',
          recruitDate: '2026-02-10',
          applyStartDate: '2026-02-11',
          applyEndDate: '2026-02-15',
        }),
        createApplyhomeRow({
          name: '안양 오래된 마감 아파트',
          address: '경기도 안양시 만안구',
          recruitDate: '2025-09-30',
          applyStartDate: '2025-10-01',
          applyEndDate: '2025-10-05',
        }),
        createApplyhomeRow({
          name: '수원 최근 마감 아파트',
          address: '경기도 수원시',
          recruitDate: '2026-02-10',
          applyStartDate: '2026-02-11',
          applyEndDate: '2026-02-15',
        }),
      ],
    },
  })

  try {
    const openOnly = harness.service.searchRegionNotices(
      {
        apiKey: 'test-key',
        perPage: 50,
      },
      {
        regionSlug: 'anyang',
      }
    )

    assert.deepEqual(
      openOnly.notices.map((notice) => notice.name),
      ['안양 접수중 아파트']
    )

    const includeClosed = harness.service.searchRegionNotices(
      {
        apiKey: 'test-key',
        perPage: 50,
      },
      {
        regionSlug: 'anyang',
        includeClosed: true,
      }
    )

    assert.deepEqual(
      includeClosed.notices.map((notice) => notice.name).sort(),
      ['안양 최근 마감 아파트', '안양 접수중 아파트'].sort()
    )
  } finally {
    harness.cleanup()
  }
})

test('searchRegionNotices caches API responses for the current day', () => {
  const harness = createHarness({
    applyhome: {
      '/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail': [
        createApplyhomeRow({
          name: '안양 최근 마감 아파트',
          address: '경기도 안양시 만안구',
          recruitDate: '2026-04-01',
          applyStartDate: '2026-04-02',
          applyEndDate: '2026-04-03',
        }),
      ],
    },
    lhRows: [
      createLhRow({
        id: 'lh-anyang-1',
        name: '안양 LH 일반공급',
        recruitDate: '2026-03-20',
        noticeStartDate: '2026-03-20',
        closeDate: '2026-03-25',
        statusLabel: '접수마감',
      }),
    ],
  })

  try {
    const firstResult = harness.service.searchRegionNotices(
      {
        apiKey: 'test-key',
        perPage: 50,
      },
      {
        regionSlug: 'anyang',
        includeClosed: true,
      }
    )
    const requestCountAfterFirstCall = harness.requests.length

    const secondResult = harness.service.searchRegionNotices(
      {
        apiKey: 'test-key',
        perPage: 50,
      },
      {
        regionSlug: 'anyang',
        includeClosed: true,
      }
    )

    assert.equal(firstResult.notices.length, 2)
    assert.equal(secondResult.notices.length, 2)
    assert.equal(requestCountAfterFirstCall, 6)
    assert.equal(harness.requests.length, requestCountAfterFirstCall)
    assert.equal(harness.logs.filter((entry) => entry.name === 'homeping/cache:hit').length, 6)
    assert.equal(countRequests(harness.requests, 'api.odcloud.kr'), 5)
    assert.equal(countRequests(harness.requests, 'apis.data.go.kr'), 1)
  } finally {
    harness.cleanup()
  }
})

test('searchRegionNotices keeps LH detail lookup keys on LH notices', () => {
  const harness = createHarness({
    lhRows: [
      createLhRow({
        id: '0000061077',
        name: '안양 LH 일반공급',
        recruitDate: '2026-04-20',
        noticeStartDate: '2026-04-20',
        closeDate: '2026-05-03',
        statusLabel: '접수중',
        splInfTpCd: '050',
        ccrCnntSysDsCd: '02',
        uppAisTpCd: '05',
        aisTpCd: '05',
      }),
    ],
  })

  try {
    const result = harness.service.searchRegionNotices(
      {
        apiKey: 'test-key',
        perPage: 50,
      },
      {
        regionSlug: 'anyang',
      }
    )
    const lhNotice = result.notices.find((notice) => notice.sourceLabel === 'LH')

    assert.equal(lhNotice.lhDetailParams.panId, '0000061077')
    assert.equal(lhNotice.lhDetailParams.splInfTpCd, '050')
    assert.equal(lhNotice.lhDetailParams.ccrCnntSysDsCd, '02')
    assert.equal(lhNotice.lhDetailParams.uppAisTpCd, '05')
    assert.equal(lhNotice.lhDetailParams.aisTpCd, '05')
  } finally {
    harness.cleanup()
  }
})

test('getLhNoticeDetail normalizes schedule, complex, office, and file metadata', () => {
  const harness = createHarness({
    lhDetailPayload: [
      {
        dsSplScdl: [
          {
            RMK: '인터넷접수',
            HS_SBSC_ACP_TRG_CD_NM: '무순위',
            ACP_DTTM: '2026.05.06 10:00 ~ 2026.05.08 17:00',
            PZWR_ANC_DT: '20260513',
            PZWR_PPR_SBM_ST_DT: '20260518',
            PZWR_PPR_SBM_ED_DT: '20260520',
            CTRT_ST_DT: '20260617',
            CTRT_ED_DT: '20260619',
          },
        ],
        dsSbd: [
          {
            BZDT_NM: '안양 테스트 단지',
            LCT_ARA_ADR: '경기도 안양시',
            LCT_ARA_DTL_ADR: '동안구',
            MIN_MAX_RSDN_DDO_AR: '59.14 ~ 59.98',
            SUM_TOT_HSH_CNT: '538',
            MVIN_XPC_YM: '2028년 06월',
            HTN_FMLA_DS_CD_NM: '지역난방',
          },
        ],
        dsCtrtPlc: [
          {
            SIL_OFC_DT: '2026.05.01~2026.05.03',
            CTRT_PLC_ADR: '경기도 안양시',
            CTRT_PLC_DTL_ADR: '홍보관',
            SIL_OFC_TLNO: '031-000-0000',
          },
        ],
        dsAhflInfo: [
          {
            SL_PAN_AHFL_DS_CD_NM: '공고문(PDF)',
            CMN_AHFL_NM: '테스트공고.pdf',
            AHFL_URL: 'https://apply.lh.or.kr/file.pdf',
          },
        ],
        dsEtcInfo: [
          {
            PAN_DTL_CTS: '공고 상세 내용입니다.',
          },
        ],
      },
    ],
  })

  try {
    const detail = harness.service.getLhNoticeDetail(
      {
        apiKey: 'test-key',
      },
      {
        panId: '0000061077',
        splInfTpCd: '050',
        ccrCnntSysDsCd: '02',
        uppAisTpCd: '05',
        aisTpCd: '05',
      }
    )
    const request = harness.requests[0]

    assert.equal(request.pathname, '/B552555/lhLeaseNoticeDtlInfo1/getLeaseNoticeDtlInfo1')
    assert.equal(request.searchParams.get('PAN_ID'), '0000061077')
    assert.equal(request.searchParams.get('SPL_INF_TP_CD'), '050')
    assert.equal(request.searchParams.get('CCR_CNNT_SYS_DS_CD'), '02')
    assert.equal(request.searchParams.get('UPP_AIS_TP_CD'), '05')
    assert.equal(request.searchParams.get('AIS_TP_CD'), '05')
    assert.equal(detail.sections[0].title, '공급 일정')
    assert.equal(detail.sections[0].items.some((item) => item.label === '당첨자 발표' && item.value === '2026-05-13'), true)
    assert.equal(detail.sections[1].items.some((item) => item.label === '단지명' && item.value === '안양 테스트 단지'), true)
    assert.equal(detail.files[0].value, '테스트공고.pdf')
    assert.equal(detail.files[0].url, 'https://apply.lh.or.kr/file.pdf')
    assert.equal(detail.content, '공고 상세 내용입니다.')
  } finally {
    harness.cleanup()
  }
})

test('searchRegionNotices purges prior daily cache entries when the date changes', () => {
  const harness = createHarness({
    today: '2026-04-21',
    applyhome: {
      '/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail': [
        createApplyhomeRow({
          name: '안양 접수중 아파트',
          address: '경기도 안양시 동안구',
          recruitDate: '2026-04-20',
          applyStartDate: '2026-04-20',
          applyEndDate: '2026-05-03',
        }),
      ],
    },
  })

  try {
    const oldCacheKey = 'homeping:notices:api-cache:v1:2026-04-20:applyhome:old'
    harness.storeMap.set(oldCacheKey, {
      date: '2026-04-20',
      data: {
        data: [],
      },
    })
    harness.storeMap.set('homeping:notices:api-cache-index:v1', {
      date: '2026-04-20',
      keys: [oldCacheKey],
    })

    harness.service.searchRegionNotices(
      {
        apiKey: 'test-key',
        perPage: 50,
      },
      {
        regionSlug: 'anyang',
      }
    )

    assert.equal(harness.storeMap.get(oldCacheKey), null)
    assert.equal(harness.storeMap.get('homeping:notices:api-cache-index:v1').date, '2026-04-21')
    assert.equal(harness.logs.some((entry) => entry.name === 'homeping/cache:purge-daily'), true)
  } finally {
    harness.cleanup()
  }
})
