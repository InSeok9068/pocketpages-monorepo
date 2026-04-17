declare namespace types {
  type PhotofolioAssetClassCode =
    | 'cash'
    | 'stock_growth'
    | 'stock_dividend'
    | 'bond'
    | 'gold'
    | 'real_estate'
    | 'other'

  interface PhotofolioAiExtractItem {
    institution_name: string
    account_label: string
    asset_name: string
    asset_class_code: PhotofolioAssetClassCode
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
    snapshot_title: string
    snapshot_date: string
    total_amount_krw: number | null
    items: PhotofolioAiExtractItem[]
    raw_text: string
    raw_json: any
  }
}
