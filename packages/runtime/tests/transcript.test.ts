import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscript } from '../src/agent.ts'

const line = (m: object) => `${JSON.stringify(m)}\n`

test('a transcript cut off mid-step resumes from the last complete step', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'myr-transcript-')), 'lead.jsonl')
  const user = { role: 'user', content: 'Write the draft', timestamp: 1 }
  const call = (id: string) => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'fs_write' }],
    timestamp: 2,
  })
  const result = (id: string) => ({ role: 'toolResult', toolCallId: id, content: [], timestamp: 3 })

  writeFileSync(path, line(user) + line(call('a')) + line(result('a')) + line(call('b')) + '{"role":"tool')
  expect(readTranscript(path).map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult'])

  writeFileSync(path, line(user) + line(call('a')) + line(result('a')))
  expect(readTranscript(path)).toHaveLength(3)
  expect(readTranscript(join(path, '..', 'missing.jsonl'))).toEqual([])
})

test('a step cut off after its calls ran is answered from the log, not dropped to be run again', async () => {
  const { readFileSync } = await import('node:fs')
  const path = join(mkdtempSync(join(tmpdir(), 'myr-transcript-')), 'lead.jsonl')
  const user = { role: 'user', content: 'Ship it', timestamp: 1 }
  const step = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'done', name: 'publish_artifact' },
      { type: 'toolCall', id: 'running', name: 'shell' },
      { type: 'toolCall', id: 'queued', name: 'message' },
    ],
    timestamp: 2,
  }
  const steered = { role: 'user', content: 'also add a README', timestamp: 3 }
  writeFileSync(path, line(user) + line(step) + line(steered))
  const record = (callId: string, tool: string, result?: { ok: boolean; output: string }) => ({
    agent: 'lead',
    callId,
    tool,
    args: {},
    seq: 1,
    ...(result ? { result } : {}),
  })
  const log = new Map([
    ['done', record('done', 'publish_artifact', { ok: true, output: 'Published out.txt v1' })],
    ['running', record('running', 'shell')],
  ])
  const messages = readTranscript(path, (id) => log.get(id)) as unknown as {
    role: string
    toolCallId?: string
    isError?: boolean
    content: unknown
  }[]
  // Every call of the step has a result, right after it and before what came in later.
  expect(messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'toolResult',
    'toolResult',
    'toolResult',
    'user',
  ])
  expect(messages.slice(2, 5).map((m) => m.toolCallId)).toEqual(['done', 'running', 'queued'])
  expect(JSON.stringify(messages[2]?.content)).toContain('Published out.txt v1')
  expect(messages[2]?.isError).toBe(false)
  expect(JSON.stringify(messages[3]?.content)).toContain('[interrupted]')
  expect(messages[3]?.isError).toBe(true)
  expect(JSON.stringify(messages[4]?.content)).toContain('[not run]')
  // Written back: the next resume reads the same whole conversation without the log's help.
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(6)
  expect(readTranscript(path).map((m) => m.role as string)).toEqual(messages.map((m) => m.role))

  // Nothing of the step in the log: it never ran, and is dropped as before.
  writeFileSync(path, line(user) + line(step))
  expect(readTranscript(path, () => undefined).map((m) => m.role)).toEqual(['user'])
})

test('a new round keeps recent turns whole and elides older tool output', async () => {
  const { compactTranscript } = await import('../src/agent.ts')
  const turn = (n: number) => [
    { role: 'user', content: `request ${n}`, timestamp: n },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'toolCall', id: `c${n}` },
      ],
      timestamp: n,
    },
    {
      role: 'toolResult',
      toolCallId: `c${n}`,
      content: [{ type: 'text', text: 'x'.repeat(500) }],
      timestamp: n,
    },
  ]
  const all = [1, 2, 3, 4, 5, 6].flatMap(turn) as never[]
  const out = compactTranscript(all, 2) as unknown as { role: string; content: unknown }[]
  expect(out).toHaveLength(all.length)
  expect(JSON.stringify(out[2]?.content)).toContain('elided')
  expect(JSON.stringify(out[1]?.content)).not.toContain('thinking')
  expect(JSON.stringify(out.at(-1)?.content)).toContain('x'.repeat(500))
  expect(JSON.stringify(out.at(-4)?.content)).toContain('x'.repeat(500))
})
