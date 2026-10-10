import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import {
  MEMORY_EXTRACT_ANSWER_CHARS,
  MEMORY_EXTRACT_MAX,
  MEMORY_EXTRACT_PERSON_CHARS,
  MEMORY_REFLECT_INPUT,
  MEMORY_REFLECT_MAX,
  MEMORY_REVIEW_MS,
  MEMORY_SAME_SIMILARITY,
} from './config.ts'
import {
  MEMORY_KINDS,
  type Memory,
  type MemoryKind,
  normalizeMemoryText,
  sensitive,
  similarity,
} from './memory.ts'
import type { ModelResolver } from './models.ts'
import { completeSimple } from './omp/ai.ts'
import { hasSubstantiveContent, stripMemoryTags } from './omp/memory.ts'
import { prompts } from './prompts.ts'
import { hideInContext } from './provider-secrets.ts'

/**
 * The memory reviewer: a cheap model, run after the fact like skill-learning.ts and chat naming, that never writes a
 * memory itself. Extraction reads a finished round for what the person said worth keeping; reflection reads the kept
 * memories for ones that repeat or went stale and proposes merging them. Both only propose: the person keeps or
 * discards each suggestion, and a suggestion that looks like a secret or personal data is dropped before they see it.
 */

/** One suggestion from the reviewer, checked: what to remember, and which kept memories it would take the place of. */
export interface MemorySuggestion {
  readonly text: string
  readonly kind: MemoryKind
  /** Only for the chat's project; absent for every chat. */
  readonly project?: string
  /** Kept memories this one replaces once the person keeps it. */
  readonly replaces: readonly string[]
  /** Extraction: the person's own words it rests on. Reflection: why the memories merge. */
  readonly why: string
}

/** What the person said in a round, from its start (`from`, a log seq): their own messages only, never a member's. */
export function personSaid(events: readonly MyrEvent[], from: number): string[] {
  return events
    .filter((e) => e.seq >= from && e.type === 'chat/user' && e.actor.kind === 'user')
    .map((e) => stripMemoryTags((e.payload as EventPayloads['chat/user']).text).trim())
    .filter(hasSubstantiveContent)
}

/** The round's last final answer, which helps read a short "yes, do that" but is never evidence. */
export function finalAnswer(events: readonly MyrEvent[], from: number): string | undefined {
  return events
    .filter(
      (e) => e.seq >= from && e.type === 'chat/reply' && (e.payload as EventPayloads['chat/reply']).final,
    )
    .map((e) => (e.payload as EventPayloads['chat/reply']).text)
    .at(-1)
}

async function ask(resolver: ModelResolver, model: string, system: string, user: string): Promise<string> {
  const resolved = resolver.resolve(model)
  const apiKey = await resolver.requireApiKey(resolved.model)
  const context = {
    systemPrompt: [system],
    messages: [{ role: 'user' as const, content: user, timestamp: Date.now() }],
  }
  const signal = AbortSignal.timeout(MEMORY_REVIEW_MS)
  const reply = resolved.streamFn
    ? await (await resolved.streamFn(resolved.model, hideInContext(context), { apiKey, signal })).result()
    : await completeSimple(resolved.model, hideInContext(context), { apiKey, signal })
  if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'the memory reviewer failed')
  return reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
}

/** The reviewer's `{"memories": [...]}` items, or none when it answered with anything else. */
function items(text: string): Record<string, unknown>[] {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return []
  try {
    const raw = JSON.parse(json) as { memories?: unknown }
    return Array.isArray(raw.memories)
      ? raw.memories.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      : []
  } catch {
    return []
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A suggested text as a memory would hold it, or nothing when it is unusable or must not be kept. */
function usable(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const text = normalizeMemoryText(raw)
    return sensitive(text) ? undefined : text
  } catch {
    return undefined
  }
}

const kindOf = (raw: unknown): MemoryKind | undefined =>
  (MEMORY_KINDS as readonly unknown[]).includes(raw) ? (raw as MemoryKind) : undefined

/**
 * Holds the extractor's answer to the rules (after omp's sharpshooter extraction, whose evidence must be an exact
 * substring of the user's prompt): each memory rests on a quote of the person's own words, so nothing the crew, a web
 * page or a file said becomes one; it is new (not what a kept or waiting memory already says) unless it replaces a
 * kept one; and it holds no secret or personal data.
 */
export function checkExtracted(
  raw: readonly Record<string, unknown>[],
  input: { said: readonly string[]; project?: string; known: readonly Memory[] },
): MemorySuggestion[] {
  const said = squash(input.said.join('\n')).toLowerCase()
  const kept = new Map(input.known.filter((m) => m.status === 'active').map((m) => [m.id, m]))
  const out: MemorySuggestion[] = []
  for (const r of raw) {
    const text = usable(r.text)
    const kind = kindOf(r.kind)
    const evidence = typeof r.evidence === 'string' ? squash(r.evidence) : ''
    if (
      !text ||
      !kind ||
      evidence.length < 3 ||
      !said.includes(evidence.toLowerCase()) ||
      sensitive(evidence)
    )
      continue
    const replaces = (Array.isArray(r.replaces) ? r.replaces : []).filter(
      (id): id is string => typeof id === 'string' && kept.has(id),
    )
    const project = r.scope === 'project' && input.project ? input.project : undefined
    const repeats = [...input.known, ...out.map((s) => ({ ...s, id: '' }))].some(
      (m) =>
        !replaces.includes(m.id) &&
        (m.project ?? '') === (project ?? '') &&
        similarity(m.text, text) >= MEMORY_SAME_SIMILARITY,
    )
    if (repeats) continue
    out.push({ text, kind, ...(project ? { project } : {}), replaces, why: evidence })
    if (out.length >= MEMORY_EXTRACT_MAX) break
  }
  return out
}

/** Reads what the person said in a round for something worth remembering; proposals only, checked. */
export async function extractMemories(input: {
  resolver: ModelResolver
  model: string
  said: readonly string[]
  answer?: string
  /** The chat's project, when it has one: memories may be scoped to it. */
  project?: { id: string; name: string }
  /** Kept and waiting memories the round could see, so known things are not suggested again. */
  known: readonly Memory[]
}): Promise<MemorySuggestion[]> {
  let budget = MEMORY_EXTRACT_PERSON_CHARS
  const said = input.said.flatMap((s) => {
    if (budget <= 0) return []
    const cut = s.slice(0, budget)
    budget -= cut.length
    return [cut]
  })
  if (!said.length) return []
  const reply = await ask(
    input.resolver,
    input.model,
    prompts.memoryReview.extractSystem,
    prompts.memoryReview.extract({
      said,
      ...(input.answer ? { answer: input.answer.slice(0, MEMORY_EXTRACT_ANSWER_CHARS) } : {}),
      project: input.project !== undefined,
      known: input.known.map((m) => ({ id: m.id, kind: m.kind, text: m.text })),
    }),
  )
  return checkExtracted(items(reply), {
    said,
    ...(input.project ? { project: input.project.id } : {}),
    known: input.known,
  })
}

/**
 * Holds the reflector's answer to the rules: each proposal replaces two or more kept memories of one scope (or
 * rewrites one), none it already proposed to replace, with a text that is no secret, after omp's consolidation rules
 * ("merge same-topic deltas into one bullet", "newest wins").
 */
export function checkReflected(
  raw: readonly Record<string, unknown>[],
  input: { kept: readonly Memory[]; waiting: readonly Memory[] },
): MemorySuggestion[] {
  const kept = new Map(input.kept.map((m) => [m.id, m]))
  const taken = new Set(input.waiting.flatMap((m) => m.replaces ?? []))
  const out: MemorySuggestion[] = []
  for (const r of raw) {
    const text = usable(r.text)
    const ids = [...new Set(Array.isArray(r.replaces) ? r.replaces : [])]
    // One id it may not replace (unknown, or in another suggestion) and the merge it meant is not this one.
    if (!ids.every((id): id is string => typeof id === 'string' && kept.has(id) && !taken.has(id))) continue
    const olds = ids.map((id) => kept.get(id) as Memory)
    const scopes = new Set(olds.map((m) => m.project ?? ''))
    if (!text || !olds.length || scopes.size !== 1) continue
    // A rewrite of one memory must say something different; a merge may keep the newest one's words.
    if (olds.length === 1 && similarity(olds[0]?.text ?? '', text) >= MEMORY_SAME_SIMILARITY) continue
    const newest = [...olds].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] as Memory
    const project = newest.project
    out.push({
      text,
      kind: kindOf(r.kind) ?? newest.kind,
      ...(project ? { project } : {}),
      replaces: ids,
      why: typeof r.why === 'string' ? squash(r.why).slice(0, 300) : '',
    })
    for (const id of ids) taken.add(id)
    if (out.length >= MEMORY_REFLECT_MAX) break
  }
  return out
}

/** Reads kept memories for ones that repeat, overlap or went stale, and proposes merged ones; proposals only. */
export async function reflectMemories(input: {
  resolver: ModelResolver
  model: string
  kept: readonly Memory[]
  /** Proposals still waiting: memories they replace are not proposed again. */
  waiting: readonly Memory[]
  /** Project ids to names, for the reviewer to tell scopes apart. */
  projects: ReadonlyMap<string, string>
}): Promise<MemorySuggestion[]> {
  const kept = [...input.kept]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MEMORY_REFLECT_INPUT)
  if (kept.length < 2) return []
  const reply = await ask(
    input.resolver,
    input.model,
    prompts.memoryReview.reflectSystem,
    prompts.memoryReview.reflect(
      kept.map((m) => ({
        id: m.id,
        kind: m.kind,
        text: m.text,
        scope: m.project ? (input.projects.get(m.project) ?? m.project) : undefined,
        date: m.updatedAt.slice(0, 10),
      })),
    ),
  )
  return checkReflected(items(reply), { kept, waiting: input.waiting })
}
