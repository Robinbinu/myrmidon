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

test('carried transcripts keep recent turns whole and elide older tool output', async () => {
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
