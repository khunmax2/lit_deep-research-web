/**
 * Deep Research for lit-storm: one research run, as a process of its own.
 *
 * lit-storm (github.com/khunmax2/lit-storm) runs this as the subprocess of a
 * Run, instead of calling the Nuxt server: config arrives as one JSON line on
 * stdin, keys in this process's environment, and what happens goes out on
 * stdout as JSON lines. It calls lib/core directly, as the server does.
 *
 *   {"query": "...", "language": "th", "breadth": 3, "depth": 2,
 *    "gatherMs": 240000,
 *    "ai": {"provider": "openrouter", "model": "google/gemini-3.1-flash-lite", "extraBody": {...}},
 *    "search": {"provider": "searxng", "apiBase": "http://searxng:8080", "engines": "..."}}
 *
 * Keys: LITSTORM_AI_API_KEY, LITSTORM_SEARCH_API_KEY.
 *
 * Out, one object per line:
 *   {"type": "stage", "stage": "research" | "report"}
 *   {"type": "searched", "query", "urls": [...]}
 *   {"type": "usage", "promptTokens", "completionTokens"}   per model call
 *   {"type": "cut_short", "learnings": n}   research stopped at gatherMs
 *   {"type": "report_stream", "finishReason", "parts"}   how the report's stream ended
 *   {"type": "report", "markdown", "learnings": [{url, title, learning, excerpt}]}
 *   {"type": "error", "message"}   then exit 2
 *
 * Stopping: kill the process. It also exits when stdin closes, so it never
 * outlives the process that started it.
 */
import { deepResearch, writeFinalReport, type ResearchStep } from '~~/lib/core/deep-research'
import { createReadSource, searchWeb, type WebSearchFunction } from '~~/lib/core/web-search'
import type { ResearchLearning } from '~~/shared/types/research-session'
import type { ConfigAi, ConfigWebSearchProvider } from '~~/shared/types/config'
import pLimit from 'p-limit'
import { getLanguageModel } from '~~/shared/utils/ai-model'

// lib/core calls getLanguageModel without importing it: in the app, Nuxt
// provides it as a global (auto-import), and the tests replace that global.
// Outside Nuxt, provide it the same way.
;(globalThis as Record<string, unknown>).getLanguageModel = getLanguageModel

interface Input {
  query: string
  language: string
  breadth: number
  depth: number
  gatherMs?: number
  ai: { provider: ConfigAi['provider']; model: string; apiBase?: string; contextSize?: number; extraBody?: Record<string, unknown> }
  search: { provider: ConfigWebSearchProvider; apiBase?: string; engines?: string }
}

const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + '\n')

function readInput(): Promise<Input> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let done = false
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      if (done) return
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        done = true
        try {
          resolve(JSON.parse(buffer.slice(0, newline)))
        } catch (error) {
          reject(error)
        }
      }
    })
    // The parent went away: nobody is left to read what this would write.
    process.stdin.on('end', () => (done ? process.exit(3) : reject(new Error('no input on stdin'))))
  })
}

async function main() {
  const input = await readInput()
  const aiConfig: ConfigAi = {
    provider: input.ai.provider,
    model: input.ai.model,
    apiKey: process.env.LITSTORM_AI_API_KEY,
    apiBase: input.ai.apiBase,
    contextSize: input.ai.contextSize,
    extraBody: input.ai.extraBody,
    onUsage: (usage) => emit({ type: 'usage', ...usage }),
  }
  const searchConfig = {
    provider: input.search.provider,
    apiKey: process.env.LITSTORM_SEARCH_API_KEY || undefined,
    apiBase: input.search.apiBase,
    searxngEngines: input.search.engines,
  }
  const search = Object.assign(
    (query: string, options: Parameters<WebSearchFunction>[1]) => searchWeb(searchConfig, query, options),
    { provider: input.search.provider, readSource: createReadSource(searchConfig) },
  ) as WebSearchFunction

  // Research stops at gatherMs and the report is written from what was
  // learned by then (lit-storm: graceful finish at 80% of the level's target).
  const gather = new AbortController()
  const timer = input.gatherMs ? setTimeout(() => gather.abort('time'), input.gatherMs) : undefined
  const learned = new Map<string, ResearchLearning>()
  const keep = (items: ResearchLearning[] | undefined) => {
    for (const item of items ?? []) learned.set(JSON.stringify([item.url, item.learning]), item)
  }

  // The research tree, as the web app's canvas draws it (SearchFlow.vue):
  // one `node` event whenever a node appears or its state changes, never
  // for the streamed deltas in between, so lit-storm can draw it too.
  const nodes = new Map<string, { status: string; query?: string; goal?: string }>()
  const tree = (step: ResearchStep) => {
    if (step.type === 'complete' || !('nodeId' in step)) return
    const status = step.type.replace(/_reasoning$/, '')
    const known = nodes.get(step.nodeId)
    const query = 'query' in step && typeof step.query === 'string' ? step.query : known?.query
    const goal =
      step.type === 'generated_query' ? (step.result.researchGoal as string | undefined) : known?.goal
    if (known && known.status === status && known.query === query && known.goal === goal) return
    nodes.set(step.nodeId, { status, query, goal })
    emit({
      type: 'node',
      id: step.nodeId,
      parent: step.type === 'generating_query' ? step.parentNodeId : undefined,
      status,
      query,
      goal,
      ...(step.type === 'search_complete' ? { sources: step.results.length } : {}),
      ...(step.type === 'node_complete' ? { learnings: step.result?.learnings?.length ?? 0 } : {}),
      ...(step.type === 'error' ? { message: step.message } : {}),
    })
  }

  emit({ type: 'stage', stage: 'research' })
  let learnings: ResearchLearning[] = []
  try {
    const result = await deepResearch({
      query: input.query,
      breadth: input.breadth,
      maxDepth: input.depth,
      currentDepth: 1,
      languageCode: input.language as never,
      aiConfig,
      webSearchFunction: search,
      pLimitInstance: pLimit(2),
      signal: gather.signal,
      onProgress: (step) => {
        tree(step)
        if (step.type === 'search_complete') {
          emit({ type: 'searched', urls: step.results.map((r) => r.url), titles: step.results.map((r) => r.title ?? '') })
        } else if (step.type === 'node_complete') {
          keep(step.result?.learnings as ResearchLearning[] | undefined)
        } else if (step.type === 'error') {
          emit({ type: 'note', message: step.message })
        }
      },
    })
    learnings = result.learnings
  } catch (error) {
    if (!gather.signal.aborted) throw error
    learnings = [...learned.values()]
    emit({ type: 'cut_short', learnings: learnings.length })
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!learnings.length) {
    emit({ type: 'error', message: 'the research found nothing it could use' })
    process.exit(2)
  }

  emit({ type: 'stage', stage: 'report' })
  const report = writeFinalReport({ prompt: input.query, learnings, language: input.language, aiConfig })
  let markdown = ''
  const parts: Record<string, number> = {}
  let finishReason = ''
  for await (const chunk of report.fullStream) {
    parts[chunk.type] = (parts[chunk.type] ?? 0) + 1
    if (chunk.type === 'text-delta') markdown += chunk.textDelta
    else if (chunk.type === 'finish') finishReason = chunk.finishReason
    else if (chunk.type === 'error') throw chunk.error
  }
  emit({ type: 'report_stream', finishReason, parts })
  emit({
    type: 'report',
    markdown,
    learnings: learnings.map((l) => ({ url: l.url, title: l.title ?? '', learning: l.learning, excerpt: l.evidence?.excerpt ?? '' })),
  })
  process.exit(0)
}

main().catch((error) => {
  emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  process.exit(2)
})
