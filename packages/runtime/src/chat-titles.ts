import { completeSimple } from '@oh-my-pi/pi-ai'
import { CHAT_TITLE_MIN_WINDOW, CHAT_TITLE_MS, CHAT_TITLE_TIERS } from './config.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'

/** How much of the person's messages and the crew's answer the namer reads. */
const ASKED_CHARS = 2_000
const ANSWER_CHARS = 1_500

/**
 * Names a chat from what it is about (as ChatGPT and Open WebUI do after the first exchange), instead of its first
 * message, which may be "hi". Returns nothing while there is not enough to go on, so the chat is named later.
 */
export async function nameChat(
  resolver: ModelResolver,
  model: string,
  input: { asked: readonly string[]; answer?: string },
): Promise<string | undefined> {
  const resolved = resolver.resolve(model)
  const apiKey = await resolver.requireApiKey(resolved.model)
  let budget = ASKED_CHARS
  const asked = input.asked.flatMap((a) => {
    if (budget <= 0) return []
    const cut = a.slice(0, budget)
    budget -= cut.length
    return [cut.replace(/\s+/g, ' ').trim()]
  })
  const context = {
    systemPrompt: [prompts.chatTitle.system],
    messages: [
      {
        role: 'user' as const,
        content: prompts.chatTitle.facts({
          asked,
          ...(input.answer ? { answer: input.answer.slice(0, ANSWER_CHARS) } : {}),
        }),
        timestamp: Date.now(),
      },
    ],
  }
  const signal = AbortSignal.timeout(CHAT_TITLE_MS)
  const reply = resolved.streamFn
    ? await (await resolved.streamFn(resolved.model, context, { apiKey, signal })).result()
    : await completeSimple(resolved.model, context, { apiKey, signal })
  if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'the model failed')
  return parseTitle(reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(''))
}

/** A model the person can use, as far as picking one to name chats needs to know it. */
export interface TitleCandidate {
  readonly provider: string
  readonly id: string
  /** Dollars per million input tokens; 0 or absent when unknown (or free, which omp does not tell apart). */
  readonly inputPrice?: number
  readonly contextWindow?: number | null
}

/**
 * The model that names chats: a small job, so the cheapest model will do. Among the person's models with room for
 * the request (`CHAT_TITLE_MIN_WINDOW`), the lowest known input price wins; with no prices known, the best fast tier
 * by name (`CHAT_TITLE_TIERS`). Ties go to the lead's provider, whose credentials the run just used. With nothing
 * to pick from, the lead's own model.
 */
export function titleModel(candidates: readonly TitleCandidate[], lead: string): string {
  const leadProvider = lead.slice(0, lead.indexOf('/'))
  const fits = candidates.filter((m) => !m.contextWindow || m.contextWindow >= CHAT_TITLE_MIN_WINDOW)
  const ref = (m: TitleCandidate) => `${m.provider}/${m.id}`
  const tier = (m: TitleCandidate) => {
    const words = m.id.toLowerCase().split(/[^a-z0-9]+/)
    const at = CHAT_TITLE_TIERS.findIndex((t) => words.includes(t))
    return at < 0 ? CHAT_TITLE_TIERS.length : at
  }
  const byPreference = (a: TitleCandidate, b: TitleCandidate) =>
    Number(b.provider === leadProvider) - Number(a.provider === leadProvider) ||
    tier(a) - tier(b) ||
    ref(a).localeCompare(ref(b))
  const priced = fits.filter((m) => (m.inputPrice ?? 0) > 0)
  if (priced.length)
    return ref(
      [...priced].sort(
        (a, b) => (a.inputPrice ?? 0) - (b.inputPrice ?? 0) || byPreference(a, b),
      )[0] as TitleCandidate,
    )
  const tiered = fits.filter((m) => tier(m) < CHAT_TITLE_TIERS.length).sort(byPreference)
  return tiered[0] ? ref(tiered[0]) : lead
}

/** The model's JSON as a usable name, or nothing (it had nothing to name, or answered badly). */
export function parseTitle(text: string): string | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return undefined
  let raw: { title?: unknown }
  try {
    raw = JSON.parse(json) as { title?: unknown }
  } catch {
    return undefined
  }
  if (typeof raw.title !== 'string') return undefined
  const title = raw.title
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || title.length > 60 || /^(chat|conversation|new chat)$/i.test(title)) return undefined
  return title
}
