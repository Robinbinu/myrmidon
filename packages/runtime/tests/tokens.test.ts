import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { countTokens, Encoding } from '../src/omp/natives.ts'
import { tokensOf } from '../src/tokens.ts'

test("token counts come from omp's native tokenizer, in the model's own encoding when the catalog knows it", () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(40)
  expect(tokensOf(text)).toBe(countTokens(text, Encoding.O200kBase))
  expect(tokensOf(text, { tokenizer: 'claude-v5' })).toBe(countTokens(text, Encoding.ClaudeV5))
  // A model the catalog has no tokenizer for counts as o200k.
  expect(tokensOf(text, {})).toBe(tokensOf(text))
  // Parts count as their sum.
  expect(tokensOf(['hello world', 'hello world'])).toBe(2 * tokensOf('hello world'))
})

test('a large transcript counts in well under a turn: per-message parts in parallel', () => {
  const dir = join(import.meta.dir, '../src')
  const parts = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) =>
      JSON.stringify({
        role: 'toolResult',
        content: [{ type: 'text', text: readFileSync(join(dir, f), 'utf8') }],
      }),
    )
  const chars = parts.reduce((n, p) => n + p.length, 0)
  expect(chars).toBeGreaterThan(1_000_000)
  tokensOf(parts)
  const start = performance.now()
  const tokens = tokensOf(parts)
  const ms = performance.now() - start
  // chars/4 undercounts code: the real count is higher.
  expect(tokens).toBeGreaterThan(chars / 4)
  // Measured at about 4 ms on an M-series Mac; the bound only catches a pathological slowdown.
  expect(ms).toBeLessThan(1_000)
})
