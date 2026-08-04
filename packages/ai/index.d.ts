declare namespace pocketpagesAi {
  type AiProvider = 'gemini' | 'openai' | 'deepseek'
  type AiRateLimitCause = '' | 'rate-limit' | 'quota-or-billing-limit'
  type JsonObject = Record<string, any>

  /** AI 클라이언트 공통 옵션입니다. API 키를 생략하면 provider별 환경 변수를 사용합니다. */
  interface AiClientOptions {
    /** 요청 제한 시간입니다. 생략하면 패키지 내부 기본값을 사용합니다. */
    timeoutSeconds?: number

    /**
     * 최대 시도 횟수입니다.
     * 재시도 가능한 rate limit과 일시적 전송 오류에 적용하며,
     * quota 또는 billing 제한에는 일반적으로 재시도하지 않습니다.
     */
    maxAttempts?: number

    /** Gemini API 키입니다. 생략하면 `GEMINI_API_KEY` 또는 `GEMINI_AI_KEY`를 사용합니다. */
    geminiApiKey?: string

    /** OpenAI API 키입니다. 생략하면 `OPENAI_API_KEY`를 사용합니다. */
    openaiApiKey?: string

    /** DeepSeek API 키입니다. 생략하면 `DEEPSEEK_API_KEY`를 사용합니다. */
    deepseekApiKey?: string
  }

  /** provider별 요청에서 공통으로 사용할 수 있는 옵션입니다. */
  interface AiRequestBase {
    /** 요청 단위 API 키입니다. 클라이언트 옵션과 환경 변수보다 우선합니다. */
    apiKey?: string

    /** 간단 호출용 입력값입니다. provider별 요청 본문이 없을 때 사용합니다. */
    input?: unknown

    /** 간단 호출용 prompt 문자열입니다. provider별 요청 본문이 없을 때 사용합니다. */
    prompt?: string

    /** provider 원본 요청 본문을 직접 전달할 때 사용합니다. */
    payload?: JsonObject

    /** provider 기본 URL을 변경해야 할 때 사용합니다. */
    baseUrl?: string

    /** 요청 단위 제한 시간입니다. 클라이언트 공통 설정보다 우선합니다. */
    timeoutSeconds?: number

    /** 요청 단위 최대 시도 횟수입니다. 클라이언트 공통 설정보다 우선합니다. */
    maxAttempts?: number

    /** true이면 간단 호출 결과를 JSON 형식으로 요청하고 응답 텍스트를 파싱합니다. */
    json?: boolean
  }

  /**
   * Gemini 응답 MIME 타입입니다.
   * `application/json`은 JSON, `text/x.enum`은 enum 값 하나를 요청합니다.
   */
  type GeminiResponseMimeType = 'text/plain' | 'application/json' | 'text/x.enum'

  /**
   * Gemini content 발화자입니다.
   * `user`는 사용자 입력, `model`은 모델 응답입니다.
   */
  type GeminiContentRole = 'user' | 'model'

  interface GeminiTextPart {
    /** 텍스트 본문입니다. */
    text: string
  }

  interface GeminiInlineDataPart {
    /** base64로 인코딩한 인라인 바이너리 데이터입니다. 예: 이미지, 오디오. */
    inlineData: {
      /** 데이터의 MIME 타입입니다. 예: `image/png`. */
      mimeType: string

      /** base64로 인코딩한 데이터 문자열입니다. */
      data: string
    }
  }

  interface GeminiFileDataPart {
    /** Gemini File API 등으로 업로드한 파일을 URI로 참조합니다. */
    fileData: {
      /** 파일의 MIME 타입입니다. */
      mimeType?: string

      /** 업로드된 파일의 URI입니다. */
      fileUri: string
    }
  }

  /** 알려진 Gemini part 타입 외의 provider 확장 필드도 허용합니다. */
  type GeminiPart = GeminiTextPart | GeminiInlineDataPart | GeminiFileDataPart | JsonObject

  interface GeminiContent {
    /** 발화자입니다. 단일 턴 요청에서는 생략할 수 있습니다. */
    role?: GeminiContentRole

    /**
     * 메시지를 구성하는 part 목록입니다.
     * 텍스트·이미지·파일 등을 함께 전달할 수 있습니다.
     */
    parts: GeminiPart[]
  }

  interface GeminiGenerationConfig {
    /** 생성을 중지할 문자열 목록입니다. 최대 5개입니다. */
    stopSequences?: string[]

    /** 응답 MIME 타입입니다. JSON 출력은 `application/json`을 지정합니다. */
    responseMimeType?: GeminiResponseMimeType

    /**
     * @deprecated 새 코드에서는 `responseJsonSchema` 사용을 권장합니다.
     * OpenAPI Schema 하위 집합으로 응답 구조를 지정하며,
     * 호환되는 `responseMimeType`과 함께 사용해야 합니다.
     */
    responseSchema?: JsonObject

    /**
     * JSON Schema로 응답 구조를 지정합니다.
     * `responseSchema`와 동시에 사용할 수 없으며,
     * 일반적으로 `responseMimeType: 'application/json'`과 함께 사용합니다.
     */
    responseJsonSchema?: JsonObject

    /**
     * 응답에 포함할 모달리티입니다.
     * 예: `TEXT`, `IMAGE`.
     * 모델별 지원 여부가 다릅니다.
     */
    responseModalities?: string[]

    /** 생성할 응답 후보 개수입니다. 모델별 지원 여부가 다릅니다. */
    candidateCount?: number

    /** 응답에서 생성할 최대 토큰 수입니다. */
    maxOutputTokens?: number

    /**
     * 무작위성입니다.
     * 0에 가까울수록 결정적이고 높을수록 다양해집니다.
     * 지원 범위는 모델별로 다를 수 있습니다.
     */
    temperature?: number

    /** 누적 확률 기반 nucleus sampling 값입니다. */
    topP?: number

    /**
     * 상위 K개 토큰만 후보로 삼습니다.
     * 일부 모델은 이 값을 지원하지 않을 수 있습니다.
     */
    topK?: number

    /**
     * 재현성을 위한 디코딩 시드입니다.
     * 같은 시드가 완전히 동일한 출력을 보장하지는 않습니다.
     */
    seed?: number

    /**
     * 이미 등장한 토큰에 적용하는 존재 페널티입니다.
     * 지원 범위는 모델별로 다를 수 있습니다.
     */
    presencePenalty?: number

    /**
     * 사용 횟수에 비례해 적용하는 빈도 페널티입니다.
     * 양수는 반복 억제, 음수는 반복 유도에 사용됩니다.
     */
    frequencyPenalty?: number

    /** 응답 토큰의 log probabilities를 반환할지 여부입니다. */
    responseLogprobs?: boolean

    /** 각 위치에서 반환할 상위 log probabilities 개수입니다. */
    logprobs?: number

    /**
     * 시민·정치 관련 질의에 대한 향상된 답변 기능을 활성화합니다.
     * 지원 모델과 지역이 제한될 수 있습니다.
     */
    enableEnhancedCivicAnswers?: boolean

    /** TTS 음성 출력 설정입니다. */
    speechConfig?: JsonObject

    /**
     * 추론(thinking) 예산이나 활성화 방식 등을 설정합니다.
     * 지원 형식은 모델별로 다릅니다.
     */
    thinkingConfig?: JsonObject

    /**
     * 이미지 생성 설정입니다.
     * 이미지 출력을 지원하는 모델에서만 사용할 수 있습니다.
     */
    imageConfig?: JsonObject

    /**
     * 입력 미디어 처리 해상도입니다.
     * 지원 값은 모델별로 다릅니다.
     */
    mediaResolution?: string
  }

  /** Gemini `generateContent` 요청 옵션입니다. */
  interface GeminiRequest extends AiRequestBase {
    /** 모델 이름입니다. 예: `gemini-2.5-flash`, `gemini-2.5-pro`. */
    model: string

    /**
     * API 버전입니다.
     * 생략하면 패키지 내부 기본값인 `v1beta`를 사용합니다.
     */
    apiVersion?: string

    /**
     * 대화 내용입니다.
     * 생략하면 `input` 또는 `prompt`로 단일 텍스트 턴을 구성합니다.
     */
    contents?: GeminiContent[]

    /** 모델이 호출할 수 있는 함수(function calling) 등의 도구 목록입니다. */
    tools?: any[]

    /** 도구 호출 방식과 function calling 동작을 제어합니다. */
    toolConfig?: JsonObject

    /** temperature, JSON Schema, thinking 등의 생성 파라미터입니다. */
    generationConfig?: GeminiGenerationConfig

    /** 유해 콘텐츠 차단 기준입니다. 카테고리별 임계값을 설정합니다. */
    safetySettings?: any[]

    /** 시스템 지시입니다. 모델의 역할과 응답 규칙을 지정할 때 사용합니다. */
    systemInstruction?: GeminiContent

    /**
     * 컨텍스트 캐시 리소스 이름입니다.
     * 긴 공통 컨텍스트를 재사용할 때 사용합니다.
     */
    cachedContent?: string
  }

  /**
   * OpenAI 요청 처리 등급입니다.
   * 사용 가능 여부는 계정과 모델에 따라 다릅니다.
   */
  type OpenAiServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority'

  /**
   * 컨텍스트 초과 시 처리 방식입니다.
   * `auto`는 일부 입력을 잘라내고, `disabled`는 오류를 반환합니다.
   */
  type OpenAiTruncation = 'auto' | 'disabled'

  /** 응답 상세도입니다. 낮을수록 간결한 답변을 유도합니다. */
  type OpenAiVerbosity = 'low' | 'medium' | 'high'

  /**
   * OpenAI 추론 노력 수준입니다.
   * 실제 지원 값과 기본값은 모델별로 다릅니다.
   */
  type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

  /** OpenAI Responses API의 텍스트 응답 형식입니다. */
  type OpenAiResponseFormat =
    | {
        type: 'text'
      }
    | {
        type: 'json_object'
      }
    | {
        type: 'json_schema'

        /** JSON Schema 형식의 이름입니다. */
        name: string

        /** JSON Schema 본문입니다. */
        schema: JsonObject

        /** 스키마 설명입니다. */
        description?: string

        /**
         * 지원되는 스키마 범위 안에서
         * 엄격한 준수를 요청할지 여부입니다.
         */
        strict?: boolean
      }

  interface OpenAiTextConfig {
    /**
     * 텍스트 응답 형식입니다.
     * JSON mode 또는 Structured Outputs를 여기서 설정합니다.
     */
    format?: OpenAiResponseFormat

    /** 응답 상세도입니다. 지원 모델에서만 적용됩니다. */
    verbosity?: OpenAiVerbosity
  }

  /**
   * `json: true` 간편 호출에서 Structured Outputs를 구성할 때
   * 사용하는 JSON Schema 설정입니다.
   */
  interface OpenAiJsonSchema {
    /** 스키마 이름입니다. 생략하면 패키지 내부 기본값을 사용합니다. */
    name?: string

    /** JSON Schema 본문입니다. */
    schema: JsonObject

    /**
     * 스키마 준수를 엄격히 요청할지 여부입니다.
     * 생략하면 패키지 내부 기본값을 사용합니다.
     */
    strict?: boolean

    /** 스키마 설명입니다. */
    description?: string
  }

  /** OpenAI 추론 모델의 reasoning 설정입니다. */
  interface OpenAiReasoning {
    /**
     * 추론 노력 수준입니다.
     * 지원 값과 기본값은 모델마다 다르며
     * 일부 모델은 특정 값만 허용합니다.
     */
    effort?: OpenAiReasoningEffort

    /** 추론 요약 생성 방식입니다. 지원 여부는 모델별로 다릅니다. */
    summary?: 'auto' | 'concise' | 'detailed' | null
  }

  interface OpenAiInputTextContent {
    type: 'input_text'

    /** 입력 텍스트입니다. */
    text: string
  }

  interface OpenAiInputImageContent {
    type: 'input_image'

    /** 이미지 URL입니다. base64 data URL도 사용할 수 있습니다. */
    image_url?: string

    /** OpenAI Files API로 업로드한 파일 ID입니다. */
    file_id?: string

    /**
     * 이미지 분석 상세도입니다.
     * 높을수록 더 많은 입력 토큰을 사용할 수 있습니다.
     */
    detail?: 'auto' | 'low' | 'high'
  }

  interface OpenAiInputFileContent {
    type: 'input_file'

    /** 직접 전달할 파일 데이터입니다. provider가 요구하는 문자열 형식을 사용합니다. */
    file_data?: string

    /** OpenAI Files API로 업로드한 파일 ID입니다. */
    file_id?: string

    /** 모델이 접근할 수 있는 파일 URL입니다. */
    file_url?: string

    /** 직접 전달한 파일 데이터의 파일 이름입니다. */
    filename?: string
  }

  /** 알려진 OpenAI 입력 content 타입 외의 Responses API 입력 항목도 허용합니다. */
  type OpenAiInputContent = OpenAiInputTextContent | OpenAiInputImageContent | OpenAiInputFileContent | JsonObject

  interface OpenAiInputMessage {
    /**
     * 메시지 발화자입니다.
     * `developer`와 `system` 지시는
     * `user` 지시보다 높은 우선순위를 가집니다.
     */
    role: 'user' | 'assistant' | 'system' | 'developer'

    /**
     * 메시지 내용입니다.
     * 문자열 또는 멀티모달 content 배열을 전달할 수 있습니다.
     */
    content: string | OpenAiInputContent[]
  }

  type OpenAiInput = string | Array<OpenAiInputMessage | JsonObject>

  /** OpenAI Responses API 요청 옵션입니다. */
  interface OpenAiRequest extends AiRequestBase {
    /**
     * 모델 이름입니다.
     * 모델별 지원 파라미터가 다르므로
     * 공식 모델 목록을 기준으로 선택합니다.
     */
    model: string

    /**
     * 입력입니다.
     * 문자열 하나 또는 메시지·입력 항목 배열입니다.
     * 생략하면 `prompt`를 사용합니다.
     */
    input?: OpenAiInput

    /**
     * true이면 응답 생성을 백그라운드에서 실행합니다.
     * 최초 응답은 `in_progress` 상태일 수 있으므로
     * 이후 응답 조회 흐름이 필요합니다.
     */
    background?: boolean

    /**
     * 이 응답을 연결할 conversation 리소스입니다.
     * `previous_response_id`와 동시에 사용할 수 없습니다.
     */
    conversation?: string | JsonObject

    /**
     * 응답에 추가로 포함할 provider 데이터를 지정합니다.
     * 예: logprobs, reasoning encrypted content.
     */
    include?: string[]

    /** 시스템 또는 개발자 지시입니다. 모델의 역할과 응답 규칙을 지정합니다. */
    instructions?: string

    /**
     * 생성 가능한 최대 출력 토큰 수입니다.
     * 표시되는 출력 토큰과 추론 토큰을 포함합니다.
     */
    max_output_tokens?: number

    /**
     * 한 응답에서 처리할 수 있는 내장 도구 호출의 최대 총횟수입니다.
     * 개별 도구별 제한이 아니라
     * 모든 내장 도구 호출에 합산 적용됩니다.
     */
    max_tool_calls?: number

    /** 여러 도구 호출을 병렬로 생성하도록 허용할지 여부입니다. */
    parallel_tool_calls?: boolean

    /**
     * 이전 응답 ID입니다.
     * 멀티턴 대화를 이어갈 때 사용합니다.
     *
     * `conversation`과 동시에 사용할 수 없으며
     * 이전 응답의 `instructions`는 자동 승계되지 않습니다.
     */
    previous_response_id?: string

    /**
     * 프롬프트 캐시 키입니다.
     * 같은 접두 컨텍스트를 재사용할 때
     * 캐시 적중률을 높이는 데 사용합니다.
     */
    prompt_cache_key?: string

    /** 추론 모델의 노력 수준과 추론 요약 방식을 설정합니다. */
    reasoning?: OpenAiReasoning

    /**
     * 정책 위반 가능성이 있는 최종 사용자를 식별하기 위한 안정적인 값입니다.
     * 개인정보 원문보다 해시 사용을 권장합니다.
     */
    safety_identifier?: string

    /** 비용·지연·처리량 간의 트레이드오프를 선택하는 처리 등급입니다. */
    service_tier?: OpenAiServiceTier

    /** 텍스트 응답 형식과 상세도를 설정합니다. JSON 출력도 여기서 지정합니다. */
    text?: OpenAiTextConfig

    /**
     * `json: true` 간편 호출에서 구조를 강제할 JSON Schema입니다.
     * 생략하면 패키지 구현에 따라 JSON object mode를 사용할 수 있습니다.
     */
    jsonSchema?: OpenAiJsonSchema

    /**
     * 도구 호출 방식입니다.
     * `required`는 모델이 하나 이상의 도구를 호출하도록 요청합니다.
     */
    tool_choice?: 'none' | 'auto' | 'required' | JsonObject

    /** 모델이 호출할 수 있는 function, web search 등의 도구 목록입니다. */
    tools?: any[]

    /** 무작위성입니다. 지원 범위와 적용 여부는 모델별로 다릅니다. */
    temperature?: number

    /**
     * 각 위치에서 반환할 상위 log probabilities 개수입니다.
     * 관련 logprobs 포함 설정이 필요할 수 있습니다.
     */
    top_logprobs?: number

    /**
     * nucleus sampling 값입니다.
     * 일반적으로 `temperature`와 둘 중 하나만 조정하는 것을 권장합니다.
     */
    top_p?: number

    /** 컨텍스트 한도를 초과했을 때의 처리 방식입니다. */
    truncation?: OpenAiTruncation

    /** @deprecated `safety_identifier`와 `prompt_cache_key`로 대체됩니다. */
    user?: string

    /** 응답에 부착할 임의 key-value 메타데이터입니다. */
    metadata?: JsonObject

    /**
     * 응답을 OpenAI에 저장할지 여부입니다.
     * 이후 조회나 상태 관리가 필요하면 저장 정책을 함께 확인해야 합니다.
     */
    store?: boolean
  }

  /**
   * DeepSeek 메시지 발화자입니다.
   * `tool`은 도구 실행 결과 메시지입니다.
   */
  type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool'

  /** DeepSeek thinking 모드의 공식 추론 강도입니다. 기본값은 `high`이며 `medium`/`xhigh`는 `high`로 매핑됩니다. */
  type DeepSeekReasoningEffort = 'low' | 'high' | 'max'

  interface DeepSeekMessage {
    /** 메시지 발화자입니다. */
    role: DeepSeekRole

    /** 메시지 본문입니다. 역할에 따라 필수 여부가 달라질 수 있습니다. */
    content?: string | null

    /** 같은 역할의 참여자를 구분하기 위한 선택적 이름입니다. */
    name?: string

    /** `tool` 역할 메시지가 응답하는 도구 호출 ID입니다. */
    tool_call_id?: string

    /** assistant가 요청한 도구 호출 목록입니다. */
    tool_calls?: any[]

    /**
     * true이면 마지막 assistant 메시지의 content를 접두사로 사용해
     * 응답을 이어서 생성합니다.
     *
     * beta 기능이며 `baseUrl`에 `/beta` 엔드포인트가 필요합니다.
     */
    prefix?: boolean

    /**
     * thinking 모드에서 반환된 추론 내용입니다.
     * prefix completion에 입력으로 사용할 때는
     * 마지막 assistant 메시지에 `prefix: true`가 필요합니다.
     */
    reasoning_content?: string | null
  }

  interface DeepSeekThinking {
    /** thinking 모드 활성화 여부입니다. 현재 기본값은 `enabled`입니다. */
    type?: 'enabled' | 'disabled'
  }

  interface DeepSeekResponseFormat {
    /** JSON object mode입니다. 모델이 유효한 JSON 객체를 출력하도록 요청합니다. */
    type: 'json_object'
  }

  /** DeepSeek Chat Completions 요청 옵션입니다. */
  interface DeepSeekRequest extends AiRequestBase {
    /** 모델 이름입니다. 예: `deepseek-v4-flash`, `deepseek-v4-pro`. */
    model: string

    /**
     * 대화 메시지 목록입니다.
     * 생략하면 패키지가 `input` 또는 `prompt`로 메시지를 구성합니다.
     */
    messages?: DeepSeekMessage[]

    /** thinking 모드 설정입니다. 현재 기본값은 `enabled`입니다. */
    thinking?: DeepSeekThinking | null

    /**
     * thinking 모드의 추론 강도입니다.
     * 공식 값은 `low`, `high`, `max`이며 기본값은 `high`입니다.
     * 호환을 위해 `medium`과 `xhigh`는 `high`로 매핑됩니다.
     */
    reasoning_effort?: DeepSeekReasoningEffort

    /**
     * 생성할 최대 토큰 수입니다.
     * 입력과 출력의 합은 모델 컨텍스트 한도를 넘을 수 없습니다.
     */
    max_tokens?: number

    /** 응답 형식입니다. JSON 출력은 `{ type: 'json_object' }`를 지정합니다. */
    response_format?: DeepSeekResponseFormat

    /** 생성을 중지할 문자열 또는 문자열 목록입니다. 최대 16개입니다. */
    stop?: string | string[]

    /**
     * 무작위성입니다.
     * 일반적으로 `top_p`와 둘 중 하나만 조정합니다.
     * thinking 모드에서는 전달해도 적용되지 않습니다.
     */
    temperature?: number

    /**
     * nucleus sampling 값입니다.
     * 일반적으로 `temperature`와 둘 중 하나만 조정합니다.
     * thinking 모드에서는 전달해도 적용되지 않습니다.
     */
    top_p?: number

    /** 모델이 호출할 수 있는 function 도구 목록입니다. */
    tools?: any[]

    /** 도구 호출 방식입니다. */
    tool_choice?: 'none' | 'auto' | 'required' | JsonObject

    /** 출력 토큰의 log probabilities를 반환할지 여부입니다. */
    logprobs?: boolean

    /**
     * 각 위치에서 반환할 상위 log probabilities 개수입니다.
     * `logprobs: true`가 필요합니다.
     */
    top_logprobs?: number

    /** 남용 탐지에 사용할 최종 사용자 식별자입니다. 최대 512자입니다. */
    user_id?: string
  }

  /** AI provider 호출 결과입니다. 실패 시에도 예외 대신 이 객체로 반환합니다. */
  interface AiResult {
    /**
     * HTTP 성공, provider 응답 파싱, 텍스트 추출 및
     * JSON mode 파싱까지 성공했는지 여부입니다.
     *
     * 백그라운드 실행처럼 아직 완료되지 않은 응답은
     * HTTP가 성공해도 false일 수 있습니다.
     */
    ok: boolean

    /** 호출한 provider입니다. */
    provider: AiProvider

    /** provider HTTP 상태 코드입니다. 전송 단계에서 실패하면 0입니다. */
    statusCode: number

    /**
     * provider 원본 JSON 응답입니다.
     * 전송 또는 JSON 파싱 실패 시 빈 객체일 수 있습니다.
     */
    responseJson: Record<string, any>

    /**
     * provider 응답에서 추출한 최종 텍스트입니다.
     * 추출할 텍스트가 없으면 빈 문자열입니다.
     */
    text: string

    /**
     * `json: true` 요청에서 응답 텍스트를 파싱한 값입니다.
     * 파싱 실패 또는 일반 요청이면 null입니다.
     */
    json: any

    /** 실패 사유입니다. 성공하면 빈 문자열입니다. */
    errorMessage: string

    /**
     * 429 응답이 일시적 rate limit인지
     * quota 또는 billing 제한인지 추정한 값입니다.
     */
    rateLimitCause: AiRateLimitCause
  }

  /** provider별 호출 함수를 제공하는 PocketBase JSVM용 AI 클라이언트입니다. */
  interface AiClient {
    /** Gemini `generateContent` API를 호출합니다. */
    gemini(request: GeminiRequest): AiResult

    /** OpenAI Responses API를 호출합니다. */
    openai(request: OpenAiRequest): AiResult

    /** DeepSeek Chat Completions API를 호출합니다. */
    deepseek(request: DeepSeekRequest): AiResult
  }
}

declare const pocketpagesAi: {
  /** PocketBase JSVM용 AI 클라이언트를 생성합니다. */
  createAiClient(options?: pocketpagesAi.AiClientOptions): pocketpagesAi.AiClient
}

export = pocketpagesAi
