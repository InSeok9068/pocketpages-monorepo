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
    hiddenStems: HiddenStemAnalysis[]
  }

  interface SajuAnalysis {
    dayMaster: DayMasterAnalysis
    elementProfile: ElementProfile
    pillars: PillarAnalysis[]
    stemTenGodText: string
    branchTenGodText: string
    hiddenStemLines: string[]
  }
}
