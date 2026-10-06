import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlobStore, type SqliteLogStore } from '@myrmidon/core'
import {
  type AgentInfo,
  type ColonyId,
  type ColonyState,
  type ColonyStatus,
  type EventPayloads,
  foldColony,
} from '@myrmidon/protocol'
import { completeSimple } from '@oh-my-pi/pi-ai'
import { compactTranscript, readTranscript } from './agent.ts'
import { type Attachment, ColonyRun, type Runtime } from './colony.ts'
import type { McpHub } from './mcp.ts'
import type { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { type SettingsStore, TOOL_GROUPS, type ToolGroup } from './settings.ts'
import type { AcceptanceCheck, AgentSpec, ColonySpec, Tier } from './spec.ts'
import type { WebTools } from './web.ts'

const MAX_WORKERS = 8

/** The team a chat's next round inherits: the latest team round in the same mode, minus dismissed workers. */
function keptTeam(previous: readonly { state: ColonyState }[], mode: TeamConfig['mode']): AgentInfo[] {
  const last = [...previous]
    .reverse()
    .find((r) => r.state.tier === 'team' && (r.state.team?.mode === 'swarm') === (mode === 'swarm'))
  if (!last) return []
  return Object.values(last.state.agents)
    .filter((a) => a.info.role !== 'lead' && !a.dismissed && a.status !== 'failed')
    .map((a) => a.info)
}

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
  /** Overrides how hard reasoning models think in work rounds (direct answers stay quick). */
  readonly thinking?: Thinking
}

export type Thinking = 'low' | 'medium' | 'high'

/** Accepts the current team config or the older `{ mode: 'auto' | 'manual', workers, workerModel }` shape. */
export function normalizeTeamConfig(raw: Record<string, unknown>): TeamConfig {
  const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)
  const leadModel = str(raw.leadModel)
  const judgeModel = str(raw.judgeModel, leadModel)
  const thinking = ['low', 'medium', 'high'].includes(raw.thinking as string)
    ? (raw.thinking as Thinking)
    : undefined
  const wall = {
    ...(typeof raw.wallMinutes === 'number' ? { wallMinutes: raw.wallMinutes } : {}),
    ...(thinking ? { thinking } : {}),
  }
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
  /** Swarm rounds have no lead to address. */
  readonly swarm: boolean
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
      /** MCP servers whose tools colonies may use. */
      mcp?: McpHub
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
          swarm: r.state.team?.mode === 'swarm',
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
    /** For a round already running: steer its next step (default) or queue until the agent finishes. */
    delivery: 'steer' | 'queue' = 'steer',
    /** Files to put in the round's workspace as `uploads/…` artifacts. */
    attachments: readonly Attachment[] = [],
    /** Plan mode: the round presents its plan for approval before doing any work. */
    planFirst = false,
  ): Promise<{ chatId: string; colonyId: string; started: boolean }> {
    const message = text.trim()
    if (!message) throw new Error('message is empty')
    const id = chatId ?? newChatId()
    const turn = (this._sending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliver(id, message, config, delivery, attachments, planFirst))
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
    delivery: 'steer' | 'queue',
    attachments: readonly Attachment[],
    planFirst: boolean,
  ): Promise<{ chatId: string; colonyId: string; started: boolean }> {
    const live = this._live.get(id)
    if (live && live.state().status === 'running') {
      await live.postUserMessage(message, delivery, attachments)
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
    const spec = this.buildSpec(id, message, config, previous, history, tier)
    if (planFirst && spec.tier !== 'answer') spec.planFirst = true
    const run = new ColonyRun(this.runtime, spec, {
      resolver: this.options.resolver,
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
    })
    const prior = previous.at(-1)
    // The opening message is logged before any agent exists, so it reaches the lead once, via kickoff.
    run.beforeStart(async () => {
      if (prior) await this.carryOver(prior, run)
      await this.carryTranscripts(previous, run)
      const names = await run.attach(attachments)
      await run.append({
        type: 'chat/user',
        actor: { kind: 'user', id: 'user' },
        payload: { text: message, ...(names.length ? { attachments: names } : {}) },
      })
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

  /**
   * Picks a chat's latest round back up where it stopped (a stop, a server restart, a time limit) instead of
   * starting over. Its agents restart with a summary of everything recorded so far.
   */
  async resume(chatId: string): Promise<{ chatId: string; colonyId: string }> {
    if (this._live.get(chatId)?.state().status === 'running') throw new Error('this chat is already running')
    const last = (await this.rounds()).get(chatId)?.at(-1)
    if (!last) throw new Error('no such chat')
    if (last.state.status === 'completed')
      throw new Error('the latest round already completed; send a follow-up instead')
    const created = (await this.store.read(last.id as never)).find((e) => e.type === 'colony/created')
    if (!created) throw new Error('the round has no colony/created event')
    const spec = this.specFromLog(created.payload as EventPayloads['colony/created'], last.state)
    const run = new ColonyRun(this.runtime, spec, {
      resolver: this.options.resolver,
      resumeId: last.id as ColonyId,
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
    })
    this._live.set(chatId, run)
    try {
      await run.resume(last.state.statusReason ?? 'the server stopped')
    } catch (err) {
      this._live.delete(chatId)
      throw err
    }
    void run.done.finally(() => {
      if (this._live.get(chatId) === run) this._live.delete(chatId)
    })
    return { chatId, colonyId: run.id }
  }

  /** The spec a round was created with, from its colony/created event, including workers it added later. */
  private specFromLog(created: EventPayloads['colony/created'], state: ColonyState): ColonySpec {
    const notes = this.options.settings?.get().instructions
    const agents = Object.values(state.agents).map(({ info }) => {
      const note = (info.role === 'lead' ? notes?.lead : notes?.worker)?.trim()
      return {
        name: info.name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(note ? { instructions: note } : {}),
      }
    })
    return {
      name: created.name,
      mission: created.mission,
      pattern: created.pattern as ColonySpec['pattern'],
      agents,
      acceptance: created.acceptance as AcceptanceCheck[],
      budget: { maxTurns: 40, ...created.budget },
      observer: { intervalMs: created.observerMs ?? 45_000 },
      ...(created.thinking ? { thinking: created.thinking } : {}),
      ...(created.taskJudge ? { taskJudge: created.taskJudge } : {}),
      ...(created.chat ? { chat: { ...created.chat, history: created.chat.history ?? '' } } : {}),
      ...(created.team
        ? {
            team: {
              mode: created.team.mode === 'swarm' ? 'swarm' : 'orchestrated',
              maxWorkers: created.team.maxWorkers,
              workerModels: created.team.workerModels,
            },
          }
        : {}),
      ...(created.disabledTools?.length ? { disabledTools: created.disabledTools } : {}),
      ...(created.tier ? { tier: created.tier } : {}),
    }
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
    // A team with nobody to delegate to is one agent working alone. A swarm the person set up works together
    // on anything bigger than a direct answer.
    const tier: Tier =
      requested === 'team' && config.mode === 'orchestrated' && roster.length === 0 && extra === 0
        ? 'solo'
        : requested === 'solo' && config.mode === 'swarm' && roster.length > 1
          ? 'team'
          : requested
    const taken = new Set(['lead'])
    // A chat keeps its team: the workers (or peers) of its latest team round come back, minus any the lead
    // dismissed, with their memory. The team picker shapes only a chat's first team.
    const kept = keptTeam(previous, config.mode).map((info): AgentSpec => {
      taken.add(info.name)
      const note = info.focus ? `Your focus: ${info.focus}` : workerNote
      return {
        name: info.name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(info.focus ? { focus: info.focus } : {}),
        ...(note ? { instructions: note } : {}),
      }
    })
    const crew = (role: 'worker' | 'peer'): AgentSpec[] =>
      kept.length > 0
        ? kept
        : roster.map((r) => {
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
    // A swarm has no lead, even when triage gives the request to one agent: that agent is a peer.
    const alone: AgentSpec =
      config.mode === 'swarm'
        ? (kept[0] ?? {
            name: pickName(taken),
            role: 'peer',
            model: roster[0]?.model ?? config.leadModel,
            ...(workerNote ? { instructions: workerNote } : {}),
          })
        : lead
    const agents: AgentSpec[] =
      tier !== 'team'
        ? [alone]
        : swarm
          ? roster.length > 0 || kept.length > 0
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
      ...(config.thinking ? { thinking: config.thinking } : {}),
      team: {
        mode: config.mode,
        maxWorkers: tier === 'team' && !swarm ? (kept.length || roster.length) + extra : 0,
        workerModels: models,
      },
    }
  }

  /**
   * Gives each agent of a new round the conversation it had in the chat's earlier rounds (the latest round it
   * was in), compacted so it stays small: recent turns verbatim, older tool output replaced by placeholders.
   */
  private async carryTranscripts(previous: { state: ColonyState; id: string }[], run: ColonyRun) {
    for (const agent of run.spec.agents) {
      const source = [...previous].reverse().find((r) => r.state.agents[agent.name])
      if (!source) continue
      const from = join(this.store.colonyDir(source.id as never), 'agents', `${agent.name}.jsonl`)
      const messages = compactTranscript(readTranscript(from))
      if (messages.length === 0) continue
      const dir = join(run.workspace.colonyDir, 'agents')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${agent.name}.jsonl`), messages.map((m) => `${JSON.stringify(m)}\n`).join(''))
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
