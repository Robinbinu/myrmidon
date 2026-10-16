import type { MyrEvent } from '@myrmidon/protocol'
import { HANDOFF } from './config.ts'
import { ask } from './memory-review.ts'
import type { ModelResolver } from './models.ts'
import { redactMemorySecrets } from './omp/memory.ts'
import { prompts } from './prompts.ts'
import { roundDigest, toolCallsSince } from './skill-learning.ts'

/**
 * Where a chat left off: a short note (goal, done, open, next, decisions, files, the question still waiting on the
 * person) a cheap model writes from a round's record once the chat has gone quiet, after omp's rollout summaries and
 * the format of its compaction handoff. It is logged with the chat (chat/handoff) and read only when the chat is
 * picked up by an agent that does not remember it, or found with search_chats: never added to every prompt, which
 * both Hermes and omp avoid (episodes crowd out the task).
 */

/** Whether a round did enough to leave anything to pick up: an answer alone does not. */
export function worthNoting(events: readonly MyrEvent[], from: number): boolean {
  return toolCallsSince(events, from) >= HANDOFF.minCalls
}

/** The note for the round starting at `from`, or undefined when the model found nothing to pick up. */
export async function writeHandoff(input: {
  resolver: ModelResolver
  model: string
  events: readonly MyrEvent[]
  from: number
  /** How the round ended, e.g. "completed" or "stopped: interrupted". */
  status: string
  /** The chat's note from before this round, which this one updates. */
  previous?: string
  today?: string
}): Promise<string | undefined> {
  const reply = await ask(
    input.resolver,
    input.model,
    prompts.handoff.system,
    prompts.handoff.round({
      today: input.today ?? new Date().toISOString().slice(0, 10),
      status: input.status,
      ...(input.previous ? { previous: input.previous } : {}),
      digest: roundDigest(input.events, input.from, HANDOFF.digestChars),
    }),
  )
  const text = redactMemorySecrets(reply).trim()
  if (!text || text.replace(/[.\s]/g, '').toUpperCase() === prompts.handoff.nothing) return undefined
  return text.length > HANDOFF.maxChars ? `${text.slice(0, HANDOFF.maxChars)}…` : text
}
