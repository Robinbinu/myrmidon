import { join } from 'node:path'
import { BlobStore, type SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type ColonyStatus, foldColony } from '@myrmidon/protocol'
import { completeSimple } from '@oh-my-pi/pi-ai'
import { ColonyRun, type Runtime } from './colony.ts'
import type { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { type SettingsStore, TOOL_GROUPS, type ToolGroup } from './settings.ts'
import type { AgentSpec, ColonySpec, Tier } from './spec.ts'
import type { WebTools } from './web.ts'

const MAX_WORKERS = 8

export interface RosterEntry {
  /** What this teammate is for, e.g. `researcher`, `coder`, `writer`; `peer` for an unspecialised swarm peer. */
  readonly role: string
  readonly model: string
}

export interface TeamConfig {
  /** `orchestrated`: a lead assigns tasks to specialists; `swarm`: equal peers share notes and tasks. */
  readonly mode: 'orchestrated' | 'swarm'
  /** The lead's model, also used for direct answers and one-agent rounds. */
  readonly leadModel: string
  /** Specialists (orchestrated) or peers (swarm), up to 8. */
  readonly roster: readonly RosterEntry[]
  /** Orchestrated only: how many more specialists the lead may add. */
  readonly extraWorkers?: number
  readonly judgeModel: string
  readonly wallMinutes?: number
}

/** Accepts the current team config or the older `{ mode: 'auto' | 'manual', workers, workerModel }` shape. */
export function normalizeTeamConfig(raw: Record<string, unknown>): TeamConfig {
  const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)
  const leadModel = str(raw.leadModel)
  const judgeModel = str(raw.judgeModel, leadModel)
  const wall = typeof raw.wallMinutes === 'number' ? { wallMinutes: raw.wallMinutes } : {}
  if (raw.mode === 'orchestrated' || raw.mode === 'swarm') {
    const roster = (Array.isArray(raw.roster) ? raw.roster : [])
      .filter(
        (r): r is RosterEntry => typeof r?.role === 'string' && typeof r?.model === 'string' && !!r.model,
      )
      .slice(0, MAX_WORKERS)
      .map((r) => ({ role: r.role.trim().slice(0, 40) || 'worker', model: r.model }))
    const extra = typeof raw.extraWorkers === 'number' ? Math.max(0, Math.floor(raw.extraWorkers)) : 0
    return { mode: raw.mode, leadModel, roster, extraWorkers: extra, judgeModel, ...wall }
  }
  const workers = Math.min(Math.max(0, Math.floor(Number(raw.workers) || 0)), MAX_WORKERS)
  const workerModel = str(raw.workerModel, leadModel)
  return raw.mode === 'manual'
    ? {
        mode: 'orchestrated',
        leadModel,
        roster: Array.from({ length: workers }, () => ({ role: 'worker', model: workerModel })),
        extraWorkers: 0,
        judgeModel,
        ...wall,
      }
    : { mode: 'orchestrated', leadModel, roster: [], extraWorkers: workers, judgeModel, ...wall }
}

/** Decides how much machinery a request needs before any agent starts. */
export type Classify = (request: string, history: string) => Promise<Tier>

const TRIAGE = `You route requests for Myrmidon, a system that runs teams of AI agents. Classify the person's newest
message into exactly one tier and reply with JSON only: {"tier":"answer"} or {"tier":"solo"} or {"tier":"team"}.
- answer: conversation, greetings, opinions, explanations, definitions, quick facts, short how-to answers, and
  questions about Myrmidon or what it can do. One agent replies directly, maybe after a quick web search.
- solo: one concrete deliverable a single capable agent can finish in a few steps: a small script or page, a short
  document, a focused research summary, a fix to an earlier file.
- team: large or multi-part work that benefits from several specialists in parallel: an app with several parts,
  broad research across many sources, a document plus code plus tests. Also short follow-ups like "go" or
  "continue" when the earlier conversation was team work.
When unsure between two tiers, pick the smaller one.`

/** The default classifier: one short call to the lead's model. Scripted test models skip it. */
export function llmClassifier(resolver: ModelResolver, model: () => string): Classify {
  return async (request, history) => {
    const resolved = resolver.resolve(model())
    if (resolved.streamFn || resolved.model.api === 'mock') return 'team'
    const reply = await Promise.race([
      completeSimple(
        resolved.model,
        {
          systemPrompt: [TRIAGE],
          messages: [
            {
              role: 'user',
              content: `${history ? `Earlier in the conversation:\n${history.slice(-3000)}\n\n` : ''}Newest message: ${request.slice(0, 4000)}`,
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: await resolver.requireApiKey(resolved.model) },
      ),
      Bun.sleep(25_000).then(() => undefined),
    ])
    if (!reply) throw new Error('triage timed out')
    if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'triage call failed')
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    const tier = /"tier"\s*:\s*"(answer|solo|team)"/.exec(text)?.[1]
    if (!tier) throw new Error(`triage gave no tier: ${text.slice(0, 120)}`)
    return tier as Tier
  }
}

export interface ChatRound {
  readonly colonyId: string
  readonly round: number
  readonly status: ColonyStatus
  readonly request: string
}

export interface ChatSummary {
  readonly chatId: string
  readonly title: string
  readonly updatedAt: string
  readonly status: ColonyStatus
  readonly rounds: ChatRound[]
}

const RUBRIC = `Judge whether the colony did what the person asked, completely and correctly.
- Every part of the request is addressed; nothing is silently skipped.
- Claims are accurate; when the request asks for research or sources, they are cited. Code is correct and complete
  (no placeholders).
- The final answer and any delivered files are consistent with each other and usable as described.
- The response fits the request: a simple question deserves a direct answer, not a report.
Score 1.0 only for work you would hand to the person as-is.`

/** The earlier rounds of a chat as `User:` / `Colony:` pairs, for context in the next round. */
function conversation(previous: { state: ColonyState }[]): string {
  return previous
    .map(({ state }) => {
      const replies = state.chatMessages.filter((m) => m.from !== 'user')
      const final = replies.filter((m) => m.final).at(-1) ?? replies.at(-1)
      return `User: ${state.chat?.request ?? ''}\nColony (${state.status}): ${final?.text ?? '(no reply)'}`
    })
    .join('\n\n')
}

function newChatId() {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function title(text: string) {
  const line = text.trim().split('\n')[0] ?? 'Chat'
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

/** Conversations as sequences of colony rounds. Follow-ups after a round ends start a new round on its files. */
export class ChatService {
  private readonly _live = new Map<string, ColonyRun>()
  private readonly _sending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly runtime: Runtime,
    private readonly options: {
      resolver: ModelResolver
      unsafeNoSandbox?: boolean
      settings?: SettingsStore
      web?: WebTools
      /** Defaults to one short call to the lead's model; see `llmClassifier`. */
      classify?: Classify
    },
  ) {}

  private get store() {
    return this.runtime.ctx.logStore as SqliteLogStore
  }

  private async rounds(): Promise<Map<string, { state: ColonyState; id: string }[]>> {
    const byChat = new Map<string, { state: ColonyState; id: string }[]>()
    for (const id of await this.store.colonies()) {
      const live = [...this._live.values()].find((r) => r.id === id)
      const state = live ? live.state() : foldColony(id, await this.store.read(id))
      if (!state.chat) continue
      const list = byChat.get(state.chat.chatId) ?? []
      list.push({ state, id })
      byChat.set(state.chat.chatId, list)
    }
    for (const list of byChat.values())
      list.sort((a, b) => (a.state.chat?.round ?? 0) - (b.state.chat?.round ?? 0))
    return byChat
  }

  async list(): Promise<ChatSummary[]> {
    const out: ChatSummary[] = []
    for (const [chatId, list] of await this.rounds()) {
      const last = list.at(-1)
      const first = list[0]
      if (!last || !first) continue
      const renamed = list
        .map((r) => r.state.chatTitle)
        .filter((t) => t !== undefined)
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1)
      out.push({
        chatId,
        title: renamed?.title ?? title(first.state.chat?.request ?? first.state.name),
        updatedAt: last.state.endedAt ?? last.state.createdAt ?? '',
        status: last.state.status,
        rounds: list.map((r) => ({
          colonyId: r.id,
          round: r.state.chat?.round ?? 0,
          status: r.state.status,
          request: r.state.chat?.request ?? '',
        })),
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Delivers to the running round if there is one; otherwise starts a new round. Sends to one chat are
   * serialized: a second request that arrives while a round is still starting (a double-clicked retry)
   * waits for it and goes to its lead, instead of starting a second colony that nothing can stop.
   */
  async send(
    text: string,
    config: TeamConfig,
    chatId?: string,
  ): Promise<{ chatId: string; colonyId: string; started: boolean }> {
    const message = text.trim()
    if (!message) throw new Error('message is empty')
    const id = chatId ?? newChatId()
    const turn = (this._sending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliver(id, message, config))
    this._sending.set(id, turn)
    try {
      return await turn
    } finally {
      if (this._sending.get(id) === turn) this._sending.delete(id)
    }
  }

  private async deliver(
    id: string,
    message: string,
    config: TeamConfig,
  ): Promise<{ chatId: string; colonyId: string; started: boolean }> {
    const live = this._live.get(id)
    if (live && live.state().status === 'running') {
      await live.postUserMessage(message)
      return { chatId: id, colonyId: live.id, started: false }
    }
    const previous = (await this.rounds()).get(id) ?? []
    const history = conversation(previous)
    const classify = this.options.classify ?? llmClassifier(this.options.resolver, () => config.leadModel)
    // One retry, then one agent with every tool: it can do anything a single agent can without waking a team.
    const tier = await classify(message, history)
      .catch(() => classify(message, history))
      .catch((err) => {
        console.warn(`triage failed, running solo: ${err instanceof Error ? err.message : String(err)}`)
        return 'solo' as const
      })
    const run = new ColonyRun(this.runtime, this.buildSpec(id, message, config, previous, history, tier), {
      resolver: this.options.resolver,
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
    })
    const prior = previous.at(-1)
    // The opening message is logged before any agent exists, so it reaches the lead once, via kickoff.
    run.beforeStart(async () => {
      if (prior) await this.carryOver(prior, run)
      await run.append({ type: 'chat/user', actor: { kind: 'user', id: 'user' }, payload: { text: message } })
    })
    this._live.set(id, run)
    try {
      await run.start()
    } catch (err) {
      this._live.delete(id)
      throw err
    }
    void run.done.finally(() => {
      if (this._live.get(id) === run) this._live.delete(id)
    })
    return { chatId: id, colonyId: run.id, started: true }
  }

  /** Renames a conversation; recorded in its latest round's log, so the name survives restarts. */
  async rename(chatId: string, name: string): Promise<string> {
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('title is empty')
    if (clean.length > 120) throw new Error('title is longer than 120 characters')
    const latest = ((await this.rounds()).get(chatId) ?? []).at(-1)
    if (!latest) throw new Error('no such chat')
    const draft = {
      type: 'chat/renamed',
      actor: { kind: 'user', id: 'user' },
      payload: { title: clean },
    } as const
    const live = this._live.get(chatId)
    if (live?.id === latest.id) await live.append(draft)
    else await this.runtime.ctx.log.appendOne(latest.id as never, draft)
    return clean
  }

  async stop(chatId: string): Promise<void> {
    await this._live.get(chatId)?.stop('stopped by user')
  }

  /** Permanently deletes every round of a chat, stopping a running round first. Returns the deleted colony ids. */
  async delete(chatId: string): Promise<string[]> {
    const live = this._live.get(chatId)
    if (live) {
      await live.stop('chat deleted')
      await live.done
      this._live.delete(chatId)
    }
    const rounds = (await this.rounds()).get(chatId) ?? []
    for (const { id } of rounds) this.store.deleteColony(id as never)
    return rounds.map((r) => r.id)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this._live.values()].map((r) => r.stop('server shutting down')))
  }

  private buildSpec(
    chatId: string,
    request: string,
    config: TeamConfig,
    previous: { state: ColonyState }[],
    history: string,
    requested: Tier,
  ): ColonySpec {
    const s = this.options.settings?.get()
    const leadNote = s?.instructions.lead?.trim()
    const workerNote = s?.instructions.worker?.trim()
    const roster = config.roster.slice(0, MAX_WORKERS)
    const extra = config.mode === 'orchestrated' ? Math.max(0, config.extraWorkers ?? 0) : 0
    // A team with nobody to delegate to is one agent working alone.
    const tier: Tier =
      requested === 'team' && config.mode === 'orchestrated' && roster.length === 0 && extra === 0
        ? 'solo'
        : requested
    const taken = new Set(['lead'])
    const crew = (role: 'worker' | 'peer'): AgentSpec[] =>
      roster.map((r) => {
        const name = pickName(taken)
        taken.add(name)
        return {
          name,
          role,
          model: r.model,
          ...(r.role && r.role !== 'peer' && r.role !== 'worker' ? { specialty: r.role } : {}),
          ...(workerNote ? { instructions: workerNote } : {}),
        }
      })
    const lead: AgentSpec = {
      name: 'lead',
      role: 'lead',
      model: config.leadModel,
      ...(leadNote ? { instructions: leadNote } : {}),
    }
    const swarm = tier === 'team' && config.mode === 'swarm'
    const agents: AgentSpec[] =
      tier !== 'team'
        ? [lead]
        : swarm
          ? roster.length > 0
            ? crew('peer')
            : [0, 1].map(() => {
                const name = pickName(taken)
                taken.add(name)
                return { name, role: 'peer', model: config.leadModel }
              })
          : [lead, ...crew('worker')]
    const disabledTools = s
      ? (Object.keys(TOOL_GROUPS) as ToolGroup[])
          .filter((g) => !s.tools[g])
          .flatMap((g) => [...TOOL_GROUPS[g]])
      : []
    const wallMs = Math.round((config.wallMinutes ?? s?.team.wallMinutes ?? 30) * 60_000)
    const models = [...new Set([...roster.map((r) => r.model), config.leadModel])]
    return {
      name: title(request),
      mission: history
        ? `${request}\n\n(Context from earlier rounds of this conversation)\n${history}`
        : request,
      pattern: swarm ? 'blackboard' : 'lead-workers',
      agents,
      acceptance:
        tier === 'answer'
          ? []
          : [
              {
                verifier: 'llm-judge',
                model: config.judgeModel,
                rubric: s?.verification.rubric?.trim() || RUBRIC,
                threshold: s?.verification.threshold ?? 0.7,
              },
            ],
      budget:
        tier === 'answer'
          ? { wallMs: Math.min(wallMs, 4 * 60_000), maxTurns: 4 }
          : { wallMs, maxTurns: s?.team.maxTurns ?? 40 },
      observer: { intervalMs: (s?.observer.intervalSeconds ?? 45) * 1000 },
      ...(disabledTools.length ? { disabledTools } : {}),
      chat: { chatId, round: previous.length + 1, request, history },
      tier,
      team: {
        mode: config.mode,
        maxWorkers: tier === 'team' && !swarm ? roster.length + extra : 0,
        workerModels: models,
      },
    }
  }

  /** Carries the previous round's files and plan into a new round, so follow-ups build on them. */
  private async carryOver(prior: { state: ColonyState; id: string }, run: ColonyRun) {
    await this.carryArtifacts(prior, run)
    const plan = prior.state.notes.filter((n) => n.section === 'plan').at(-1)
    if (plan)
      await run.append({
        type: 'note/appended',
        actor: { kind: 'user', id: 'previous-round' },
        payload: {
          agent: 'previous-round',
          text: `Plan from the previous round:\n${plan.text}`,
          section: 'plan',
        },
      })
  }

  private async carryArtifacts(prior: { state: ColonyState; id: string }, run: ColonyRun) {
    const source = new BlobStore(join(this.store.colonyDir(prior.id as never), 'blobs'))
    for (const [name, versions] of Object.entries(prior.state.artifacts)) {
      const latest = versions.at(-1)
      if (!latest) continue
      const { hash, size } = await run.blobs.put(await source.get(latest.blob))
      await run.append({
        type: 'artifact/versioned',
        actor: { kind: 'user', id: 'previous-round' },
        payload: {
          name,
          version: 1,
          blob: hash,
          size,
          author: 'previous-round',
          mediaType: latest.mediaType,
        },
      })
    }
  }
}
