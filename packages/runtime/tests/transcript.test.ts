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
