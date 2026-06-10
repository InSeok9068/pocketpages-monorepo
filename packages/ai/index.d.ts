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

  type GeminiResponseMimeType = 'text/plain' | 'application/json' | 'text/x.enum'
  type GeminiContentRole = 'user' | 'model'

  interface GeminiTextPart {
    text: string
  }

  interface GeminiInlineDataPart {
    inlineData: {
      mimeType: string
      data: string
    }
  }

  interface GeminiFileDataPart {
    fileData: {
      mimeType?: string
      fileUri: string
    }
  }

  type GeminiPart = GeminiTextPart | GeminiInlineDataPart | GeminiFileDataPart | JsonObject

  interface GeminiContent {
    role?: GeminiContentRole
    parts: GeminiPart[]
  }

  interface GeminiGenerationConfig {
    stopSequences?: string[]
    responseMimeType?: GeminiResponseMimeType
    responseSchema?: JsonObject
    responseJsonSchema?: JsonObject
    responseModalities?: string[]
    candidateCount?: number
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    seed?: number
    presencePenalty?: number
    frequencyPenalty?: number
    responseLogprobs?: boolean
    logprobs?: number
    enableEnhancedCivicAnswers?: boolean
    speechConfig?: JsonObject
    thinkingConfig?: JsonObject
    imageConfig?: JsonObject
    mediaResolution?: string
  }

  /** Gemini generateContent 요청 옵션입니다. */
  interface GeminiRequest extends AiRequestBase {
    model: string
    apiVersion?: string
    contents?: GeminiContent[]
    tools?: any[]
    toolConfig?: JsonObject
    generationConfig?: GeminiGenerationConfig
    safetySettings?: any[]
    systemInstruction?: GeminiContent
    cachedContent?: string
  }

  type OpenAiServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority'
  type OpenAiTruncation = 'auto' | 'disabled'
  type OpenAiVerbosity = 'low' | 'medium' | 'high'
  type OpenAiResponseFormat =
    | { type: 'text' }
    | { type: 'json_object' }
    | {
        type: 'json_schema'
        name: string
        schema: JsonObject
        description?: string
        strict?: boolean
      }

  interface OpenAiTextConfig {
    format?: OpenAiResponseFormat
    verbosity?: OpenAiVerbosity
  }

  interface OpenAiReasoning {
    effort?: 'minimal' | 'low' | 'medium' | 'high'
    summary?: 'auto' | 'concise' | 'detailed' | null
  }

  interface OpenAiInputTextContent {
    type: 'input_text'
    text: string
  }

  interface OpenAiInputImageContent {
    type: 'input_image'
    image_url?: string
    file_id?: string
    detail?: 'auto' | 'low' | 'high'
  }

  interface OpenAiInputFileContent {
    type: 'input_file'
    file_id?: string
    file_url?: string
    filename?: string
  }

  type OpenAiInputContent =
    | OpenAiInputTextContent
    | OpenAiInputImageContent
    | OpenAiInputFileContent
    | JsonObject

  interface OpenAiInputMessage {
    role: 'user' | 'assistant' | 'system' | 'developer'
    content: string | OpenAiInputContent[]
  }

  type OpenAiInput = string | Array<OpenAiInputMessage | JsonObject>

  /** OpenAI Responses API 요청 옵션입니다. */
  interface OpenAiRequest extends AiRequestBase {
    model: string
    input?: OpenAiInput
    background?: boolean
    conversation?: string | JsonObject
    include?: string[]
    instructions?: string
    max_output_tokens?: number
    max_tool_calls?: number
    parallel_tool_calls?: boolean
    previous_response_id?: string
    prompt_cache_key?: string
    reasoning?: OpenAiReasoning
    safety_identifier?: string
    service_tier?: OpenAiServiceTier
    text?: OpenAiTextConfig
    tool_choice?: 'none' | 'auto' | 'required' | JsonObject
    tools?: any[]
    temperature?: number
    top_logprobs?: number
    top_p?: number
    truncation?: OpenAiTruncation
    user?: string
    metadata?: JsonObject
    store?: boolean
  }

  type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool'
  type DeepSeekReasoningEffort = 'high' | 'max'

  interface DeepSeekMessage {
    role: DeepSeekRole
    content?: string | null
    name?: string
    tool_call_id?: string
    tool_calls?: any[]
    prefix?: boolean
    reasoning_content?: string | null
  }

  interface DeepSeekThinking {
    type?: 'enabled' | 'disabled'
  }

  interface DeepSeekResponseFormat {
    type: 'json_object'
  }

  /** DeepSeek Chat Completions 요청 옵션입니다. */
  interface DeepSeekRequest extends AiRequestBase {
    model: string
    messages?: DeepSeekMessage[]
    thinking?: DeepSeekThinking | null
    reasoning_effort?: DeepSeekReasoningEffort
    max_tokens?: number
    response_format?: DeepSeekResponseFormat
    stop?: string | string[]
    temperature?: number
    top_p?: number
    tools?: any[]
    tool_choice?: 'none' | 'auto' | 'required' | JsonObject
    logprobs?: boolean
    top_logprobs?: number
    user_id?: string
  }

  /** AI provider 호출 결과입니다. 실패해도 throw 대신 이 객체로 반환합니다. */
  interface AiResult {
    /** HTTP 성공, provider 응답 파싱, 텍스트 추출까지 성공했는지 여부입니다. */
    ok: boolean
    /** 호출한 provider입니다. */
    provider: AiProvider
    /** provider HTTP status code입니다. 전송 실패면 0입니다. */
    statusCode: number
    /** provider 원본 JSON 응답입니다. */
    responseJson: Record<string, any>
    /** provider 응답에서 추출한 텍스트입니다. */
    text: string
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
