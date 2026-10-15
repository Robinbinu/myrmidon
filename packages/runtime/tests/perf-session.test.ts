import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withinBudget } from '../../../tests/perf-budgets.ts'
import { compactTranscript, readTranscript } from '../src/agent.ts'

const TURNS = 2_000

test(`a ${TURNS}-turn transcript reads and compacts within its budget (a resumed long session)`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-perf-session-'))
  try {
    const path = join(dir, 'lead.jsonl')
    const lines: string[] = []
    for (let n = 0; n < TURNS; n++)
      for (const m of [
        { role: 'user', content: `request ${n}`, timestamp: n },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'weighing it '.repeat(30) },
            { type: 'toolCall', id: `c${n}`, name: 'shell', arguments: { command: 'ls' } },
          ],
          timestamp: n,
        },
        {
          role: 'toolResult',
          toolCallId: `c${n}`,
          content: [{ type: 'text', text: 'x'.repeat(2_000) }],
          timestamp: n,
        },
      ])
        lines.push(JSON.stringify(m))
    writeFileSync(path, `${lines.join('\n')}\n`)
    const { result } = await withinBudget('longSession', () => compactTranscript(readTranscript(path)))
    expect(result).toHaveLength(TURNS * 3)
    expect(JSON.stringify(result[2])).toContain('elided')
    expect(JSON.stringify(result.at(-1))).toContain('x'.repeat(2_000))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
