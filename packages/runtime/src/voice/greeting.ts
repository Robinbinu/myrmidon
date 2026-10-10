import type { ChatSummary } from '../chat.ts'
import {
  VOICE_GREETING_AGAIN_MS,
  VOICE_GREETING_RECENT,
  VOICE_GREETING_TITLE_CHARS,
  VOICE_GREETING_TITLE_WORDS,
  VOICE_GREETING_WORDS,
} from '../config.ts'
import { type GreetingFacts, type GreetingStyle, GreetingWriter, greetingNews, newsKey } from '../greeting.ts'
import type { ModelResolver } from '../models.ts'
import { prompts } from '../prompts.ts'

/**
 * What a call opens with: a sentence or two, spoken, about the moment (the time, the day, how long since the last
 * call), the news that matters most (in the chat the call is in first), and an invitation to talk. Rules write it at
 * once from the facts in many phrasings; a model may write fresher lines from the same facts for a later call.
 */
export interface CallGreetingFacts extends GreetingFacts {
  readonly chats: readonly Pick<
    ChatSummary,
    'chatId' | 'title' | 'status' | 'updatedAt' | 'awaiting' | 'approving' | 'failed'
  >[]
  /** The chat the call is in. */
  readonly chatId?: string
  /** Who answers a direct call: `lead` or a crew member's name; unset for the call assistant. */
  readonly talkTo?: string
}

const DAY_MS = 86_400_000
/** Markdown, symbols a voice reads out, emoji and links: what a spoken line never holds. */
const UNSPOKEN = /[*_#`~<>[\]{}|\\/@=+^$%]|\p{Extended_Pictographic}|https?:/u
/** A word with digits in it that runs long: an id or a hash, not something to say. */
const ID_LIKE = /\b(?=[\w-]*\d)[\w-]{6,}\b/

/** Whether a line can be said as a call's greeting: short, and nothing in it a voice would stumble over. */
export function fitToSay(line: string): boolean {
  const words = line.trim().split(/\s+/).filter(Boolean)
  return (
    words.length > 0 && words.length <= VOICE_GREETING_WORDS && !UNSPOKEN.test(line) && !ID_LIKE.test(line)
  )
}

/**
 * A chat's title as it can be said aloud ("your Planning chat"), or undefined when it is too long, holds what a voice
 * cannot say, or is as slight as "hi": then the line speaks of "your last chat" instead.
 */
export function spokenTitle(title: string): string | undefined {
  const t = title.trim().replace(/[.!?]+$/, '')
  if (!t || t.length > VOICE_GREETING_TITLE_CHARS || t.split(/\s+/).length > VOICE_GREETING_TITLE_WORDS)
    return undefined
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '&-]*$/u.test(t) || !fitToSay(t)) return undefined
  return prompts.voice.greeting.slight.includes(t.toLowerCase()) ? undefined : t
}

/** How long since the last call ended, and whether that was moments ago. */
function since(facts: CallGreetingFacts) {
  const away = facts.lastSeen ? facts.now.getTime() - facts.lastSeen.getTime() : undefined
  return { away, again: away !== undefined && away >= 0 && away < VOICE_GREETING_AGAIN_MS }
}

/** The opening words for the moment, in each of their phrasings. */
function openings(facts: CallGreetingFacts): readonly string[] {
  const o = prompts.voice.greeting.open
  const n = facts.name
  const { away, again } = since(facts)
  const days = Math.floor((away ?? 0) / DAY_MS)
  const hour = facts.now.getHours()
  const day = facts.now.getDay()
  if (again) return o.again(n)
  if (days >= 3) return o.away(n, days)
  if (hour < 5) return o.night(n)
  if (day === 1 && hour < 12) return o.monday(n)
  if (day === 5 && hour >= 15) return o.friday(n)
  if ((day === 0 || day === 6) && hour >= 8) return o.weekend(n)
  return hour < 12 ? o.morning(n) : hour < 18 ? o.afternoon(n) : o.evening(n)
}

/** The chat the call is in, and the news from the others (as the entry page's greeting reads it). */
function news(facts: CallGreetingFacts) {
  const here = facts.chatId ? facts.chats.find((c) => c.chatId === facts.chatId) : undefined
  const others = facts.chats.filter((c) => c.chatId !== facts.chatId)
  const n = greetingNews({ ...facts, chats: others })
  return {
    here,
    waiting: others.filter((c) => c.awaiting || c.approving),
    failed: n.failed,
    finished: n.finished,
    running: n.running.filter((c) => !c.approving),
  }
}

/** The news that matters most, in each of its phrasings; none when there is nothing to tell. */
function newsLines(facts: CallGreetingFacts): readonly string[] {
  const say = prompts.voice.greeting
  const { here, waiting, failed, finished, running } = news(facts)
  const title = (cs: readonly { title: string }[]) => spokenTitle(cs[0]?.title ?? '')
  // What waits on the person comes first, here then elsewhere; then how this chat's last run went.
  if (here?.approving) return say.here.approval
  if (here?.awaiting) return say.here.question
  if (waiting.length > 1) return say.news.waitingMany(waiting.length)
  if (waiting.length) return say.news.waitingOne(title(waiting))
  if (here && (here.status === 'failed' || here.failed)) return say.here.failed
  if (here?.status === 'running') return say.here.running
  const fresh = (c: { updatedAt: string }) =>
    !!facts.lastSeen && Date.parse(c.updatedAt) > facts.lastSeen.getTime()
  if (here?.status === 'completed' && fresh(here)) return say.here.done
  if (failed.length > 1) return say.news.failedMany(failed.length)
  if (failed.length) return say.news.failedOne(title(failed))
  if (finished.length > 1) return say.news.finishedMany(finished.length)
  if (finished.length) return say.news.finishedOne(title(finished))
  if (running.length > 1) return say.news.runningMany(running.length)
  if (running.length) return say.news.runningOne(title(running))
  return []
}

/** Every way the rules would greet: each phrasing of the opening, who answers, the news and the invitation. */
export function callGreetingLines(facts: CallGreetingFacts): string[] {
  const say = prompts.voice.greeting
  const parts = [
    openings(facts),
    facts.talkTo ? say.who(facts.talkTo) : [],
    newsLines(facts),
    say.invite,
  ].filter((p) => p.length > 0)
  const lines = parts.reduce<string[]>(
    (acc, part) => acc.flatMap((head) => part.map((p) => (head ? `${head} ${p}` : p))),
    [''],
  )
  const fit = lines.filter(fitToSay)
  // A crew member's long name can make every line too long; the first still says who answers.
  return fit.length ? fit : lines.slice(0, 1)
}

/** The model's lines, each held to what a greeting may say; those that fall short are dropped. */
export function parseCallGreeting(text: string, facts: CallGreetingFacts): readonly string[] {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) throw new Error(`no JSON in the call greeting: ${text.slice(0, 120)}`)
  const raw = (JSON.parse(json) as { lines?: unknown }).lines
  const who =
    facts.talkTo === 'lead'
      ? /\blead\b/i
      : facts.talkTo
        ? new RegExp(`\\b${literal(facts.talkTo)}\\b`, 'i')
        : undefined
  const lines = (Array.isArray(raw) ? raw : [])
    .flatMap((l) => (typeof l === 'string' ? [l.replace(/\s+/g, ' ').trim()] : []))
    .filter((l) => fitToSay(l) && l.includes(facts.name) && (!who || who.test(l)))
  if (!lines.length) throw new Error(`no usable call greeting: ${JSON.stringify(raw)?.slice(0, 120)}`)
  return [...new Set(lines)]
}

/** `s` matched as it is in a regular expression. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A call's greeting as a model writes it: the facts it is told hold no ids, and a chat only by a title fit to say. */
const CALL: GreetingStyle<CallGreetingFacts, readonly string[]> = {
  system: prompts.voice.greeting.system,
  brief: (facts) => {
    const { here, waiting, failed, finished, running } = news(facts)
    const { away } = since(facts)
    const chats = (cs: readonly { title: string }[]) =>
      cs.slice(0, 4).map((c) => {
        const say = spokenTitle(c.title)
        return say ? { say } : {}
      })
    return {
      name: facts.name,
      localTime: facts.now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      sinceLastCall: away === undefined ? 'first call' : `${Math.round(away / 60_000)} minutes`,
      ...(facts.talkTo ? { answering: facts.talkTo === 'lead' ? 'the lead' : facts.talkTo } : {}),
      ...(here
        ? {
            thisChat: {
              lastRun: here.failed ? 'failed' : here.status,
              ...(here.approving ? { waitingOnApproval: true } : {}),
              ...(here.awaiting ? { waitingOnAnswer: true } : {}),
            },
          }
        : {}),
      waitingOnYou: chats(waiting),
      failedSinceLastCall: chats(failed),
      finishedSinceLastCall: chats(finished),
      stillRunning: chats(running),
    }
  },
  key: (facts) => {
    const { here } = news(facts)
    return [
      newsKey(facts),
      since(facts).again,
      facts.talkTo ?? '',
      here ? `${here.chatId}:${here.status}:${!!here.failed}:${!!here.awaiting}:${!!here.approving}` : '',
    ].join('|')
  },
  parse: parseCallGreeting,
  // A model that fails adds nothing: the rules' phrasings carry on.
  rules: () => [],
}

/**
 * Picks the line each call opens with, at once: it never waits on a model. Given a model (the cheap one that names
 * chats), it asks it for lines from the facts in the background, once per change in them, and a later call may open
 * with one. The person's last few lines are kept so calls in a row never open the same way.
 */
export class CallGreeter {
  private readonly _recent = new Map<string, string[]>()
  private readonly _writer?: GreetingWriter<CallGreetingFacts, readonly string[]>

  constructor(
    resolver?: ModelResolver,
    /** Which of `n` fresh lines to say; random by default. */
    private readonly pick: (n: number) => number = (n) => Math.floor(Math.random() * n),
  ) {
    if (resolver) this._writer = new GreetingWriter(resolver, CALL)
  }

  /** The line for a call starting now, which is then the person's latest. */
  line(facts: CallGreetingFacts, model?: string): string {
    const recent = this._recent.get(facts.name) ?? []
    const fresh = (lines: readonly string[]) => lines.filter((l) => !recent.includes(l))
    const rules = callGreetingLines(facts)
    const written = fresh((model && this._writer?.written(facts, model)) || [])
    const pool = written.length ? written : fresh(rules)
    // Every phrasing for these facts was said lately: the one said longest ago.
    const line =
      pool[Math.min(pool.length - 1, Math.max(0, this.pick(pool.length)))] ??
      rules.reduce((a, b) => (recent.indexOf(b) < recent.indexOf(a) ? b : a))
    this._recent.set(facts.name, [...recent.filter((l) => l !== line), line].slice(-VOICE_GREETING_RECENT))
    return line
  }
}
