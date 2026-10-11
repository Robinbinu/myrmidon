import { CHARS_PER_TOKEN } from './config.ts'
import { tokenizerEncodingForModel } from './omp/agent-core.ts'
import type { Model } from './omp/ai.ts'
import { countTokens, Encoding } from './omp/natives.ts'

let warned = false

/**
 * Tokens in `text` (an array counts as the sum of its parts, counted in parallel), by omp's native tokenizer: the
 * model's own encoding when the catalog knows it (Claude, Qwen, DeepSeek, Kimi, GLM), o200k otherwise. On a 1.8 MB
 * transcript that is about 16 ms as one string and 4 ms as per-message parts, against chars/4 that undercounts
 * o200k by about 10% and Claude 5 by about 40%. An addon that cannot count falls back to characters / CHARS_PER_TOKEN.
 */
export function tokensOf(text: string | readonly string[], model?: Pick<Model, 'tokenizer'>): number {
  try {
    return countTokens(text as string | string[], tokenizerEncodingForModel(model) ?? Encoding.O200kBase)
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn('[tokens] native token count failed, estimating from characters:', err)
    }
    const chars = typeof text === 'string' ? text.length : text.reduce((n, t) => n + t.length, 0)
    return Math.ceil(chars / CHARS_PER_TOKEN)
  }
}
