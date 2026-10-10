import { prompts } from '../prompts.ts'
import type { ModelFamily } from './facts.ts'

/**
 * Guidance for the model families that need it (§4.2 of the harness-prompts research), each guarded by the family of
 * the model the agent runs on, after Hermes' family-gated blocks and Codex's and Cline's per-model prompts. A block
 * exists only for a failure documented in another harness; the words are in prompts.ts.
 */
export interface FamilyBlock {
  readonly key: string
  readonly families: readonly ModelFamily[]
  readonly text: string
}

export const FAMILY_BLOCKS: readonly FamilyBlock[] = [
  {
    // Hermes gates its tool-use enforcement to these families (TOOL_USE_ENFORCEMENT_MODELS: gpt, codex, gemini,
    // gemma, grok, glm, qwen, deepseek): they end turns describing what they will do instead of calling the tool.
    key: 'act',
    families: ['openai-gpt', 'openai-codex', 'google-gemini', 'qwen', 'deepseek', 'glm'],
    text: prompts.system.families.act,
  },
  {
    // omp re-prompts Gemini when it writes calls as text (gemini-tool-call-reminder.md, malformed-function-call-
    // retry.md); Qwen Code parses Qwen's <function=…> calls written as text (xml-tool-call-fallback.ts).
    key: 'calls',
    families: ['google-gemini', 'qwen'],
    text: prompts.system.families.calls,
  },
]
