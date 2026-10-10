import { expect, test } from 'bun:test'
import type { CompactionMethod } from '@myrmidon/protocol'
import type { AgentMessage } from '@oh-my-pi/pi-agent-core'
import type { Model } from '@oh-my-pi/pi-ai'
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

function history(turns: number, lastContext: number): AgentMessage[] {
  const messages: AgentMessage[] = [text('user', 'build it')]
  for (let i = 0; i < turns; i++) messages.push(call(`c${i}`), result(`c${i}`))
  messages.push(text('assistant', 'working', lastContext))
  return messages
}

test('a small window keeps a recent part and a summary that fit it, even with the default settings', async () => {
  const small = createMockModel({ contextWindow: 8_192 }).model
  const reserves: number[] = []
  const compactor = new ContextCompactor({
    model: () => small,
    apiKey: async () => undefined,
    onCompacted: () => {},
    summarize: async (_messages, _m, reserve) => {
      reserves.push(reserve)
      return 'summary'
    },
  })
  // Far more than 20k tokens of history, the default recent part, arriving at an 8k model.
  const messages = history(250, 125_000)
  const view = await compactor.transform(messages)
  expect(reserves).toHaveLength(1)
  // The summary's budget comes from the 8k window, not the 16k default reserve.
  expect(reserves[0]).toBeLessThan(8_192 / 4)
  const kept = Math.ceil(JSON.stringify(view.slice(1)).length / 4)
  expect(kept).toBeLessThan(8_192 / 2)
})

test('the largest-window model the agent has used writes the summary, falling back when it fails', async () => {
  let current = createMockModel({ id: 'big', contextWindow: 200_000 }).model
  const big = current
  const used: number[] = []
  let failBig = false
  const compactor = new ContextCompactor({
    model: () => current,
    apiKey: async () => undefined,
    onCompacted: () => {},
    settings: { enabled: true, strategy: 'context-full', keepRecentTokens: 300 },
    summarize: async (_messages, m) => {
      if (failBig && m === big) throw new Error('key revoked')
      used.push(m.contextWindow ?? 0)
      return 'summary'
    },
  })
  await compactor.transform(history(2, 500))
  current = createMockModel({ id: 'small', contextWindow: 4_000 }).model
  await compactor.transform(history(12, 3_900))
  expect(used).toEqual([200_000])

  failBig = true
  const next = history(24, 3_950)
  await compactor.transform(next)
  expect(used).toEqual([200_000, 4_000])
})

test('after a provider overflow the next call folds what it can; with nothing left to fold it says so', async () => {
  const { compactor, passes } = setup()
  const messages = history(6, 1_000)
  expect(compactor.overflowed(messages)).toBe(true)
  await compactor.transform(messages)
  expect(passes).toHaveLength(1)
  expect(compactor.overflowed([text('user', 'hello')])).toBe(false)
})

const bulky = (id: string, chars: number, image = false) =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'fs_read',
    content: [
      { type: 'text', text: `${id} `.padEnd(chars, 'y') },
      // A 1×1 PNG: shake drops a result's images along with its text.
      ...(image
        ? [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            },
          ]
        : []),
    ],
    isError: false,
    timestamp: 1,
  }) as unknown as AgentMessage

/** A round of `turns` file reads whose results are `chars` long, ending at a reply that reported `lastContext`. */
function bulkyHistory(turns: number, chars: number, lastContext: number): AgentMessage[] {
  const messages: AgentMessage[] = [text('user', 'read the docs')]
  for (let i = 0; i < turns; i++) messages.push(call(`r${i}`), bulky(`r${i}`, chars, i === 0))
  messages.push(text('assistant', 'reading', lastContext))
  return messages
}

function ordered(model: Model, order?: readonly CompactionMethod[]) {
  const passes: number[] = []
  const compacted: Compacted[] = []
  const compactor = new ContextCompactor({
    model: () => model,
    apiKey: async () => undefined,
    onCompacted: (info) => compacted.push(info),
    settings: { enabled: true, strategy: 'context-full', keepRecentTokens: 2_000 },
    ...(order ? { order } : {}),
    summarize: async (messages) => {
      passes.push(messages.length)
      return `summary #${passes.length}`
    },
  })
  return { compactor, passes, compacted }
}

const shown = (m: AgentMessage | undefined) => JSON.stringify(m)

test('shake elides old bulky tool output and keeps the recent part, stopping before a summary when that fits', async () => {
  const { compactor, passes, compacted } = ordered(createMockModel({ contextWindow: 40_000 }).model)
  const messages = bulkyHistory(10, 8_000, 24_000)
  const stored = JSON.stringify(messages)

  const view = await compactor.transform(messages)
  expect(passes).toHaveLength(0)
  expect(compacted).toHaveLength(1)
  expect(compacted[0]?.methods).toEqual(['shake'])
  expect(compacted[0]?.elided).toBeGreaterThan(5)
  expect(compacted[0]?.tokensAfter).toBeLessThan(compacted[0]?.tokens ?? 0)
  // Old results become a note that says how to get them back; their images go too.
  expect(shown(view[2])).toContain('elided to fit your context window')
  expect(shown(view[2])).toContain('read_log(tool: \\"fs_read\\")')
  expect(shown(view[2])).not.toContain('"type":"image"')
  // The newest result is the agent's working material and stays word for word.
  expect(view.at(-2)).toBe(messages.at(-2))
  expect(view).toHaveLength(messages.length)
  // Only the request changes: the stored conversation keeps everything.
  expect(JSON.stringify(messages)).toBe(stored)

  // The elisions hold on later calls, so the cached prompt prefix stays the same.
  const later = [...messages, text('user', 'and now?'), text('assistant', 'ok', 8_000)]
  expect(shown((await compactor.transform(later))[2])).toContain('elided to fit your context window')
  expect(compacted).toHaveLength(1)
})

test('when shaking is not enough a text-only model goes on to the summary, skipping snapcompact', async () => {
  const { compactor, passes, compacted } = ordered(createMockModel({ contextWindow: 40_000 }).model)
  const view = await compactor.transform(bulkyHistory(10, 8_000, 39_000))
  expect(compacted[0]?.methods).toEqual(['shake', 'summary'])
  expect(passes).toHaveLength(1)
  expect(shown(view[0])).toContain('summary #1')
})

test('the method order is tunable: without shake the summary runs at once', async () => {
  const { compactor, passes, compacted } = ordered(createMockModel({ contextWindow: 40_000 }).model, [
    'summary',
  ])
  await compactor.transform(bulkyHistory(10, 8_000, 24_000))
  expect(compacted[0]?.methods).toEqual(['summary'])
  expect(compacted[0]?.elided).toBe(0)
  expect(passes).toHaveLength(1)
})

function chatter(turns: number, lastContext: number): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (let i = 0; i < turns; i++)
    messages.push(
      text('user', `step ${i}: ${'please look at the parser and the lexer again '.repeat(30)}`),
      text('assistant', `done ${i}: ${'changed the tokenizer table and reran the tests '.repeat(30)}`),
    )
  messages.push(text('assistant', 'next', lastContext))
  return messages
}

test('a vision model gets the older part as snapcompact image frames, without a model call', async () => {
  const vision = { ...createMockModel({ contextWindow: 60_000 }).model, input: ['text', 'image'] } as Model
  const { compactor, passes, compacted } = ordered(vision)
  const messages = chatter(60, 50_000)

  const view = await compactor.transform(messages)
  expect(passes).toHaveLength(0)
  expect(compacted[0]?.methods).toEqual(['snapcompact'])
  expect(compacted[0]?.frames).toBeGreaterThan(0)
  const content = (view[0] as { content: { type: string; data?: string; text?: string }[] }).content
  expect(content[0]?.text).toContain('archived to fit your context window')
  const frames = content.filter((c) => c.type === 'image')
  expect(frames).toHaveLength(compacted[0]?.frames ?? -1)
  // Real PNG frames, rendered locally.
  expect(
    Buffer.from(frames[0]?.data ?? '', 'base64')
      .subarray(1, 4)
      .toString(),
  ).toBe('PNG')
  expect(view.length).toBeLessThan(messages.length)
  expect(view.at(-1)).toBe(messages.at(-1))
  expect(compacted[0]?.tokensAfter).toBeLessThan(compacted[0]?.tokens ?? 0)
})

test('a move to a text-only model, which cannot read the frames, summarizes the archive into text once', async () => {
  let model = { ...createMockModel({ contextWindow: 60_000 }).model, input: ['text', 'image'] } as Model
  const passes: AgentMessage[][] = []
  const compactor = new ContextCompactor({
    model: () => model,
    apiKey: async () => undefined,
    onCompacted: () => {},
    settings: { enabled: true, strategy: 'context-full', keepRecentTokens: 2_000 },
    summarize: async (folded) => {
      passes.push(folded)
      return 'summary of the archive'
    },
  })
  const messages = chatter(60, 50_000)
  await compactor.transform(messages)
  expect(passes).toHaveLength(0)
  model = createMockModel({ contextWindow: 60_000 }).model
  const moved = await compactor.transform([...messages, text('user', 'go on')])
  expect(passes).toHaveLength(1)
  expect(shown(passes[0]?.[0])).toContain('step 1')
  expect(shown(moved[0])).toContain('summary of the archive')
  expect(shown(moved[0])).not.toContain('"type":"image"')
})
