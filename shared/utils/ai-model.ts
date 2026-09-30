import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai'
import type { LanguageModelV1, LanguageModelV1Middleware } from 'ai'
import type { ConfigAi, ConfigAiProvider } from '../types/config'

export function isAiApiKeyRequired(provider: ConfigAiProvider) {
  return provider !== 'ollama' && provider !== 'litellm'
}

export function getLanguageModel(config: ConfigAi) {
  const apiBase = getApiBase(config)
  let model: LanguageModelV1

  if (config.provider === 'openrouter') {
    const openRouter = createOpenRouter({
      apiKey: config.apiKey,
      baseURL: apiBase,
      fetch: config.fetch,
      // lit-storm: the model's reasoning setting, sent with every request.
      extraBody: config.extraBody,
    })
    model = openRouter(config.model, {
      includeReasoning: true,
    })
  } else if (
    config.provider === 'deepseek' ||
    config.provider === 'siliconflow' ||
    config.provider === 'infiniai' ||
    // Special case if model name includes 'deepseek'
    // This ensures compatibilty with providers like Siliconflow
    config.model?.toLowerCase().includes('deepseek')
  ) {
    const deepSeek = createDeepSeek({
      apiKey: config.apiKey,
      baseURL: apiBase,
      fetch: config.fetch,
    })
    model = deepSeek(config.model)
  } else {
    const openai = createOpenAI({
      apiKey: config.apiKey,
      baseURL: apiBase,
      fetch: config.fetch,
    })
    model = openai(config.model)
  }

  const wrapped = wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  })
  return config.onUsage ? wrapLanguageModel({ model: wrapped, middleware: usageMiddleware(config.onUsage) }) : wrapped
}

/**
 * Report each call's tokens as it finishes (lit-storm counts a Run's cost
 * from them). Streams carry them on their "finish" part.
 */
function usageMiddleware(onUsage: NonNullable<ConfigAi['onUsage']>): LanguageModelV1Middleware {
  return {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate()
      onUsage({ promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens })
      return result
    },
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream()
      const counted = stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'finish') {
              onUsage({ promptTokens: part.usage.promptTokens, completionTokens: part.usage.completionTokens })
            }
            controller.enqueue(part)
          },
        }),
      )
      return { stream: counted, ...rest }
    },
  }
}

export function getApiBase(config: ConfigAi) {
  if (config.provider === 'openrouter') {
    return config.apiBase || 'https://openrouter.ai/api/v1'
  }
  if (config.provider === 'requesty') {
    return config.apiBase || 'https://router.requesty.ai/v1'
  }
  if (config.provider === 'deepseek') {
    return config.apiBase || 'https://api.deepseek.com/v1'
  }
  if (config.provider === 'ollama') {
    return config.apiBase || 'http://localhost:11434/v1'
  }
  if (config.provider === 'siliconflow') {
    return config.apiBase || 'https://api.siliconflow.cn/v1'
  }
  if (config.provider === 'infiniai') {
    return config.apiBase || 'https://cloud.infini-ai.com/maas/v1'
  }
  if (config.provider === '302-ai') {
    return config.apiBase || 'https://api.302.ai/v1'
  }
  if (config.provider === 'litellm') {
    return config.apiBase || 'http://localhost:4000/v1'
  }
  return config.apiBase || 'https://api.openai.com/v1'
}
