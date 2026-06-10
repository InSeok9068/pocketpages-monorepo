declare namespace pocketpagesAi {
  type AiProvider = 'gemini' | 'openai' | 'deepseek'
  type AiRateLimitCause = '' | 'rate-limit' | 'quota-or-billing-limit'
  type JsonObject = Record<string, any>

  interface AiClientOptions {
    timeoutSeconds?: number
    maxAttempts?: number
    geminiApiKey?: string
    openaiApiKey?: string
    deepseekApiKey?: string
  }

  interface AiRequestBase {
    apiKey?: string
    input?: unknown
    prompt?: string
    payload?: JsonObject
    baseUrl?: string
    timeoutSeconds?: number
    maxAttempts?: number
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

  interface AiResult {
    ok: boolean
    provider: AiProvider
    statusCode: number
    responseJson: Record<string, any>
    text: string
    errorMessage: string
    rateLimitCause: AiRateLimitCause
  }

  interface AiClient {
    gemini(request: GeminiRequest): AiResult
    openai(request: OpenAiRequest): AiResult
    deepseek(request: DeepSeekRequest): AiResult
  }
}

declare const pocketpagesAi: {
  createAiClient(options?: pocketpagesAi.AiClientOptions): pocketpagesAi.AiClient
}

export = pocketpagesAi
