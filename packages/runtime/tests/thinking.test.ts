import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ModelResolver } from '../src/models.ts'
import { completeSimple, type Model } from '../src/omp/ai.ts'
import type { AgentSpec, ColonySpec } from '../src/spec.ts'
import { agentEffort, type Effort, effortFor, modelThinking } from '../src/thinking.ts'

// What each thinking setting puts on the wire, per provider family Myrmidon offers. Every model's base URL points at a
// local server that keeps the request body, so the body is exactly what its API would get; nothing leaves the machine
// (a request to any other address fails the test).

const bodies: Record<string, unknown>[] = []
let origin = ''
let server: { stop(force?: boolean): void; port: number }
const realFetch = globalThis.fetch
beforeAll(() => {
  const s = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      bodies.push((await req.json()) as Record<string, unknown>)
      return Response.json({ error: { message: 'kept', type: 'invalid_request_error' } }, { status: 400 })
    },
  })
  server = s as never
  origin = `http://127.0.0.1:${s.port}`
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(origin)) throw new Error(`a request left for ${url}`)
    return realFetch(input, init)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  server.stop(true)
})

const resolver = new ModelResolver()
const here = (model: Model): Model =>
  ({ ...model, baseUrl: `${origin}${new URL(model.baseUrl).pathname.replace(/\/$/, '')}` }) as Model
const model = (ref: string) => here(resolver.resolve(ref).model)

/** The body `model` is sent for a turn at `effort`, as the agent loop asks for it (omp's `reasoning`). */
async function wire(m: Model, effort: Effort | undefined): Promise<Record<string, unknown>> {
  bodies.length = 0
  const reply = await completeSimple(m, { messages: [{ role: 'user', content: 'Say ok.', timestamp: 1 }] }, {
    apiKey: 'test-key',
    maxRetries: 0,
    ...(effort ? { reasoning: effort as never } : {}),
  } as never)
  // A refused level fails before any request; the local server's own 400 is the only error expected.
  if (bodies.length !== 1) throw new Error(`no request for ${m.provider}/${m.id}: ${reply.errorMessage}`)
  return bodies[0] as Record<string, unknown>
}

/**
 * The settings a person meets: Auto, where the role decides (a quick answer low, a lone chat agent medium, a lead
 * high; patterns.ts thinkingFor), and the levels they can pick.
 */
const SETTINGS: { name: string; wanted: Effort; chosen: boolean }[] = [
  { name: 'auto, quick answer', wanted: 'low', chosen: false },
  { name: 'auto, chat agent', wanted: 'medium', chosen: false },
  { name: 'auto, lead', wanted: 'high', chosen: false },
  { name: 'low', wanted: 'low', chosen: true },
  { name: 'medium', wanted: 'medium', chosen: true },
  { name: 'high', wanted: 'high', chosen: true },
]

const BUDGET = { low: 4096, medium: 8192, high: 16384 } as Record<string, number>
const GEMINI_BUDGET = { low: 2048, medium: 8192, high: 32768 } as Record<string, number>
/** Fields that ask any of these APIs to think, none of which may reach a model that takes no thinking level. */
const THINKING_FIELDS = [
  'reasoning',
  'reasoning_effort',
  'thinking',
  'enable_thinking',
  'output_config',
  'think',
]

interface Row {
  family: string
  ref: string
  /** The effort sent for each of SETTINGS, in order; undefined when none is. */
  sent: (Effort | undefined)[]
  /** What the body carries for an effort. */
  body?(effort: Effort): Record<string, unknown>
}

const TABLE: Row[] = [
  {
    family: 'Anthropic, adaptive thinking (Claude 4.6+)',
    ref: 'anthropic/claude-sonnet-4-6',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ thinking: { type: 'adaptive' }, output_config: { effort: e } }),
  },
  {
    family: 'Anthropic, budget thinking (Claude 4.0–4.5)',
    ref: 'anthropic/claude-opus-4-0',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ thinking: { type: 'enabled', budget_tokens: BUDGET[e] } }),
  },
  {
    family: 'OpenAI Responses reasoning_effort',
    ref: 'openai/gpt-5.2',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning: { effort: e } }),
  },
  {
    family: 'OpenAI, a model without low (Codex mini: medium, high)',
    ref: 'openai/gpt-5.1-codex-mini',
    sent: ['medium', 'medium', 'high', 'medium', 'medium', 'high'],
    body: (e) => ({ reasoning: { effort: e } }),
  },
  {
    family: 'ChatGPT sign-in (Codex Responses)',
    ref: 'openai-codex/gpt-5.6-sol',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning: { effort: e } }),
  },
  {
    family: 'Gemini 2.5, thinking budget',
    ref: 'google/gemini-2.5-pro',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ generationConfig: { thinkingConfig: { thinkingBudget: GEMINI_BUDGET[e] } } }),
  },
  {
    family: 'Gemini 3 Pro, thinking level low or high',
    ref: 'google/gemini-3-pro-preview',
    sent: ['low', 'low', 'high', 'low', 'low', 'high'],
    body: (e) => ({ generationConfig: { thinkingConfig: { thinkingLevel: e.toUpperCase() } } }),
  },
  {
    family: 'Gemini 3.7 Flash, thinking level',
    ref: 'google/gemini-3.7-flash',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ generationConfig: { thinkingConfig: { thinkingLevel: e.toUpperCase() } } }),
  },
  {
    family: 'Groq gpt-oss, reasoning_effort',
    ref: 'groq/openai/gpt-oss-120b',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning_effort: e }),
  },
  {
    family: 'Groq Qwen 3.8: reasoning_effort, never enable_thinking',
    ref: 'groq/qwen/qwen3.8-27b',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning_effort: e }),
  },
  {
    family: 'Groq Qwen 3.6: thinks or not, sent as `default`',
    ref: 'groq/qwen/qwen3.6-27b',
    sent: ['high', 'high', 'high', 'high', 'high', 'high'],
    body: () => ({ reasoning_effort: 'default' }),
  },
  { family: 'Groq Llama, no reasoning', ref: 'groq/llama-3.3-70b-versatile', sent: Array(6).fill(undefined) },
  {
    family: 'OpenRouter Claude',
    ref: 'openrouter/anthropic/claude-sonnet-4.6',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning: { effort: e } }),
  },
  {
    family: 'OpenRouter DeepSeek R1: high only',
    ref: 'openrouter/deepseek/deepseek-r1',
    sent: ['high', 'high', 'high', 'high', 'high', 'high'],
    body: (e) => ({ reasoning: { effort: e } }),
  },
  {
    family: 'DeepSeek V4: low, high, max',
    ref: 'deepseek/deepseek-v4-flash',
    sent: ['low', 'low', 'high', 'low', 'low', 'high'],
    body: (e) => ({ reasoning_effort: e, thinking: { type: 'enabled' } }),
  },
  {
    family: 'Kimi K2 Thinking (Moonshot)',
    ref: 'moonshot/kimi-k2-thinking',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning_effort: e, thinking: { type: 'enabled' } }),
  },
  {
    family: 'Kimi K3: low, high, max',
    ref: 'moonshot/kimi-k3',
    sent: ['low', 'low', 'high', 'low', 'low', 'high'],
    body: (e) => ({ reasoning_effort: e }),
  },
  {
    family: 'Z.AI GLM-5.3: budget and effort, low, high, max',
    ref: 'zai/glm-5.3',
    sent: ['low', 'low', 'high', 'low', 'low', 'high'],
    body: (e) => ({ thinking: { type: 'enabled', budget_tokens: BUDGET[e] }, output_config: { effort: e } }),
  },
  {
    family: 'Z.AI GLM-4.5: budget',
    ref: 'zai/glm-4.5',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ thinking: { type: 'enabled', budget_tokens: BUDGET[e] } }),
  },
  {
    family: 'Mistral Magistral',
    ref: 'mistral/magistral-medium-latest',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning_effort: e }),
  },
  {
    family: 'xAI Grok 4.6',
    ref: 'xai/grok-4.6',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning: { effort: e } }),
  },
  { family: 'xAI Grok 4: reasons, no level to set', ref: 'xai/grok-4', sent: Array(6).fill(undefined) },
  {
    family: 'Cerebras Qwen',
    ref: 'cerebras/qwen-3.8-27b',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning_effort: e }),
  },
  {
    family: 'Together Qwen: enable_thinking',
    ref: 'together/Qwen/Qwen3.5-9B',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: () => ({ enable_thinking: true }),
  },
  {
    family: 'Fireworks GLM',
    ref: 'fireworks/glm-5',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: (e) => ({ reasoning_effort: e }),
  },
  {
    family: 'MiniMax: adaptive at every level',
    ref: 'minimax/MiniMax-M2.5',
    sent: ['low', 'medium', 'high', 'low', 'medium', 'high'],
    body: () => ({ thinking: { type: 'adaptive' } }),
  },
  {
    family: 'Ollama (native chat), DeepSeek V4',
    ref: 'ollama-cloud/deepseek-v4-flash',
    sent: ['low', 'low', 'high', 'low', 'low', 'high'],
    body: (e) => ({ think: e }),
  },
]

describe('every provider family gets only a thinking level it takes', () => {
  for (const row of TABLE) {
    test(`${row.family} (${row.ref})`, async () => {
      const m = model(row.ref)
      const sent = SETTINGS.map((s) => effortFor(m, s.wanted, s.chosen))
      expect(sent).toEqual(row.sent)
      for (const effort of new Set(sent)) {
        const body = await wire(m, effort)
        if (effort && row.body) expect(body).toMatchObject(row.body(effort))
        else for (const field of THINKING_FIELDS) expect(body).not.toContainKey(field)
      }
    })
  }
})

describe('models the catalog does not vouch for', () => {
  const gptOss = () => model('groq/openai/gpt-oss-120b')

  test('a model omp only guesses reasons thinks only at a level the person picks; Auto sends none', async () => {
    const base = gptOss()
    const guessed = { ...base, thinking: { ...base.thinking, unverified: true } } as Model
    for (const s of SETTINGS.filter((s) => !s.chosen))
      expect(effortFor(guessed, s.wanted, false)).toBeUndefined()
    const auto = await wire(guessed, undefined)
    for (const field of THINKING_FIELDS) expect(auto).not.toContainKey(field)
    expect(await wire(guessed, effortFor(guessed, 'high', true))).toMatchObject({ reasoning_effort: 'high' })
    expect(modelThinking(guessed)).toEqual({
      levels: { low: 'low', medium: 'medium', high: 'high' },
      unverified: true,
    })
  })

  test('a local model (LM Studio, Ollama over its OpenAI API) found without reasoning metadata gets no thinking', async () => {
    const local = {
      ...gptOss(),
      provider: 'lmstudio',
      id: 'qwen3-8b',
      reasoning: false,
      thinking: undefined,
    } as unknown as Model
    for (const s of SETTINGS) expect(effortFor(local, s.wanted, s.chosen)).toBeUndefined()
    const body = await wire(local, undefined)
    for (const field of THINKING_FIELDS) expect(body).not.toContainKey(field)
    expect(modelThinking(local)).toBeUndefined()
  })
})

describe('what the picker is told of a model', () => {
  test('each level as it is sent, so the picker offers what the model has and names what it gets instead', () => {
    expect(modelThinking(model('deepseek/deepseek-v4-flash'))).toEqual({
      levels: { low: 'low', medium: 'low', high: 'high' },
    })
    expect(modelThinking(model('groq/qwen/qwen3.6-27b'))).toEqual({
      levels: { low: 'high', medium: 'high', high: 'high' },
    })
    expect(modelThinking(model('anthropic/claude-sonnet-4-6'))).toEqual({
      levels: { low: 'low', medium: 'medium', high: 'high' },
    })
    expect(modelThinking(model('xai/grok-4'))).toBeUndefined()
    expect(modelThinking(model('groq/llama-3.3-70b-versatile'))).toBeUndefined()
  })
})

describe("an agent's level in a round", () => {
  const lead: AgentSpec = { name: 'lead', role: 'lead', model: 'deepseek/deepseek-v4-flash' } as AgentSpec
  const worker: AgentSpec = { name: 'kai', role: 'worker', model: 'deepseek/deepseek-v4-flash' } as AgentSpec
  const round = (p: Partial<ColonySpec>) =>
    ({ pattern: 'lead-workers', agents: [lead, worker], ...p }) as unknown as ColonySpec
  const deepseek = () => model('deepseek/deepseek-v4-flash')

  test("the role decides under Auto, clamped to the model's levels", () => {
    expect(agentEffort(deepseek(), round({}), lead)).toBe('high')
    // A worker's medium is a level DeepSeek lacks: the one below it, not a refused request.
    expect(agentEffort(deepseek(), round({}), worker)).toBe('low')
    expect(agentEffort(deepseek(), round({ tier: 'answer', agents: [lead] }), lead)).toBe('low')
  })

  test("the person's pick applies to every agent, as each model takes it", () => {
    expect(agentEffort(deepseek(), round({ thinking: 'medium' }), lead)).toBe('low')
    expect(agentEffort(model('anthropic/claude-sonnet-4-6'), round({ thinking: 'medium' }), worker)).toBe(
      'medium',
    )
  })

  test('a quick answer stays at its own level on a model omp only guesses reasons: none', () => {
    const base = model('groq/openai/gpt-oss-120b')
    const guessed = { ...base, thinking: { ...base.thinking, unverified: true } } as Model
    expect(
      agentEffort(guessed, round({ tier: 'answer', thinking: 'high', agents: [lead] }), lead),
    ).toBeUndefined()
    expect(agentEffort(guessed, round({ thinking: 'high' }), lead)).toBe('high')
  })
})
