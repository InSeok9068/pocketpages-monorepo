declare namespace types {
  /** 리밸런싱 기준 자산군입니다. */
  type SeedLabAssetClass = 'equity' | 'fixed_income' | 'cash' | 'alternative'

  /** 상품 형태입니다. */
  type SeedLabAssetType = 'stock' | 'etf' | 'bond' | 'index' | 'cash' | 'fund'

  /** 자산 자동 분류 결과입니다. */
  type SeedLabAssetClassification = {
    /** 상품 형태입니다. */
    assetType: SeedLabAssetType
    /** 리밸런싱 자산군입니다. */
    assetClass: SeedLabAssetClass
    /** 분류 출처입니다. */
    classificationSource: 'auto' | 'manual' | 'toss' | 'import'
    /** 0~1 사이 신뢰도입니다. */
    classificationConfidence: number
  }

  /** 원본 통화 금액 입력입니다. */
  type SeedLabValuationSourceInput = {
    /** 원본 보유 종목입니다. */
    raw?: Record<string, any>
    /** seedlab 원본 금액 필드입니다. */
    sourceKey: string
  }

  /** 원화 평가금 입력입니다. */
  type SeedLabValuationAmountInput = SeedLabValuationSourceInput & {
    /** 보유 종목 통화입니다. */
    currency?: TossCurrency
    /** DB 저장 금액입니다. */
    storedAmount?: number
    /** seedlab 원화 금액 필드입니다. */
    krwKey: string
    /** 최신 USD/KRW 환율입니다. */
    latestUsdKrwRate?: number
  }

  /** 토스증권 API 통화 코드입니다. */
  type TossCurrency = 'KRW' | 'USD' | (string & {})

  /** 주문 방향입니다. */
  type TossOrderSide = 'BUY' | 'SELL' | (string & {})

  /** 주문 호가 유형입니다. */
  type TossOrderType = 'LIMIT' | 'MARKET' | (string & {})

  /** 주문 유효 조건입니다. */
  type TossTimeInForce = 'DAY' | 'CLS' | (string & {})

  /** 주문 목록 조회용 상태 그룹입니다. */
  type TossOrderStatusGroup = 'OPEN' | 'CLOSED' | (string & {})

  /** 캔들 조회 주기입니다. */
  type TossCandleInterval = '1m' | '1d' | (string & {})

  /** 토스증권 계좌 식별자입니다. */
  type TossAccountSeq = string | number

  /** 단일 문자열 또는 종목 배열입니다. */
  type TossSymbolList = string | string[]

  /** 토스증권 API 클라이언트 생성 옵션입니다. */
  type TossApiClientOptions = {
    /** 토스증권 Open API 키입니다. */
    apiKey?: string
    /** 토스증권 Open API 시크릿입니다. */
    secret?: string
    /** OAuth client_id 직접 지정값입니다. */
    clientId?: string
    /** OAuth client_secret 직접 지정값입니다. */
    clientSecret?: string
    /** 이미 발급받은 액세스 토큰입니다. */
    accessToken?: string
    /** 액세스 토큰 만료까지 남은 초입니다. */
    accessTokenExpiresInSeconds?: number
    /** 액세스 토큰 만료 시각입니다. */
    accessTokenExpiresAtMs?: number
    /** 계좌/주문 API 기본 계좌 식별자입니다. */
    accountSeq?: TossAccountSeq
    /** 토스증권 Open API 기준 URL입니다. */
    baseUrl?: string
    /** HTTP 요청 제한 시간입니다. */
    timeoutSeconds?: number
  }

  /** 토스증권 rate limit 응답 헤더입니다. */
  type TossApiRateLimit = {
    /** 현재 초당 허용 요청 수입니다. */
    limit: string
    /** 현재 남은 요청 토큰 수입니다. */
    remaining: string
    /** 다음 요청 토큰 충전까지 남은 시간입니다. */
    reset: string
    /** 429 응답 후 권장 대기 시간입니다. */
    retryAfter: string
  }

  /** 토스증권 에러 envelope의 error 값입니다. */
  type TossApiError = {
    /** 토스증권 요청 추적 ID입니다. */
    requestId?: string
    /** 토스증권 에러 코드입니다. */
    code?: string
    /** 사용자 또는 로그에 남길 에러 메시지입니다. */
    message?: string
    /** 에러 해결 힌트입니다. */
    data?: any
  }

  /** 토스증권 API 호출 결과입니다. */
  type TossApiResult<TResult = any> = {
    /** HTTP 성공과 API 에러 부재를 함께 반영한 성공 여부입니다. */
    ok: boolean
    /** HTTP 상태 코드입니다. */
    statusCode: number
    /** 호출한 OpenAPI operationId입니다. */
    operationId: string
    /** 파싱된 원본 JSON 응답입니다. */
    json: any
    /** 성공 응답의 result payload입니다. */
    result: TResult | null
    /** 실패 응답의 error payload입니다. */
    error: TossApiError | null
    /** 화면 또는 로그에 쓸 오류 메시지입니다. */
    errorMessage: string
    /** 응답 추적용 requestId입니다. */
    requestId: string
    /** 원본 응답 헤더입니다. */
    headers: Record<string, string[]>
    /** 요청 제한 관련 응답 헤더입니다. */
    rateLimit: TossApiRateLimit
  }

  /** OAuth2 토큰 발급 요청 값입니다. */
  type TossTokenRequest = {
    /** 토스증권 Open API 키입니다. */
    apiKey?: string
    /** 토스증권 Open API 시크릿입니다. */
    secret?: string
    /** OAuth client_id 직접 지정값입니다. */
    clientId?: string
    /** OAuth client_secret 직접 지정값입니다. */
    clientSecret?: string
  }

  /** OAuth2 토큰 발급 응답입니다. */
  type TossTokenResponse = {
    /** Bearer 인증에 사용할 액세스 토큰입니다. */
    access_token: string
    /** 토큰 타입입니다. */
    token_type: 'Bearer' | (string & {})
    /** 만료까지 남은 초입니다. */
    expires_in: number
  }

  /** 계좌 API 호출 옵션입니다. */
  type TossAccountOption = {
    /** 요청에 사용할 계좌 식별자입니다. */
    accountSeq?: TossAccountSeq
  }

  /** 신규 엔드포인트 대응용 원시 요청 값입니다. */
  type TossRawRequest = {
    /** 로그와 결과에 남길 operationId입니다. */
    operationId?: string
    /** HTTP 메서드입니다. */
    method?: string
    /** API 경로입니다. */
    path: string
    /** path parameter 치환 값입니다. */
    pathParams?: Record<string, any>
    /** query string 값입니다. */
    query?: Record<string, any>
    /** 추가 요청 헤더입니다. */
    headers?: Record<string, string>
    /** JSON 요청 body입니다. */
    body?: any
    /** Bearer 토큰 필요 여부입니다. */
    requiresAuth?: boolean
    /** 계좌 헤더 필요 여부입니다. */
    requiresAccount?: boolean
    /** 요청별 계좌 식별자입니다. */
    accountSeq?: TossAccountSeq
    /** 요청별 제한 시간입니다. */
    timeoutSeconds?: number
  }

  /** SeedLab credential 암복호화 옵션입니다. */
  type SeedLabCredentialCryptoOptions = {
    /** 직접 전달한 32글자 암호화 키입니다. */
    key?: string
    /** 직접 전달한 32글자 암호화 키입니다. */
    credentialKey?: string
    /** 테스트 또는 JSVM 주입용 security 헬퍼입니다. */
    security?: {
      /** 문자열을 암호화합니다. */
      encrypt: (data: string, key: string) => string
      /** 문자열을 복호화합니다. */
      decrypt: (cipherText: string, key: string) => string | number[]
    }
  }

  /** 저장할 암호화 secret 값입니다. */
  type SeedLabEncryptedSecret = {
    /** 암호화된 secret입니다. */
    encryptedSecret: string
    /** 화면 노출용 마스킹 값입니다. */
    secretPreview: string
  }

  /** Toss 연결 레코드 또는 테스트용 객체입니다. */
  type SeedLabTossConnectionLike = {
    /** PocketBase Record 필드 접근자입니다. */
    get?: (fieldName: string) => any
    /** Toss Open API client_id입니다. */
    clientId?: any
    /** 암호화된 Toss Open API client_secret입니다. */
    encryptedSecret?: any
    /** Toss 계좌 식별자입니다. */
    accountSeq?: any
  }

  /** 단일 종목 요청 값입니다. */
  type TossSymbolRequest = {
    /** KRX 6자리 코드 또는 미국 티커입니다. */
    symbol: string
  }

  /** 다건 종목 요청 값입니다. */
  type TossSymbolsRequest = {
    /** 콤마 문자열 또는 종목 배열입니다. */
    symbols: TossSymbolList
  }

  /** 최근 체결 조회 요청 값입니다. */
  type TossTradesRequest = {
    /** 조회할 종목 코드입니다. */
    symbol: string
    /** 조회 건수입니다. */
    count?: number
  }

  /** 캔들 차트 조회 요청 값입니다. */
  type TossCandlesRequest = {
    /** 조회할 종목 코드입니다. */
    symbol: string
    /** 봉 단위입니다. */
    interval: TossCandleInterval
    /** 조회 봉 수입니다. */
    count?: number
    /** 페이지네이션 상한 시각입니다. */
    before?: string
    /** 수정주가 적용 여부입니다. */
    adjusted?: boolean
  }

  /** 환율 조회 요청 값입니다. */
  type TossExchangeRateRequest = {
    /** 기준 통화입니다. */
    baseCurrency: TossCurrency
    /** 표시 통화입니다. */
    quoteCurrency: TossCurrency
    /** 조회할 환율 시각입니다. */
    dateTime?: string
  }

  /** 장 운영 정보 조회 요청 값입니다. */
  type TossMarketCalendarRequest = {
    /** 조회 기준일입니다. */
    date?: string
  }

  /** 보유 주식 조회 요청 값입니다. */
  type TossHoldingsRequest = TossAccountOption & {
    /** 특정 종목만 조회할 때 쓰는 종목 코드입니다. */
    symbol?: string
  }

  /** 주문 목록 조회 요청 값입니다. */
  type TossOrdersRequest = TossAccountOption & {
    /** 진행중 또는 종료 주문 그룹입니다. */
    status: TossOrderStatusGroup
    /** 특정 종목만 조회할 때 쓰는 종목 코드입니다. */
    symbol?: string
    /** 조회 시작일입니다. */
    from?: string
    /** 조회 종료일입니다. */
    to?: string
    /** 종료 주문 페이지네이션 커서입니다. */
    cursor?: string
    /** 종료 주문 페이지 크기입니다. */
    limit?: number
  }

  /** 주문 상세 요청 값입니다. */
  type TossOrderIdRequest = TossAccountOption & {
    /** 토스증권 주문 식별자입니다. */
    orderId: string
  }

  /** 주문 생성 요청 값입니다. */
  type TossOrderCreateRequest = {
    /** 멱등성 보장을 위한 클라이언트 주문 키입니다. */
    clientOrderId?: string
    /** 주문할 종목 코드입니다. */
    symbol: string
    /** 매수 또는 매도 방향입니다. */
    side: TossOrderSide
    /** 지정가 또는 시장가 유형입니다. */
    orderType: TossOrderType
    /** 당일 또는 장마감 주문 조건입니다. */
    timeInForce?: TossTimeInForce
    /** 수량 기반 주문 수량입니다. */
    quantity?: string
    /** 미국 시장가 매수용 금액입니다. */
    orderAmount?: string
    /** 지정가 주문 가격입니다. */
    price?: string
    /** 고액 주문 확인 플래그입니다. */
    confirmHighValueOrder?: boolean
  }

  /** 주문 정정 요청 값입니다. */
  type TossOrderModifyRequest = {
    /** 변경할 주문 유형입니다. */
    orderType: TossOrderType
    /** 국내 주식 정정 수량입니다. */
    quantity?: string
    /** 변경할 주문 가격입니다. */
    price?: string
    /** 고액 주문 확인 플래그입니다. */
    confirmHighValueOrder?: boolean
  }

  /** 매수 가능 금액 조회 요청 값입니다. */
  type TossBuyingPowerRequest = TossAccountOption & {
    /** 조회할 현금 통화입니다. */
    currency: TossCurrency
  }

  /** 판매 가능 수량 조회 요청 값입니다. */
  type TossSellableQuantityRequest = TossAccountOption & {
    /** 조회할 종목 코드입니다. */
    symbol: string
  }

  /** 토스증권 Open API 클라이언트입니다. */
  type TossApiClient = {
    /** OAuth2 액세스 토큰을 발급합니다. */
    issueOAuth2Token(input?: TossTokenRequest): TossApiResult<TossTokenResponse>
    /** 외부에서 발급한 액세스 토큰을 설정합니다. */
    setAccessToken(accessToken: string, expiresInSeconds?: number): void
    /** 스펙 추가 대응용 원시 요청을 보냅니다. */
    request(descriptor: TossRawRequest): TossApiResult
    /** 호가를 조회합니다. */
    getOrderbook(input: TossSymbolRequest): TossApiResult
    /** 현재가를 조회합니다. */
    getPrices(input: TossSymbolsRequest): TossApiResult
    /** 최근 체결 내역을 조회합니다. */
    getTrades(input: TossTradesRequest): TossApiResult
    /** 상하한가를 조회합니다. */
    getPriceLimit(input: TossSymbolRequest): TossApiResult
    /** 캔들 차트를 조회합니다. */
    getCandles(input: TossCandlesRequest): TossApiResult
    /** 종목 기본 정보를 조회합니다. */
    getStocks(input: TossSymbolsRequest): TossApiResult
    /** 매수 유의사항을 조회합니다. */
    getStockWarnings(input: TossSymbolRequest): TossApiResult
    /** 환율을 조회합니다. */
    getExchangeRate(input: TossExchangeRateRequest): TossApiResult
    /** 국내 장 운영 정보를 조회합니다. */
    getKrMarketCalendar(input?: TossMarketCalendarRequest): TossApiResult
    /** 미국 장 운영 정보를 조회합니다. */
    getUsMarketCalendar(input?: TossMarketCalendarRequest): TossApiResult
    /** 계좌 목록을 조회합니다. */
    getAccounts(): TossApiResult
    /** 보유 주식을 조회합니다. */
    getHoldings(input?: TossHoldingsRequest): TossApiResult
    /** 주문 목록을 조회합니다. */
    getOrders(input: TossOrdersRequest): TossApiResult
    /** 주문을 생성합니다. */
    createOrder(order: TossOrderCreateRequest, options?: TossAccountOption): TossApiResult
    /** 주문 상세를 조회합니다. */
    getOrder(input: TossOrderIdRequest): TossApiResult
    /** 주문을 정정합니다. */
    modifyOrder(orderId: string, order: TossOrderModifyRequest, options?: TossAccountOption): TossApiResult
    /** 주문을 취소합니다. */
    cancelOrder(orderId: string, options?: TossAccountOption): TossApiResult
    /** 매수 가능 금액을 조회합니다. */
    getBuyingPower(input: TossBuyingPowerRequest): TossApiResult
    /** 판매 가능 수량을 조회합니다. */
    getSellableQuantity(input: TossSellableQuantityRequest): TossApiResult
    /** 매매 수수료를 조회합니다. */
    getCommissions(input?: TossAccountOption): TossApiResult
  }
}
