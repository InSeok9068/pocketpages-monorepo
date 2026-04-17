declare namespace types {
  type PhotofolioCapturePageType = 'assets_overview' | 'invest_overview' | 'invest_holdings' | 'unknown'

  type PhotofolioAssetClassCode =
    | 'cash'
    | 'stock_growth'
    | 'stock_dividend'
    | 'bond'
    | 'gold'
    | 'real_estate'
    | 'other'

  interface PhotofolioAiExtractSection {
    section_label: string
    reported_amount_krw: number | null
    source_json: any
  }

  interface PhotofolioAiExtractItem {
    institution_name: string
    account_label: string
    asset_name: string
    asset_class_code: PhotofolioAssetClassCode
    source_section_label: string
    market_code: string
    currency_code: string
    quantity: number | null
    unit_price: number | null
    amount_original: number | null
    exchange_rate: number | null
    amount_krw: number | null
    memo: string
    source_json: any
  }

  interface PhotofolioAiExtractResult {
    page_type: PhotofolioCapturePageType
    snapshot_title: string
    snapshot_date: string
    total_amount_krw: number | null
    sections: PhotofolioAiExtractSection[]
    items: PhotofolioAiExtractItem[]
    raw_text: string
    raw_json: any
  }

  type PhotofolioTrendRangeCode = '3m' | '6m' | '1y' | '3y'

  interface PhotofolioTrendPoint {
    date: string
    value: number
  }

  interface PhotofolioTrendSeries {
    key: string
    series_id: string
    label: string
    unit: string
    points: PhotofolioTrendPoint[]
    latest_value: number | null
    previous_value: number | null
    start_value: number | null
    latest_date: string
  }
}
