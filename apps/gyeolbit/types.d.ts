declare namespace types {
  type FiveElement = '목' | '화' | '토' | '금' | '수'
  type YinYang = '양' | '음'

  interface SajuPillars {
    yearPillar: string
    monthPillar: string
    dayPillar: string
    hourPillar?: string | null
  }

  interface ElementProfile {
    counts: Record<FiveElement, number>
    text: string
  }

  interface DayMasterAnalysis {
    stem: string
    element: FiveElement
    yinYang: YinYang
    label: string
  }

  interface HiddenStemAnalysis {
    stem: string
    phase: '여기' | '중기' | '정기'
    tenGod: string
  }

  interface PillarAnalysis {
    key: 'year' | 'month' | 'day' | 'hour'
    label: '년' | '월' | '일' | '시'
    pillar: string
    stem: string
    branch: string
    stemTenGod: string
    branchMainTenGod: string
    twelveStage: string
    hiddenStems: HiddenStemAnalysis[]
  }

  interface MonthCommandAnalysis {
    branch: string
    season: string
    phase: string
    element: FiveElement
    text: string
  }

  interface AnnualFortuneAnalysis {
    year: number
    pillar: string
    stemTenGod: string
    branchMainTenGod: string
    twelveStage: string
    relations: string[]
    text: string
  }

  interface SajuAnalysis {
    dayMaster: DayMasterAnalysis
    elementProfile: ElementProfile
    pillars: PillarAnalysis[]
    monthCommand: MonthCommandAnalysis
    natalRelationLines: string[]
    annualFortunes: AnnualFortuneAnalysis[]
    stemTenGodText: string
    branchTenGodText: string
    hiddenStemLines: string[]
    twelveStageText: string
    annualFortuneLines: string[]
  }
}
