import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { completeSimple } from '@oh-my-pi/pi-ai'
import { SKILL_DIGEST_CHARS, SKILL_REVIEW_MS } from './config.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'
import type { SkillLibrary } from './skills.ts'

/**
 * Skills learned from finished work, as Qwen Code and Hermes do it: after a round that took real work (or when the
 * person asks), a separate reviewer reads what happened and proposes a skill (or an update to one it learned
 * before) for the person to keep or discard. The working agents are never distracted by it, and the reviewer never
 * touches skills the person wrote: only skills it learned itself carry `source: learned`.
 */

export interface SkillProposal {
  readonly id: string
  readonly name: string
  readonly description: string
  /** The skill's instructions (SKILL.md below the front matter). */
  readonly body: string
  /** Why it is worth keeping, from the reviewer. */
  readonly why: string
  /** Set when this changes a learned skill: what it says now. */
  readonly update?: { readonly description: string; readonly body: string }
  readonly colonyId: string
  readonly chatId?: string
  readonly createdAt: string
  status: 'proposed' | 'kept' | 'discarded'
}

/** `<home>/skill-proposals.json`: what the reviewer proposed, and what the person did with it. */
export class SkillProposalStore {
  private readonly _file: string

  constructor(home: string) {
    this._file = join(home, 'skill-proposals.json')
  }

  list(status?: SkillProposal['status']): SkillProposal[] {
    if (!existsSync(this._file)) return []
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      const all = Array.isArray(raw) ? (raw as SkillProposal[]) : []
      return status ? all.filter((p) => p.status === status) : all
    } catch {
      return []
    }
  }

  get(id: string): SkillProposal | undefined {
    return this.list().find((p) => p.id === id)
  }

  add(p: Omit<SkillProposal, 'id' | 'createdAt' | 'status'>): SkillProposal {
    const proposal: SkillProposal = {
      ...p,
      id: `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      status: 'proposed',
    }
    // Decided proposals are history; only the latest 200 are kept.
    this._write([...this.list(), proposal].slice(-200))
    return proposal
  }

  setStatus(id: string, status: SkillProposal['status']) {
    this._write(this.list().map((p) => (p.id === id ? { ...p, status } : p)))
  }

  private _write(list: readonly SkillProposal[]) {
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`)
    renameSync(tmp, this._file)
  }
}

/** How much work a round took: the tool calls made from its start (`from`, a log seq) on. */
export function toolCallsSince(events: readonly MyrEvent[], from: number): number {
  return events.filter((e) => e.seq >= from && e.type === 'tool/call').length
}

/**
 * What happened in a round, short enough for one model call: what the person asked and said, each tool call with
 * whether it worked (failures and retries are where lessons are), and what the agents answered.
 */
export function roundDigest(events: readonly MyrEvent[], from: number): string {
  const results = new Map<string, EventPayloads['tool/result']>()
  for (const e of events)
    if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      results.set(p.callId, p)
    }
  const line = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)
  const lines: string[] = []
  for (const e of events) {
    if (e.seq < from) continue
    if (e.type === 'chat/user')
      lines.push(`[person] ${line((e.payload as EventPayloads['chat/user']).text, 1200)}`)
    else if (e.type === 'chat/reply') {
      const p = e.payload as EventPayloads['chat/reply']
      lines.push(`[${p.agent}${p.final ? ' final answer' : ''}] ${line(p.text, 1500)}`)
    } else if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      const r = results.get(p.callId)
      const outcome = r ? (r.ok ? 'ok' : `FAILED: ${line(r.output, 300)}`) : 'no result'
      lines.push(`${p.agent} ${p.tool} ${line(JSON.stringify(p.args ?? {}), 240)} → ${outcome}`)
    }
  }
  const text = lines.join('\n')
  // The start says what was asked and the end how it went; a long middle is cut.
  if (text.length <= SKILL_DIGEST_CHARS) return text
  const half = Math.floor(SKILL_DIGEST_CHARS / 2)
  return `${text.slice(0, half)}\n… (middle of the round cut) …\n${text.slice(-half)}`
}

export interface Reviewed {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly why: string
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

/** The reviewer's JSON, held to the skill format; undefined when it found nothing worth saving. */
export function parseReview(text: string): Reviewed | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return undefined
  const raw = JSON.parse(json) as Record<string, unknown>
  if (raw.skip === true || typeof raw.name !== 'string') return undefined
  const name = raw.name.trim()
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  if (!NAME.test(name)) throw new Error(`skill name must be lowercase words joined by dashes: ${name}`)
  if (description.length < 10 || description.length > 1024)
    throw new Error('skill description must be 10-1024 characters')
  if (body.length < 40 || body.length > 20_000)
    throw new Error('skill instructions must be 40-20000 characters')
  return { name, description, body, why: typeof raw.why === 'string' ? raw.why.trim().slice(0, 400) : '' }
}

/**
 * Reads a round and proposes a skill from it, or nothing. Skills it learned before are offered for updating; every
 * other skill's name is off limits, so it never overwrites one the person wrote.
 */
export async function reviewRound(input: {
  resolver: ModelResolver
  model: string
  skills: SkillLibrary
  digest: string
  /** The person asked for this review (/learn): look harder for something to keep. */
  asked: boolean
}): Promise<(Reviewed & { update?: { description: string; body: string } }) | undefined> {
  const learned = input.skills.learned()
  const others = input.skills
    .list()
    .filter((s) => !learned.some((l) => l.name === s.name))
    .map((s) => s.name)
  const resolved = input.resolver.resolve(input.model)
  const apiKey = await input.resolver.requireApiKey(resolved.model)
  const context = {
    systemPrompt: [prompts.skillReview.system],
    messages: [
      {
        role: 'user' as const,
        content: prompts.skillReview.round({
          digest: input.digest,
          learned: learned.map((l) => ({ name: l.name, description: l.description, body: l.body })),
          taken: others,
          asked: input.asked,
        }),
        timestamp: Date.now(),
      },
    ],
  }
  const signal = AbortSignal.timeout(SKILL_REVIEW_MS)
  const reply = resolved.streamFn
    ? await (await resolved.streamFn(resolved.model, context, { apiKey, signal })).result()
    : await completeSimple(resolved.model, context, { apiKey, signal })
  if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'the reviewer failed')
  const review = parseReview(reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(''))
  if (!review) return undefined
  if (others.includes(review.name))
    throw new Error(`the reviewer chose the name of a skill the person keeps (${review.name})`)
  const before = learned.find((l) => l.name === review.name)
  return before ? { ...review, update: { description: before.description, body: before.body } } : review
}
