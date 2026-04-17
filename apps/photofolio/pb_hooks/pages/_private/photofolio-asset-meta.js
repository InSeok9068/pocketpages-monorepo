const ASSET_CLASS_SPECS = [
  {
    code: 'cash',
    label: '현금',
    description: '예금, 적금, CMA, 예수금 같은 대기 자금.',
    tone: 'bg-[#eef6ff] text-[#3182f6]',
  },
  {
    code: 'stock_growth',
    label: '주식(성장형)',
    description: '성장주, 지수 ETF, 장기 성장 노출 자산.',
    tone: 'bg-[#f1f6ff] text-[#2563eb]',
  },
  {
    code: 'stock_dividend',
    label: '주식(배당형)',
    description: '배당주, 배당 ETF, 현금흐름 중심 자산.',
    tone: 'bg-[#f5f7ff] text-[#4f46e5]',
  },
  {
    code: 'bond',
    label: '채권',
    description: '국채, 회사채, 채권 ETF 같은 방어 자산.',
    tone: 'bg-[#f2fbf7] text-[#0f9f6e]',
  },
  {
    code: 'gold',
    label: '금',
    description: '금 현물, 금 ETF, 금 계좌 자산.',
    tone: 'bg-[#fff8e8] text-[#d97706]',
  },
  {
    code: 'real_estate',
    label: '부동산',
    description: '실물 부동산, 리츠, 부동산 ETF.',
    tone: 'bg-[#fff3f1] text-[#e85d3f]',
  },
  {
    code: 'other',
    label: '기타',
    description: '위 분류에 딱 맞지 않는 예외 자산.',
    tone: 'bg-[#f4f6f8] text-[#6b7684]',
  },
]

const ASSET_CLASS_ORDER = ASSET_CLASS_SPECS.map(function (assetClass) {
  return assetClass.code
})

const ASSET_CLASS_META = ASSET_CLASS_SPECS.reduce(function (meta, assetClass) {
  meta[assetClass.code] = assetClass
  return meta
}, {})

module.exports = {
  ASSET_CLASS_SPECS,
  ASSET_CLASS_ORDER,
  ASSET_CLASS_META,
}
