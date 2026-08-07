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

const STEM_ORDER = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계']
const BRANCH_ORDER = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해']
const TWELVE_STAGES = ['장생', '목욕', '관대', '건록', '제왕', '쇠', '병', '사', '묘', '절', '태', '양']

const TWELVE_STAGE_START = {
  갑: '해',
  을: '오',
  병: '인',
  정: '유',
  무: '인',
  기: '유',
  경: '사',
  신: '자',
  임: '신',
  계: '묘',
}

const MONTH_COMMANDS = {
  인: { season: '봄', phase: '초봄', element: '목' },
  묘: { season: '봄', phase: '한봄', element: '목' },
  진: { season: '봄', phase: '늦봄', element: '토' },
  사: { season: '여름', phase: '초여름', element: '화' },
  오: { season: '여름', phase: '한여름', element: '화' },
  미: { season: '여름', phase: '늦여름', element: '토' },
  신: { season: '가을', phase: '초가을', element: '금' },
  유: { season: '가을', phase: '한가을', element: '금' },
  술: { season: '가을', phase: '늦가을', element: '토' },
  해: { season: '겨울', phase: '초겨울', element: '수' },
  자: { season: '겨울', phase: '한겨울', element: '수' },
  축: { season: '겨울', phase: '늦겨울', element: '토' },
}

const STEM_COMBINATIONS = [
  { pair: ['갑', '기'], result: '토' },
  { pair: ['을', '경'], result: '금' },
  { pair: ['병', '신'], result: '수' },
  { pair: ['정', '임'], result: '목' },
  { pair: ['무', '계'], result: '화' },
]

const BRANCH_PAIR_RELATIONS = [
  {
    type: '육합',
    pairs: [
      ['자', '축'],
      ['인', '해'],
      ['묘', '술'],
      ['진', '유'],
      ['사', '신'],
      ['오', '미'],
    ],
  },
  {
    type: '충',
    pairs: [
      ['자', '오'],
      ['축', '미'],
      ['인', '신'],
      ['묘', '유'],
      ['진', '술'],
      ['사', '해'],
    ],
  },
  {
    type: '형',
    pairs: [
      ['인', '사'],
      ['사', '신'],
      ['신', '인'],
      ['축', '술'],
      ['술', '미'],
      ['미', '축'],
      ['자', '묘'],
      ['진', '진'],
      ['오', '오'],
      ['유', '유'],
      ['해', '해'],
    ],
  },
  {
    type: '파',
    pairs: [
      ['자', '유'],
      ['축', '진'],
      ['인', '해'],
      ['묘', '오'],
      ['사', '신'],
      ['미', '술'],
    ],
  },
  {
    type: '해',
    pairs: [
      ['자', '미'],
      ['축', '오'],
      ['인', '사'],
      ['묘', '진'],
      ['신', '해'],
      ['유', '술'],
    ],
  },
]

const BRANCH_GROUP_RELATIONS = [
  { type: '삼합', branches: ['신', '자', '진'], result: '수' },
  { type: '삼합', branches: ['해', '묘', '미'], result: '목' },
  { type: '삼합', branches: ['인', '오', '술'], result: '화' },
  { type: '삼합', branches: ['사', '유', '축'], result: '금' },
  { type: '방합', branches: ['인', '묘', '진'], result: '목' },
  { type: '방합', branches: ['사', '오', '미'], result: '화' },
  { type: '방합', branches: ['신', '유', '술'], result: '금' },
  { type: '방합', branches: ['해', '자', '축'], result: '수' },
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

function matchesPair(pair, left, right) {
  return (pair[0] === left && pair[1] === right) || (pair[0] === right && pair[1] === left)
}

function getStemCombination(left, right) {
  return STEM_COMBINATIONS.find(function (combination) {
    return matchesPair(combination.pair, left, right)
  })
}

function getBranchPairRelations(left, right) {
  const relations = []

  BRANCH_PAIR_RELATIONS.forEach(function (definition) {
    const matched = definition.pairs.some(function (pair) {
      return matchesPair(pair, left, right)
    })
    if (matched) relations.push(definition.type)
  })

  return relations
}

function hasAllBranches(branches, requiredBranches) {
  return requiredBranches.every(function (branch) {
    return branches.indexOf(branch) >= 0
  })
}

function hasFinalConsonant(value) {
  const characterCode = String(value).charCodeAt(String(value).length - 1)
  return characterCode >= 0xac00 && characterCode <= 0xd7a3 && (characterCode - 0xac00) % 28 !== 0
}

function withAndParticle(value) {
  return value + (hasFinalConsonant(value) ? '과' : '와')
}

function withSubjectParticle(value) {
  return value + (hasFinalConsonant(value) ? '이' : '가')
}

function getTwelveStage(dayStem, branch) {
  const startBranch = TWELVE_STAGE_START[dayStem]
  const startIndex = BRANCH_ORDER.indexOf(startBranch)
  const branchIndex = BRANCH_ORDER.indexOf(branch)
  if (startIndex < 0 || branchIndex < 0) return '미상'

  const direction = STEMS[dayStem].yinYang === '양' ? 1 : -1
  const distance = direction === 1 ? branchIndex - startIndex : startIndex - branchIndex
  return TWELVE_STAGES[(distance + 12) % 12]
}

function getMonthCommand(monthPillar) {
  const branch = String(monthPillar || '').charAt(1)
  const command = MONTH_COMMANDS[branch]
  if (!command) throw new Error('월령을 확인할 수 없습니다.')

  return {
    branch: branch,
    season: command.season,
    phase: command.phase,
    element: command.element,
    text: branch + '월 · ' + command.phase + '(' + command.season + ') · 월지 오행 ' + command.element,
  }
}

function getNatalRelationLines(pillars) {
  const lines = []

  for (let leftIndex = 0; leftIndex < pillars.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pillars.length; rightIndex += 1) {
      const left = pillars[leftIndex]
      const right = pillars[rightIndex]
      const stemCombination = getStemCombination(left.stem, right.stem)
      if (stemCombination) {
        lines.push(left.label + '간 ' + left.stem + '·' + right.label + '간 ' + right.stem + ': 천간합(' + stemCombination.result + ')')
      }

      const branchRelations = getBranchPairRelations(left.branch, right.branch)
      if (branchRelations.length > 0) {
        lines.push(left.label + '지 ' + left.branch + '·' + right.label + '지 ' + right.branch + ': ' + branchRelations.join('·'))
      }
    }
  }

  const branches = pillars.map(function (pillar) {
    return pillar.branch
  })
  BRANCH_GROUP_RELATIONS.forEach(function (relation) {
    if (hasAllBranches(branches, relation.branches)) {
      lines.push(relation.branches.join('·') + ': ' + relation.type + '(' + relation.result + ')')
    }
  })

  return lines
}

function getYearPillar(year) {
  const stemIndex = ((year - 4) % 10 + 10) % 10
  const branchIndex = ((year - 4) % 12 + 12) % 12
  return STEM_ORDER[stemIndex] + BRANCH_ORDER[branchIndex]
}

function getAnnualRelations(pillars, annualStem, annualBranch) {
  const relations = []

  pillars.forEach(function (pillar) {
    const stemCombination = getStemCombination(annualStem, pillar.stem)
    if (stemCombination) {
      relations.push(pillar.label + '간 ' + withAndParticle(pillar.stem) + ' 천간합(' + stemCombination.result + ')')
    }

    const branchRelations = getBranchPairRelations(annualBranch, pillar.branch)
    if (branchRelations.length > 0) {
      relations.push(pillar.label + '지 ' + withAndParticle(pillar.branch) + ' ' + branchRelations.join('·'))
    }
  })

  const natalBranches = pillars.map(function (pillar) {
    return pillar.branch
  })
  const combinedBranches = natalBranches.concat([annualBranch])
  BRANCH_GROUP_RELATIONS.forEach(function (relation) {
    if (!hasAllBranches(natalBranches, relation.branches) && hasAllBranches(combinedBranches, relation.branches)) {
      relations.push(withSubjectParticle(annualBranch) + ' 더해져 ' + relation.branches.join('·') + ' ' + relation.type + '(' + relation.result + ')')
    }
  })

  return relations
}

function getAnnualFortunes(dayStem, pillars, currentYear) {
  const fortunes = []

  for (let offset = 0; offset < 3; offset += 1) {
    const year = currentYear + offset
    const pillar = getYearPillar(year)
    const stem = pillar.charAt(0)
    const branch = pillar.charAt(1)
    const hiddenStems = HIDDEN_STEMS[branch] || []
    const mainStem = hiddenStems.find(function (item) {
      return item.phase === '정기'
    })
    const relations = getAnnualRelations(pillars, stem, branch)
    const stemTenGod = getTenGod(dayStem, stem)
    const branchMainTenGod = mainStem ? getTenGod(dayStem, mainStem.stem) : '미상'
    const twelveStage = getTwelveStage(dayStem, branch)
    const relationText = relations.length > 0 ? relations.join(' / ') : '원국과 직접적인 합충형파해 없음'

    fortunes.push({
      year: year,
      pillar: pillar,
      stemTenGod: stemTenGod,
      branchMainTenGod: branchMainTenGod,
      twelveStage: twelveStage,
      relations: relations,
      text:
        year
        + '년 '
        + pillar
        + ' · 천간 '
        + stemTenGod
        + ' · 지지 본기 '
        + branchMainTenGod
        + ' · 12운성 '
        + twelveStage
        + ' · '
        + relationText,
    })
  }

  return fortunes
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
    twelveStage: getTwelveStage(dayStem, branch),
    hiddenStems: hiddenStems,
  }
}

/**
 * 원국과 향후 세운의 고정 관계를 계산합니다.
 * @param {types.SajuPillars} saju 사주 원국
 * @param {number} currentYear 세운 시작 연도
 * @returns {types.SajuAnalysis} 원국 분석 결과
 */
function analyzeSaju(saju, currentYear) {
  const dayStem = String(saju.dayPillar || '').charAt(0)
  const dayMaster = STEMS[dayStem]
  if (!dayMaster) throw new Error('일간을 확인할 수 없습니다.')

  const pillars = PILLARS.filter(function (definition) {
    return Boolean(saju[definition.field])
  }).map(function (definition) {
    return analyzePillar(dayStem, definition, saju[definition.field])
  })
  const annualFortunes = getAnnualFortunes(dayStem, pillars, currentYear)

  return {
    dayMaster: {
      stem: dayStem,
      element: dayMaster.element,
      yinYang: dayMaster.yinYang,
      label: dayStem + dayMaster.element + '(' + dayMaster.yinYang + ')',
    },
    elementProfile: getElementProfile(saju),
    pillars: pillars,
    monthCommand: getMonthCommand(saju.monthPillar),
    natalRelationLines: getNatalRelationLines(pillars),
    annualFortunes: annualFortunes,
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
    twelveStageText: pillars
      .map(function (pillar) {
        return pillar.label + '지 ' + pillar.branch + '(' + pillar.twelveStage + ')'
      })
      .join(' · '),
    annualFortuneLines: annualFortunes.map(function (fortune) {
      return fortune.text
    }),
  }
}

module.exports = {
  analyzeSaju,
}
