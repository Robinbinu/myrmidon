import { afterEach, expect, test } from 'bun:test'
import { ModelResolver } from '../src/models.ts'
import { type Context, completeSimple, type Model } from '../src/omp/ai.ts'

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

/** A Groq stand-in that keeps each chat request's body and answers one short reply. */
function groq() {
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      bodies.push((await req.json()) as Record<string, unknown>)
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      return new Response(
        `${chunk({ role: 'assistant', content: 'ok' })}${chunk({}, 'stop')}data: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}/openai/v1`, bodies }
}

const at = (model: Model, baseUrl: string) => ({ ...model, baseUrl }) as Model
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

test('Kimi on Groq gets no reasoning_content, and an earlier model’s thinking still reaches it as text', async () => {
  const { url, bodies } = groq()
  const kimi = new ModelResolver().resolve('groq/moonshotai/kimi-k2-instruct').model
  expect(kimi.compat).toMatchObject({ requiresReasoningContentForToolCalls: false })
  // The saved request's shape: a reasoning model's tool-call turn, then Kimi's own.
  const context: Context = {
    systemPrompt: ['You are lead.'],
    messages: [
      { role: 'user', content: 'What is the weather in Chennai today?', timestamp: 1 },
      {
        role: 'assistant',
        api: 'openai-completions',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        content: [
          { type: 'thinking', thinking: 'I need a search for this.', thinkingSignature: 'reasoning_content' },
          { type: 'toolCall', id: 'call_1', name: 'search', arguments: { query: 'Chennai weather' } },
        ],
        usage,
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'search',
        content: [{ type: 'text', text: '31°C, humid' }],
        isError: false,
        timestamp: 3,
      },
      {
        role: 'assistant',
        api: 'openai-completions',
        provider: 'groq',
        model: 'moonshotai/kimi-k2-instruct',
        content: [{ type: 'toolCall', id: 'call_2', name: 'search', arguments: { query: 'Chennai rain' } }],
        usage,
        stopReason: 'toolUse',
        timestamp: 4,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_2',
        toolName: 'search',
        content: [{ type: 'text', text: 'no rain' }],
        isError: false,
        timestamp: 5,
      },
    ],
    tools: [
      {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      } as never,
    ],
  }
  const reply = await completeSimple(at(kimi, url), context, { apiKey: 'gsk-test' })
  expect(reply.stopReason).toBe('stop')
  const messages = bodies[0]?.messages as Record<string, unknown>[]
  const assistants = messages.filter((m) => m.role === 'assistant')
  expect(assistants).toHaveLength(2)
  for (const m of assistants) expect(m).not.toContainKey('reasoning_content')
  expect(String(assistants[0]?.content)).toContain('I need a search for this.')
})

test('Qwen on Groq is told reasoning_effort, never enable_thinking', async () => {
  const { url, bodies } = groq()
  const qwen = at(new ModelResolver().resolve('groq/qwen/qwen3.8-27b').model, url)
  const context: Context = { messages: [{ role: 'user', content: 'Say ok.', timestamp: 1 }] }
  // A title or a probe turns thinking off; the saved request sent `enable_thinking: false` here.
  await completeSimple(qwen, context, { apiKey: 'gsk-test', disableReasoning: true })
  await completeSimple(qwen, context, { apiKey: 'gsk-test', reasoning: 'minimal' as never })
  await completeSimple(qwen, context, { apiKey: 'gsk-test', reasoning: 'high' as never })
  await completeSimple(qwen, context, { apiKey: 'gsk-test' })
  for (const body of bodies) expect(body).not.toContainKey('enable_thinking')
  // Groq's Qwen takes none, low, medium and high; without one it does not think.
  expect(bodies.map((b) => b.reasoning_effort)).toEqual(['none', 'low', 'high', undefined])
})

test('other providers keep the catalog’s request shape', () => {
  const resolver = new ModelResolver()
  for (const ref of ['moonshot/kimi-k2-0905-preview', 'nvidia/moonshotai/kimi-k2-instruct']) {
    expect(resolver.resolve(ref).model.compat).toMatchObject({ requiresReasoningContentForToolCalls: true })
  }
  expect(resolver.resolve('groq/openai/gpt-oss-120b').model.compat).toMatchObject({
    thinkingFormat: 'openai',
  })
})
