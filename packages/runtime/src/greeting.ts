import { completeSimple } from '@oh-my-pi/pi-ai'
import type { ChatSummary } from './chat.ts'
import { GREETING_AWAY_MS, GREETING_MS } from './config.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'

/**
 * The entry page's greeting: one short line in the mascot's own voice, about what actually happened (something
 * waiting on the person, failed or finished while they were away, still running) or, when nothing did, about the
 * time and day. Rules write it at once; a model may write a fresher one from the same facts.
 */
export interface Greeting {
  readonly headline: string
}

export interface GreetingFacts {
  readonly name: string
  /** The person's local time. */
  readonly now: Date
  /** When the person last had Myrmidon open; absent on a first visit. */
  readonly lastSeen?: Date
  readonly chats: readonly Pick<ChatSummary, 'chatId' | 'title' | 'status' | 'updatedAt' | 'awaiting'>[]
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Picks one of several phrasings, the same one all day, so the page does not change on every visit. */
function variant<T>(facts: GreetingFacts, kind: string, options: readonly T[]): T {
  const seed = `${facts.now.toDateString()}:${kind}`
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0
  return options[Math.abs(h) % options.length] as T
}

/** What there is to say, most important first: the facts a greeting is written from. */
export function greetingNews<C extends GreetingFacts['chats'][number]>(
  facts: Omit<GreetingFacts, 'chats'> & { readonly chats: readonly C[] },
) {
  const since = facts.lastSeen?.getTime() ?? 0
  const done = (s: string) => s === 'completed' || s === 'failed' || s === 'stopped'
  return {
    awaiting: facts.chats.filter((c) => c.awaiting),
    running: facts.chats.filter((c) => c.status === 'running' && !c.awaiting),
    failed: facts.chats.filter((c) => c.status === 'failed' && Date.parse(c.updatedAt) > since),
    finished: facts.chats.filter(
      (c) => c.status === 'completed' && !c.awaiting && since > 0 && Date.parse(c.updatedAt) > since,
    ),
    away: facts.lastSeen ? facts.now.getTime() - facts.lastSeen.getTime() : undefined,
    first: facts.chats.length === 0 && !facts.lastSeen,
    latest: facts.chats.find((c) => done(c.status)),
  }
}

export function ruleGreeting(facts: GreetingFacts): Greeting {
  const name = facts.name
  const say = prompts.greeting.lines
  const news = greetingNews(facts)
  const hour = facts.now.getHours()
  const day = DAYS[facts.now.getDay()] ?? ''
  const back = (news.away ?? 0) > GREETING_AWAY_MS
  const line = (headline: string): Greeting => ({ headline })

  if (news.awaiting.length > 1) return line(say.waitingMany(news.awaiting.length, name))
  if (news.awaiting.length) return line(say.waitingOne(name))
  // A chat's title is the person's own first message, often long or a bare "hi", so the line never quotes it.
  if (news.failed.length) return line(say.failed(name))
  if (news.finished.length > 1) return line(say.finishedMany(name, news.finished.length))
  if (news.finished.length) return line(say.finishedOne(name))
  if (news.running.length > 1) return line(say.runningMany(name, news.running.length))
  if (news.running.length) return line(say.runningOne(name))
  if (news.first) return line(say.first(name))
  const days = Math.floor((news.away ?? 0) / 86_400_000)
  if (days >= 3) return line(variant(facts, 'away', say.away(name, days)))
  if (hour < 5) return line(variant(facts, 'night', say.night(name)))
  if (day === 'Monday' && hour < 12) return line(say.monday(name))
  if (day === 'Friday' && hour >= 15) return line(variant(facts, 'friday', say.friday(name)))
  if ((day === 'Saturday' || day === 'Sunday') && hour >= 8) return line(say.weekend(name))
  if (back) return line(say.back(name))
  return line(hour < 12 ? say.morning(name) : hour < 18 ? say.afternoon(name) : say.evening(name))
}

/**
 * What a greeting writer writes and how: the model's instructions, the facts as it is told them, what the line
 * depends on, how its reply is read, and the rules' greeting that stands in for it.
 */
export interface GreetingStyle<F extends GreetingFacts, G> {
  readonly system: string
  brief(facts: F): Record<string, unknown>
  /** What the greeting depends on: the same key gets the same greeting back without another call. */
  key(facts: F): string
  parse(text: string, facts: F): G
  rules(facts: F): G
}

/** What the news a greeting tells of depends on: it changes with the news and the part of the day, not every minute. */
export function newsKey(facts: GreetingFacts): string {
  const news = greetingNews(facts)
  const ids = (cs: readonly { chatId: string }[]) => cs.map((c) => c.chatId).join(',')
  return [
    facts.name,
    facts.now.toDateString(),
    Math.floor(facts.now.getHours() / 6),
    ids(news.awaiting),
    ids(news.running),
    ids(news.failed),
    ids(news.finished),
    Math.floor((news.away ?? 0) / 86_400_000),
  ].join('|')
}

/** The entry page's line. */
const PAGE: GreetingStyle<GreetingFacts, Greeting> = {
  system: prompts.greeting.system,
  brief: (facts) => {
    const news = greetingNews(facts)
    const brief = (cs: typeof facts.chats) => cs.slice(0, 4).map((c) => c.title)
    return {
      name: facts.name,
      localTime: facts.now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      awayFor: news.away === undefined ? 'first visit' : `${Math.round(news.away / 60_000)} minutes`,
      waitingOnYou: brief(news.awaiting),
      failedWhileAway: brief(news.failed),
      finishedWhileAway: brief(news.finished),
      stillRunning: brief(news.running),
      lastChat: news.latest?.title,
    }
  },
  key: newsKey,
  parse: (text) => parseGreeting(text),
  rules: ruleGreeting,
}

/**
 * Lets a model write the greeting from the facts, once per change in them: the same facts get the same line back
 * without another call. It never blocks the page: until the model answers (or if it fails), the rules' line stands.
 * The entry page's line by default; a call's greeting has a style of its own (voice/greeting.ts).
 */
export class GreetingWriter<F extends GreetingFacts = GreetingFacts, G = Greeting> {
  private readonly _written = new Map<string, G>()
  private readonly _pending = new Set<string>()

  constructor(
    private readonly resolver: ModelResolver,
    private readonly style: GreetingStyle<F, G> = PAGE as unknown as GreetingStyle<F, G>,
  ) {}

  /** The model's greeting for these facts if it has written one; otherwise starts writing it and returns undefined. */
  written(facts: F, model: string): G | undefined {
    const key = this.style.key(facts)
    const done = this._written.get(key)
    if (done || this._pending.has(key)) return done
    this._pending.add(key)
    this._write(facts, model)
      .then((g) => {
        if (this._written.size > 50) this._written.clear()
        this._written.set(key, g)
      })
      .catch((err) => {
        console.error(`the greeting could not be written: ${err instanceof Error ? err.message : err}`)
        // The rules' line stands for these facts, so a failing model is not asked again on every visit.
        this._written.set(key, this.style.rules(facts))
      })
      .finally(() => this._pending.delete(key))
    return undefined
  }

  private async _write(facts: F, ref: string): Promise<G> {
    const resolved = this.resolver.resolve(ref)
    const apiKey = await this.resolver.requireApiKey(resolved.model)
    const context = {
      systemPrompt: [this.style.system],
      messages: [
        {
          role: 'user' as const,
          content: prompts.greeting.facts(this.style.brief(facts)),
          timestamp: Date.now(),
        },
      ],
    }
    const abort = AbortSignal.timeout(GREETING_MS)
    const reply = resolved.streamFn
      ? await (await resolved.streamFn(resolved.model, context, { apiKey, signal: abort })).result()
      : await completeSimple(resolved.model, context, { apiKey, signal: abort })
    if (reply.stopReason === 'aborted')
      throw new Error(`${ref} did not answer within ${GREETING_MS / 1000} s; the rules' line stands`)
    if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'the model failed')
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    return this.style.parse(text, facts)
  }
}

/** The model's JSON, held to what one line on the page can show. */
export function parseGreeting(text: string): Greeting {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) throw new Error(`no JSON in the greeting: ${text.slice(0, 120)}`)
  const raw = JSON.parse(json) as { headline?: unknown }
  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : ''
  if (!headline || headline.length > 48) throw new Error(`unusable headline: ${JSON.stringify(raw.headline)}`)
  return { headline }
}

/** The person's name from their computer account (macOS full name, or the passwd entry's), else the login name. */
export function accountName(): string {
  const login = process.env.USER ?? process.env.USERNAME ?? ''
  try {
    const full =
      process.platform === 'darwin'
        ? Bun.spawnSync(['id', '-F']).stdout.toString().trim()
        : (Bun.spawnSync(['getent', 'passwd', login]).stdout.toString().split(':')[4] ?? '')
            .split(',')[0]
            ?.trim()
    const first = full?.split(/\s+/)[0]
    if (first) return first
  } catch {
    // No such command on this system: the login name will do.
  }
  return login ? login[0]?.toUpperCase() + login.slice(1) : 'there'
}
