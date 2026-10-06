import { expect, test } from 'bun:test'
import type { AgentMessage } from '@oh-my-pi/pi-agent-core'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { type Compacted, ContextCompactor } from '../src/compaction.ts'

const text = (role: 'user' | 'assistant', body: string, contextTokens?: number) =>
  ({
    role,
    content: [{ type: 'text', text: body }],
    timestamp: 1,
    ...(contextTokens !== undefined
      ? {
          usage: {
            input: contextTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: contextTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
      : {}),
  }) as unknown as AgentMessage
const call = (id: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'shell', arguments: {} }],
    timestamp: 1,
  }) as unknown as AgentMessage
const result = (id: string) =>
  ({
    role: 'toolResult',
    toolCallId: id,
    content: [{ type: 'text', text: 'x'.repeat(400) }],
    timestamp: 1,
  }) as unknown as AgentMessage

function setup() {
  const model = createMockModel({ contextWindow: 4_000 }).model
  const passes: { count: number; previous?: string }[] = []
  const compacted: Compacted[] = []
  const compactor = new ContextCompactor({
    model: () => model,
    apiKey: async () => undefined,
    onCompacted: (info) => compacted.push(info),
    settings: { enabled: true, strategy: 'context-full', keepRecentTokens: 300 },
    summarize: async (messages, _m, _r, _k, _s, previous) => {
      passes.push({ count: messages.length, ...(previous ? { previous } : {}) })
      return `summary #${passes.length}`
    },
  })
  return { compactor, passes, compacted }
}

test('small contexts go to the model unchanged', async () => {
  const { compactor, passes } = setup()
  const messages = [text('user', 'hello'), text('assistant', 'hi', 500)]
  expect(await compactor.transform(messages)).toBe(messages)
  expect(passes).toHaveLength(0)
})

test('a context near the window is summarized, keeping recent messages and tool pairs intact', async () => {
  const { compactor, passes, compacted } = setup()
  const messages: AgentMessage[] = [text('user', 'build it')]
  for (let i = 0; i < 12; i++) messages.push(call(`c${i}`), result(`c${i}`))
  messages.push(text('assistant', 'working', 3_900))

  const view = await compactor.transform(messages)
  expect(passes).toHaveLength(1)
  expect(compacted[0]?.tokens).toBeGreaterThan(3_000)
  expect(JSON.stringify(view[0])).toContain('summary #1')
  expect(view.length).toBeLessThan(messages.length)
  // The kept part never starts with a tool result whose call was summarized away.
  expect((view[1] as { role: string }).role).not.toBe('toolResult')
  expect(view.at(-1)).toBe(messages.at(-1))

  // The summary is reused while the context stays small, and folded forward when it grows again.
  const next = [...messages, text('user', 'more'), text('assistant', 'ok', 900)]
  expect(JSON.stringify((await compactor.transform(next))[0])).toContain('summary #1')
  expect(passes).toHaveLength(1)
  for (let i = 12; i < 24; i++) next.push(call(`c${i}`), result(`c${i}`))
  next.push(text('assistant', 'still working', 3_950))
  await compactor.transform(next)
  expect(passes).toHaveLength(2)
  expect(passes[1]?.previous).toBe('summary #1')
})
