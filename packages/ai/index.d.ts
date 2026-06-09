declare namespace pocketpagesAi {
  type AiProvider = 'gemini' | 'openai' | 'deepseek'

  interface AiClientOptions {
    timeoutSeconds?: number
    maxAttempts?: number
    provider?: AiProvider
    geminiApiKey?: string
    openaiApiKey?: string
    deepseekApiKey?: string
    geminiModel?: string
    openaiModel?: string
    deepseekModel?: string
  }

  interface AiRequestBase {
    apiKey?: string
    model?: string
    input?: unknown
    prompt?: string
    payload?: Record<string, any>
    baseUrl?: string
    timeoutSeconds?: number
    maxAttempts?: number
    logMeta?: Record<string, any>
    json?: boolean
  }

  interface GeminiRequest extends AiRequestBase {
    apiVersion?: string
    contents?: any[]
    tools?: any[]
    toolConfig?: Record<string, any>
    generationConfig?: Record<string, any>
    safetySettings?: any[]
    systemInstruction?: Record<string, any>
    cachedContent?: string
  }

  interface OpenAiRequest extends AiRequestBase {
    background?: boolean
    conversation?: string | Record<string, any>
    include?: string[]
    instructions?: string
    max_output_tokens?: number
    max_tool_calls?: number
    parallel_tool_calls?: boolean
    previous_response_id?: string
    prompt_cache_key?: string
    reasoning?: Record<string, any>
    safety_identifier?: string
    service_tier?: string
    text?: Record<string, any>
    tool_choice?: unknown
    tools?: any[]
    temperature?: number
    top_logprobs?: number
    top_p?: number
    truncation?: string
    user?: string
    metadata?: Record<string, any>
    store?: boolean
  }

  interface DeepSeekRequest extends AiRequestBase {
    messages?: any[]
    thinking?: Record<string, any> | null
    reasoning_effort?: string
    max_tokens?: number
    response_format?: Record<string, any>
    stop?: string | string[]
    temperature?: number
    top_p?: number
    tools?: any[]
    tool_choice?: unknown
    logprobs?: boolean
    top_logprobs?: number
    user_id?: string
  }

  interface GenerateRequest extends GeminiRequest, OpenAiRequest, DeepSeekRequest {
    provider?: AiProvider
  }

  interface AiResult {
    ok: boolean
    provider: AiProvider
    statusCode: number
    responseBody: string
    responseJson: Record<string, any>
    text: string
    headers: Record<string, any>
    attempts: number
    elapsedMs: number
    transportError: string
    errorMessage: string
    rateLimitCause: string
  }

  interface AiClient {
    gemini(request: GeminiRequest): AiResult
    openai(request: OpenAiRequest): AiResult
    deepseek(request: DeepSeekRequest): AiResult
    generate(request: GenerateRequest): AiResult
  }
}

declare const pocketpagesAi: {
  createAiClient(options?: pocketpagesAi.AiClientOptions): pocketpagesAi.AiClient
}

export = pocketpagesAi
