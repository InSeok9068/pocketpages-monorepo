const STEMS = {
  갑: { element: '목', yinYang: '양' },
  을: { element: '목', yinYang: '음' },
  병: { element: '화', yinYang: '양' },
  정: { element: '화', yinYang: '음' },
  무: { element: '토', yinYang: '양' },
  기: { element: '토', yinYang: '음' },
  경: { element: '금', yinYang: '양' },
  신: { element: '금', yinYang: '음' },
  임: { element: '수', yinYang: '양' },
  계: { element: '수', yinYang: '음' },
}

const BRANCH_ELEMENTS = {
  인: '목',
  묘: '목',
  사: '화',
  오: '화',
  진: '토',
  술: '토',
  축: '토',
  미: '토',
  신: '금',
  유: '금',
  해: '수',
  자: '수',
}

const HIDDEN_STEMS = {
  자: [hiddenStem('계', '정기')],
  축: [hiddenStem('계', '여기'), hiddenStem('신', '중기'), hiddenStem('기', '정기')],
  인: [hiddenStem('무', '여기'), hiddenStem('병', '중기'), hiddenStem('갑', '정기')],
  묘: [hiddenStem('갑', '여기'), hiddenStem('을', '정기')],
  진: [hiddenStem('을', '여기'), hiddenStem('계', '중기'), hiddenStem('무', '정기')],
  사: [hiddenStem('무', '여기'), hiddenStem('경', '중기'), hiddenStem('병', '정기')],
  오: [hiddenStem('병', '여기'), hiddenStem('기', '중기'), hiddenStem('정', '정기')],
  미: [hiddenStem('정', '여기'), hiddenStem('을', '중기'), hiddenStem('기', '정기')],
  신: [hiddenStem('무', '여기'), hiddenStem('임', '중기'), hiddenStem('경', '정기')],
  유: [hiddenStem('경', '여기'), hiddenStem('신', '정기')],
  술: [hiddenStem('신', '여기'), hiddenStem('정', '중기'), hiddenStem('무', '정기')],
  해: [hiddenStem('무', '여기'), hiddenStem('갑', '중기'), hiddenStem('임', '정기')],
}

const PILLARS = [
  { key: 'year', label: '년', field: 'yearPillar' },
  { key: 'month', label: '월', field: 'monthPillar' },
  { key: 'day', label: '일', field: 'dayPillar' },
  { key: 'hour', label: '시', field: 'hourPillar' },
]

const GENERATES = {
  목: '화',
  화: '토',
  토: '금',
  금: '수',
  수: '목',
}

const CONTROLS = {
  목: '토',
  화: '금',
  토: '수',
  금: '목',
  수: '화',
}

function hiddenStem(stem, phase) {
  return { stem: stem, phase: phase }
}

function getTenGod(dayStem, targetStem) {
  const day = STEMS[dayStem]
  const target = STEMS[targetStem]
  if (!day || !target) throw new Error('십신을 계산할 수 없는 천간입니다.')

  const samePolarity = day.yinYang === target.yinYang
  if (day.element === target.element) return samePolarity ? '비견' : '겁재'
  if (GENERATES[day.element] === target.element) return samePolarity ? '식신' : '상관'
  if (CONTROLS[day.element] === target.element) return samePolarity ? '편재' : '정재'
  if (CONTROLS[target.element] === day.element) return samePolarity ? '편관' : '정관'
  if (GENERATES[target.element] === day.element) return samePolarity ? '편인' : '정인'

  throw new Error('십신 관계를 계산할 수 없습니다.')
}

function getElementProfile(saju) {
  const counts = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 }

  PILLARS.forEach(function (definition) {
    const pillar = saju[definition.field]
    if (!pillar) return

    const stem = String(pillar).charAt(0)
    const branch = String(pillar).charAt(1)
    if (STEMS[stem]) counts[STEMS[stem].element] += 1
    if (BRANCH_ELEMENTS[branch]) counts[BRANCH_ELEMENTS[branch]] += 1
  })

  return {
    counts: counts,
    text: ['목', '화', '토', '금', '수']
      .map(function (element) {
        return element + ' ' + counts[element]
      })
      .join(' · '),
  }
}

function analyzePillar(dayStem, definition, pillar) {
  const stem = String(pillar).charAt(0)
  const branch = String(pillar).charAt(1)
  const hiddenStems = (HIDDEN_STEMS[branch] || []).map(function (item) {
    return {
      stem: item.stem,
      phase: item.phase,
      tenGod: getTenGod(dayStem, item.stem),
    }
  })
  const mainStem = hiddenStems.find(function (item) {
    return item.phase === '정기'
  })

  return {
    key: definition.key,
    label: definition.label,
    pillar: String(pillar),
    stem: stem,
    branch: branch,
    stemTenGod: getTenGod(dayStem, stem),
    branchMainTenGod: mainStem ? mainStem.tenGod : '미상',
    hiddenStems: hiddenStems,
  }
}

/**
 * 원국의 겉오행, 십신과 지장간을 계산합니다.
 * @param {types.SajuPillars} saju 사주 원국
 * @returns {types.SajuAnalysis} 원국 분석 결과
 */
function analyzeSaju(saju) {
  const dayStem = String(saju.dayPillar || '').charAt(0)
  const dayMaster = STEMS[dayStem]
  if (!dayMaster) throw new Error('일간을 확인할 수 없습니다.')

  const pillars = PILLARS.filter(function (definition) {
    return Boolean(saju[definition.field])
  }).map(function (definition) {
    return analyzePillar(dayStem, definition, saju[definition.field])
  })

  return {
    dayMaster: {
      stem: dayStem,
      element: dayMaster.element,
      yinYang: dayMaster.yinYang,
      label: dayStem + dayMaster.element + '(' + dayMaster.yinYang + ')',
    },
    elementProfile: getElementProfile(saju),
    pillars: pillars,
    stemTenGodText: pillars
      .map(function (pillar) {
        return pillar.label + '간 ' + pillar.stem + '(' + pillar.stemTenGod + ')'
      })
      .join(' · '),
    branchTenGodText: pillars
      .map(function (pillar) {
        return pillar.label + '지 ' + pillar.branch + '(' + pillar.branchMainTenGod + ')'
      })
      .join(' · '),
    hiddenStemLines: pillars.map(function (pillar) {
      const details = pillar.hiddenStems
        .map(function (item) {
          return item.stem + '(' + item.tenGod + '·' + item.phase + ')'
        })
        .join(' · ')
      return pillar.label + '지 ' + pillar.branch + ': ' + details
    }),
  }
}

module.exports = {
  analyzeSaju,
}
