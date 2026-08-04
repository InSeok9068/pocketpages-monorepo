declare namespace pocketpagesAi {
  type AiProvider = 'gemini' | 'openai' | 'deepseek'
  type AiRateLimitCause = '' | 'rate-limit' | 'quota-or-billing-limit'
  type JsonObject = Record<string, any>

  /** AI 클라이언트 공통 옵션입니다. API 키를 생략하면 환경 변수를 우선 사용합니다. */
  interface AiClientOptions {
    /** 요청 제한 시간입니다. 기본값은 패키지 내부 기본값을 사용합니다. */
    timeoutSeconds?: number
    /** 재시도 횟수입니다. 429나 일시적 전송 오류에 적용됩니다. */
    maxAttempts?: number
    /** Gemini API 키입니다. 생략하면 `GEMINI_API_KEY` 또는 `GEMINI_AI_KEY`를 사용합니다. */
    geminiApiKey?: string
    /** OpenAI API 키입니다. 생략하면 `OPENAI_API_KEY`를 사용합니다. */
    openaiApiKey?: string
    /** DeepSeek API 키입니다. 생략하면 `DEEPSEEK_API_KEY`를 사용합니다. */
    deepseekApiKey?: string
  }

  /** provider별 요청에서 공통으로 받을 수 있는 옵션입니다. */
  interface AiRequestBase {
    /** 요청 단위 API 키입니다. 클라이언트 옵션과 환경 변수보다 우선합니다. */
    apiKey?: string
    /** 간단 호출용 입력값입니다. provider별 payload가 없을 때 사용합니다. */
    input?: unknown
    /** 간단 호출용 prompt 문자열입니다. provider별 payload가 없을 때 사용합니다. */
    prompt?: string
    /** provider 원본 payload를 직접 넘길 때 사용합니다. */
    payload?: JsonObject
    /** provider 기본 URL을 바꿔야 할 때 사용합니다. */
    baseUrl?: string
    /** 요청 단위 제한 시간입니다. */
    timeoutSeconds?: number
    /** 요청 단위 재시도 횟수입니다. */
    maxAttempts?: number
    /** true이면 간단 호출 결과를 JSON 응답 형식으로 요청합니다. */
    json?: boolean
  }

  /** 응답 MIME 타입입니다. `application/json`은 JSON, `text/x.enum`은 enum 값 하나를 강제합니다. */
  type GeminiResponseMimeType = 'text/plain' | 'application/json' | 'text/x.enum'
  /** content 발화자입니다. `user`는 사용자, `model`은 모델 응답입니다. */
  type GeminiContentRole = 'user' | 'model'

  interface GeminiTextPart {
    /** 텍스트 본문입니다. */
    text: string
  }

  interface GeminiInlineDataPart {
    /** base64로 인코딩한 인라인 바이너리 데이터입니다. (예: 이미지, 오디오) */
    inlineData: {
      /** 데이터의 MIME 타입입니다. (예: `image/png`) */
      mimeType: string
      /** base64로 인코딩한 데이터 문자열입니다. */
      data: string
    }
  }

  interface GeminiFileDataPart {
    /** File API 등으로 업로드한 파일을 URI로 참조합니다. */
    fileData: {
      /** 파일의 MIME 타입입니다. */
      mimeType?: string
      /** 파일 URI입니다. */
      fileUri: string
    }
  }

  type GeminiPart = GeminiTextPart | GeminiInlineDataPart | GeminiFileDataPart | JsonObject

  interface GeminiContent {
    /** 발화자입니다. 단일 턴 요청에서는 생략할 수 있습니다. */
    role?: GeminiContentRole
    /** 메시지를 구성하는 part 목록입니다. 텍스트·이미지·파일을 섞을 수 있습니다. */
    parts: GeminiPart[]
  }

  interface GeminiGenerationConfig {
    /** 생성을 멈출 문자열 목록입니다. (최대 5개) */
    stopSequences?: string[]
    /** 응답 형식입니다. JSON 출력은 `application/json`을 지정합니다. */
    responseMimeType?: GeminiResponseMimeType
    /** 응답 구조를 강제할 스키마입니다. `responseMimeType: application/json`과 함께 씁니다. */
    responseSchema?: JsonObject
    /** 표준 JSON Schema로 응답 구조를 강제합니다. `responseSchema`의 대안입니다. */
    responseJsonSchema?: JsonObject
    /** 응답에 포함할 모달리티입니다. (예: `TEXT`, `IMAGE`) */
    responseModalities?: string[]
    /** 생성할 응답 후보 개수입니다. */
    candidateCount?: number
    /** 응답에서 생성할 최대 토큰 수입니다. */
    maxOutputTokens?: number
    /** 무작위성입니다. 0에 가까울수록 결정적, 높을수록 다양해집니다. (0.0~2.0) */
    temperature?: number
    /** 누적 확률 기반 nucleus 샘플링 값입니다. */
    topP?: number
    /** 상위 K개 토큰만 후보로 삼습니다. nucleus 샘플링 모델에서는 설정할 수 없습니다. */
    topK?: number
    /** 재현성을 위한 디코딩 시드입니다. 같은 시드는 같은 결과 경향을 줍니다. */
    seed?: number
    /** 이미 등장한 토큰에 적용하는 존재 페널티입니다. 횟수와 무관한 binary on/off입니다. */
    presencePenalty?: number
    /** 사용 횟수에 비례해 커지는 빈도 페널티입니다. 양수는 반복 억제, 음수는 반복 유도입니다. */
    frequencyPenalty?: number
    /** 응답 토큰의 logprobs를 반환할지 여부입니다. */
    responseLogprobs?: boolean
    /** 각 위치에서 반환할 상위 logprobs 개수입니다. */
    logprobs?: number
    /** 시민 질의에 대한 향상된 답변을 활성화합니다. */
    enableEnhancedCivicAnswers?: boolean
    /** TTS 음성 출력 설정입니다. */
    speechConfig?: JsonObject
    /** 추론(thinking) 설정입니다. 예산이나 활성화 여부를 제어합니다. */
    thinkingConfig?: JsonObject
    /** 이미지 생성 설정입니다. */
    imageConfig?: JsonObject
    /** 입력 미디어 처리 해상도입니다. */
    mediaResolution?: string
  }

  /** Gemini generateContent 요청 옵션입니다. */
  interface GeminiRequest extends AiRequestBase {
    /** 모델 이름입니다. (예: `gemini-2.5-flash`, `gemini-2.5-pro`) */
    model: string
    /** API 버전입니다. 생략하면 `v1beta`를 사용합니다. */
    apiVersion?: string
    /** 대화 내용입니다. 생략하면 `input`/`prompt`로 단일 텍스트 턴을 만듭니다. */
    contents?: GeminiContent[]
    /** 모델이 호출할 수 있는 함수(function calling) 등 도구 목록입니다. */
    tools?: any[]
    /** 도구 호출 방식(function calling mode)을 제어합니다. */
    toolConfig?: JsonObject
    /** 생성 파라미터입니다. temperature, JSON 스키마, thinking 등을 설정합니다. */
    generationConfig?: GeminiGenerationConfig
    /** 유해 콘텐츠 차단 임계값 설정입니다. */
    safetySettings?: any[]
    /** 시스템 지시입니다. 모델의 역할·규칙을 고정할 때 씁니다. */
    systemInstruction?: GeminiContent
    /** 컨텍스트 캐시 리소스 이름입니다. 긴 공통 컨텍스트를 재사용해 비용을 줄입니다. */
    cachedContent?: string
  }

  /** 처리 등급입니다. `flex`/`priority`는 각각 저비용·저지연 옵션입니다. */
  type OpenAiServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority'
  /** 컨텍스트 초과 시 처리입니다. `auto`는 중간 내용을 잘라내고, `disabled`는 오류를 냅니다. */
  type OpenAiTruncation = 'auto' | 'disabled'
  /** 응답 상세도입니다. 낮을수록 간결한 답을 유도합니다. */
  type OpenAiVerbosity = 'low' | 'medium' | 'high'
  /** 응답 형식입니다. `json_schema`는 구조 강제, `json_object`는 JSON 유효성만 보장합니다. */
  type OpenAiResponseFormat =
    | { type: 'text' }
    | { type: 'json_object' }
    | {
        type: 'json_schema'
        /** 스키마 이름입니다. */
        name: string
        /** JSON Schema 본문입니다. */
        schema: JsonObject
        /** 스키마 설명입니다. */
        description?: string
        /** 스키마 준수를 엄격히 강제할지 여부입니다. */
        strict?: boolean
      }

  interface OpenAiTextConfig {
    /** 텍스트 응답 형식입니다. JSON 출력이나 스키마 강제를 여기서 지정합니다. */
    format?: OpenAiResponseFormat
    /** 응답 상세도입니다. */
    verbosity?: OpenAiVerbosity
  }

  /** `json: true` 간편 호출에서 구조를 강제할 json_schema 설정입니다. */
  interface OpenAiJsonSchema {
    /** schema 이름입니다. 생략하면 `response`를 사용합니다. */
    name?: string
    /** JSON schema 본문입니다. */
    schema: JsonObject
    /** schema 준수를 강제할지 여부입니다. 기본값은 true입니다. */
    strict?: boolean
    /** schema 설명입니다. */
    description?: string
  }

  /** 추론(reasoning) 설정입니다. o-series 등 추론 모델에서 사용합니다. */
  interface OpenAiReasoning {
    /** 추론에 쓰는 노력 수준입니다. 높을수록 깊게 사고하지만 느리고 비쌉니다. */
    effort?: 'minimal' | 'low' | 'medium' | 'high'
    /** 추론 과정 요약 방식입니다. */
    summary?: 'auto' | 'concise' | 'detailed' | null
  }

  interface OpenAiInputTextContent {
    type: 'input_text'
    /** 입력 텍스트입니다. */
    text: string
  }

  interface OpenAiInputImageContent {
    type: 'input_image'
    /** 이미지 URL입니다. data URL도 가능합니다. */
    image_url?: string
    /** 업로드한 파일 ID입니다. */
    file_id?: string
    /** 이미지 분석 해상도입니다. 높을수록 정확하나 토큰을 더 씁니다. */
    detail?: 'auto' | 'low' | 'high'
  }

  interface OpenAiInputFileContent {
    type: 'input_file'
    /** 업로드한 파일 ID입니다. */
    file_id?: string
    /** 파일 URL입니다. */
    file_url?: string
    /** 파일 이름입니다. */
    filename?: string
  }

  type OpenAiInputContent = OpenAiInputTextContent | OpenAiInputImageContent | OpenAiInputFileContent | JsonObject

  interface OpenAiInputMessage {
    /** 발화자입니다. `developer`는 시스템 지시보다 우선하는 개발자 지시입니다. */
    role: 'user' | 'assistant' | 'system' | 'developer'
    /** 메시지 내용입니다. 문자열 또는 멀티모달 part 배열입니다. */
    content: string | OpenAiInputContent[]
  }

  type OpenAiInput = string | Array<OpenAiInputMessage | JsonObject>

  /** OpenAI Responses API 요청 옵션입니다. */
  interface OpenAiRequest extends AiRequestBase {
    /** 모델 이름입니다. (예: `gpt-4.1`, `gpt-4o-mini`, `o3`) */
    model: string
    /** 입력입니다. 문자열 하나 또는 메시지 배열입니다. 생략하면 `prompt`를 사용합니다. */
    input?: OpenAiInput
    /** true이면 응답을 백그라운드로 비동기 생성합니다. 이후 조회로 결과를 받습니다. */
    background?: boolean
    /** 이 응답을 이어붙일 대화(conversation) 리소스입니다. */
    conversation?: string | JsonObject
    /** 응답에 추가로 포함할 데이터입니다. (예: logprobs, 추론 내용) */
    include?: string[]
    /** 시스템/개발자 지시입니다. 모델의 역할·규칙을 고정합니다. */
    instructions?: string
    /** 생성할 최대 출력 토큰 수입니다. (추론 토큰 포함) */
    max_output_tokens?: number
    /** 한 응답에서 허용할 최대 도구 호출 횟수입니다. */
    max_tool_calls?: number
    /** 도구를 병렬로 호출하도록 허용할지 여부입니다. */
    parallel_tool_calls?: boolean
    /** 이전 응답 ID입니다. 멀티턴 대화를 이어갈 때 씁니다. */
    previous_response_id?: string
    /** 프롬프트 캐시 키입니다. 같은 접두 컨텍스트 재사용 시 비용·지연을 줄입니다. */
    prompt_cache_key?: string
    /** 추론 모델의 사고 강도 등을 설정합니다. */
    reasoning?: OpenAiReasoning
    /** 정책 위반 사용자 식별용 안정 식별자입니다. (개인정보가 아닌 해시 권장) */
    safety_identifier?: string
    /** 처리 등급입니다. 비용·지연·처리량 트레이드오프를 선택합니다. */
    service_tier?: OpenAiServiceTier
    /** 텍스트 응답 형식·상세도 설정입니다. JSON 출력도 여기서 지정합니다. */
    text?: OpenAiTextConfig
    /** `json: true`일 때 구조를 강제할 json_schema 설정입니다. 생략하면 json_object를 사용합니다. */
    jsonSchema?: OpenAiJsonSchema
    /** 도구 호출 방식입니다. `required`는 반드시 도구를 쓰게 강제합니다. */
    tool_choice?: 'none' | 'auto' | 'required' | JsonObject
    /** 모델이 호출할 수 있는 도구(function/웹검색 등) 목록입니다. */
    tools?: any[]
    /** 무작위성입니다. 0에 가까울수록 결정적입니다. (0.0~2.0) */
    temperature?: number
    /** 각 위치에서 반환할 상위 logprobs 개수입니다. */
    top_logprobs?: number
    /** nucleus 샘플링 값입니다. temperature와 함께 쓰지 않는 것을 권장합니다. */
    top_p?: number
    /** 컨텍스트 초과 시 처리 방식입니다. */
    truncation?: OpenAiTruncation
    /** @deprecated `safety_identifier`와 `prompt_cache_key`로 대체됩니다. 캐싱 유지에는 `prompt_cache_key`를 쓰세요. */
    user?: string
    /** 응답에 부착할 임의 key-value 메타데이터입니다. */
    metadata?: JsonObject
    /** 응답을 서버에 저장할지 여부입니다. `previous_response_id` 이어가기에 필요합니다. */
    store?: boolean
  }

  /** 메시지 발화자입니다. `tool`은 도구 실행 결과 메시지입니다. */
  type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool'
  /** 추론 강도입니다. 높을수록 깊게 사고하지만 느리고 비쌉니다. */
  type DeepSeekReasoningEffort = 'low' | 'high' | 'max'

  interface DeepSeekMessage {
    /** 발화자입니다. */
    role: DeepSeekRole
    /** 메시지 본문입니다. */
    content?: string | null
    /** 참여자 이름입니다. (선택) */
    name?: string
    /** `tool` 역할 메시지가 응답하는 도구 호출 ID입니다. */
    tool_call_id?: string
    /** assistant가 요청한 도구 호출 목록입니다. */
    tool_calls?: any[]
    /** true이면 이 assistant 메시지를 이어서 완성하게 합니다. (prefix completion, beta — `baseUrl`을 `/beta`로 지정 필요) */
    prefix?: boolean
    /** 추론 모델의 사고 과정(chain-of-thought) 텍스트입니다. prefix 이어쓰기에 쓸 땐 `prefix: true`가 필요합니다. */
    reasoning_content?: string | null
  }

  interface DeepSeekThinking {
    /** 추론(thinking) 모드 활성화 여부입니다. */
    type?: 'enabled' | 'disabled'
  }

  interface DeepSeekResponseFormat {
    /** JSON 출력 모드입니다. 유효한 JSON 생성을 보장합니다. */
    type: 'json_object'
  }

  /** DeepSeek Chat Completions 요청 옵션입니다. */
  interface DeepSeekRequest extends AiRequestBase {
    /** 모델 이름입니다. (예: `deepseek-chat`, `deepseek-reasoner`) */
    model: string
    /** 대화 메시지 목록입니다. 생략하면 `instructions`/`input`/`prompt`로 구성합니다. */
    messages?: DeepSeekMessage[]
    /** 추론(thinking) 모드 설정입니다. */
    thinking?: DeepSeekThinking | null
    /** 추론 강도입니다. */
    reasoning_effort?: DeepSeekReasoningEffort
    /** 생성할 최대 토큰 수입니다. */
    max_tokens?: number
    /** 응답 형식입니다. JSON 출력은 `{ type: 'json_object' }`를 지정합니다. */
    response_format?: DeepSeekResponseFormat
    /** 생성을 멈출 문자열 또는 문자열 목록입니다. (최대 16개) */
    stop?: string | string[]
    /** 무작위성입니다. 0에 가까울수록 결정적입니다. (0~2, 기본 1) */
    temperature?: number
    /** nucleus 샘플링 값입니다. (0~1, 기본 1) */
    top_p?: number
    /** 모델이 호출할 수 있는 도구(function calling) 목록입니다. */
    tools?: any[]
    /** 도구 호출 방식입니다. */
    tool_choice?: 'none' | 'auto' | 'required' | JsonObject
    /** 출력 토큰의 logprobs를 반환할지 여부입니다. */
    logprobs?: boolean
    /** 각 위치에서 반환할 상위 logprobs 개수입니다. `logprobs: true`가 필요합니다. (0~20) */
    top_logprobs?: number
    /** 남용 탐지용 최종 사용자 식별자입니다. (최대 512자) */
    user_id?: string
  }

  /** AI provider 호출 결과입니다. 실패해도 throw 대신 이 객체로 반환합니다. */
  interface AiResult {
    /** HTTP 성공, provider 응답 파싱, 텍스트 추출, JSON mode 파싱까지 성공했는지 여부입니다. */
    ok: boolean
    /** 호출한 provider입니다. */
    provider: AiProvider
    /** provider HTTP status code입니다. 전송 실패면 0입니다. */
    statusCode: number
    /** provider 원본 JSON 응답입니다. */
    responseJson: Record<string, any>
    /** provider 응답에서 추출한 텍스트입니다. */
    text: string
    /** `json: true` 요청에서 모델 응답 텍스트를 파싱한 값입니다. 파싱 실패나 일반 요청이면 null입니다. */
    json: any
    /** 실패 사유 문자열입니다. 성공하면 빈 문자열입니다. */
    errorMessage: string
    /** 429 응답이 rate limit인지 quota/billing 문제인지 추정한 값입니다. */
    rateLimitCause: AiRateLimitCause
  }

  /** provider별 호출 함수를 가진 PocketBase JSVM용 AI 클라이언트입니다. */
  interface AiClient {
    /** Gemini generateContent API를 호출합니다. */
    gemini(request: GeminiRequest): AiResult
    /** OpenAI Responses API를 호출합니다. */
    openai(request: OpenAiRequest): AiResult
    /** DeepSeek Chat Completions API를 호출합니다. */
    deepseek(request: DeepSeekRequest): AiResult
  }
}

declare const pocketpagesAi: {
  /** PocketBase JSVM용 AI 클라이언트를 만듭니다. */
  createAiClient(options?: pocketpagesAi.AiClientOptions): pocketpagesAi.AiClient
}

export = pocketpagesAi
