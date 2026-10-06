import { hostname } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  BlobStore,
  EventLog,
  MyrError,
  newColonyId,
  type SqliteLogStore,
  sqliteLogStore,
} from '@myrmidon/core'
import {
  applyEvent,
  type ColonyId,
  type ColonyState,
  type EventDraft,
  type EventPayloads,
  emptyColonyState,
  type MyrEvent,
  SYSTEM,
  type TaskSnapshot,
} from '@myrmidon/protocol'
import { ColonyAgent } from './agent.ts'
import { registerColonyEvents } from './events.ts'
import type { ColonyHost } from './host.ts'
import type { McpHub } from './mcp.ts'
import { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { FactualObserver } from './observer.ts'
import { attachedNote, snapshot, toolsFor } from './patterns.ts'
import { detectSandbox, type Sandbox } from './sandbox.ts'
import type { ColonySpec } from './spec.ts'
import { guessMediaType } from './tools.ts'
import { Verifier } from './verifier.ts'
import { noWebTools, type WebTools } from './web.ts'
import { ColonyWorkspace } from './workspace.ts'

export interface Runtime {
  readonly ctx: Context
  readonly home: string
  dispose(): Promise<void>
}

/** Boots the plugin tree: SQLite log store, the event log, and colony event types. */
export async function bootRuntime(home: string): Promise<Runtime> {
  const ctx = new Context()
  await ctx.plugin(sqliteLogStore, { home })
  await ctx.plugin(EventLog)
  await ctx.plugin({
    name: 'colony-events',
    inject: ['log'],
    apply(c: Context) {
      c.effect(() => registerColonyEvents(c.log))
    },
  })
  for (let i = 0; i < 100 && !ctx.get('log'); i++) await Bun.sleep(5)
  if (!ctx.get('log')) throw new Error('event log service failed to start')
  return { ctx, home, dispose: () => ctx.fiber.dispose() }
}

export interface RunOptions {
  readonly unsafeNoSandbox?: boolean
  readonly resolver?: ModelResolver
  /** Search and fetch backends; defaults to keyless DuckDuckGo plus any search keys in the environment. */
  readonly web?: WebTools
  readonly sandbox?: Sandbox
  /** How long all agents may sit idle with empty inboxes before the colony is nudged. */
  readonly quietMs?: number
  /** Reopen this existing colony (see `resume`) instead of creating a new one. */
  readonly resumeId?: ColonyId
  /** Shared MCP connections; their tools are offered to agents allowed `mcp`. */
  readonly mcp?: McpHub
}

const QUIET_NUDGES = 2
/** Stop reason for a chat round that ended with a question or update for the human. */
export const AWAITING_USER = 'awaiting your reply'
/** A claimed task whose holder sits idle this long goes back to the pool. */
const LEASE_MS = 120_000
/** A swarm whose first peer produced no tasks in this long gets a second peer to bootstrap it. */
const BOOTSTRAP_MS = 60_000
/** The longest a swarm's opening huddle waits for every peer's proposal. */
const HUDDLE_MS = 90_000
/** Failed final verifications before a round gives up. */
const MAX_VERIFY_ROUNDS = 3

/** A file the person attached to a chat message. */
export interface Attachment {
  readonly name: string
  readonly bytes: Uint8Array
}

/** How a wake is delivered: `mail` is recorded as read when the agent sees it; `queue` waits for the agent's current work. */
interface Delivery {
  readonly mail?: MyrEvent['id']
  readonly queue?: boolean
}

export class ColonyRun implements ColonyHost {
  readonly id: ColonyId
  readonly blobs: BlobStore
  readonly workspace: ColonyWorkspace
  readonly sandbox: Sandbox
  readonly unsafeNoSandbox: boolean
  readonly resolver: ModelResolver
  readonly web: WebTools
  readonly done: Promise<ColonyState>

  private _state: ColonyState
  private readonly _agents = new Map<string, ColonyAgent>()
  private readonly _verifier: Verifier
  private readonly _observer: FactualObserver
  private readonly _timers: ReturnType<typeof setInterval>[] = []
  private _finish!: (s: ColonyState) => void
  private _deadline = 0
  private _finalRunning = false
  private _verifying = 0
  private _quietSince?: number
  private _nudges = 0
  private _mirrorTimer?: ReturnType<typeof setTimeout>
  private _offLog?: () => void
  private _seed?: () => Promise<void>
  /** Set while the colony waits on the person's answer; wakes for agents are held until it arrives. */
  private _awaiting = false
  private _held: ({ name: string; text: string; trigger: string } & Delivery)[] = []
  private readonly _assigned = new Map<string, string>()
  /**
   * Task wakes held until the creator's tool batch finishes: a plan note and its tasks arrive in one batch whose
   * calls run concurrently, and nobody should wake before the plan is in.
   */
  private readonly _afterBatch = new Map<string, (() => void)[]>()
  private readonly _idleSince = new Map<string, number>()
  private _failedVerifications = 0
  private _speakerOwesAnswer = false
  private _bootstrapAt = 0
  private _bootstrapped = 1
  /** Set while a swarm's peers are proposing how to split the work; `after` is the seq it opened at. */
  private _huddle?: { since: number; after: number; proposed: Set<string> }
  /** Reminders sent to agents that stopped holding a task, keyed by agent and task. */
  private readonly _reminded = new Map<string, number>()

  constructor(
    private readonly runtime: Runtime,
    readonly spec: ColonySpec,
    private readonly options: RunOptions = {},
  ) {
    this.id = options.resumeId ?? newColonyId(spec.name)
    const dir = (runtime.ctx.logStore as SqliteLogStore).colonyDir(this.id)
    this.blobs = new BlobStore(join(dir, 'blobs'))
    this.workspace = new ColonyWorkspace(dir)
    this.sandbox = options.sandbox ?? detectSandbox()
    this.unsafeNoSandbox = options.unsafeNoSandbox ?? false
    this.resolver = options.resolver ?? new ModelResolver()
    this.web = options.web ?? noWebTools
    this._state = emptyColonyState(this.id)
    this._verifier = new Verifier(this, this.resolver)
    this._observer = new FactualObserver(this)
    this.done = new Promise((resolve) => {
      this._finish = resolve
    })
  }

  get log() {
    return this.runtime.ctx.log
  }

  state() {
    return this._state
  }

  deadline() {
    return this._deadline
  }

  mcpTools() {
    return this.options.mcp?.tools() ?? []
  }

  huddling() {
    return this._huddle !== undefined
  }

  /**
   * Ends the opening huddle. The peer who proposed first merges the proposals into the plan and assigns the
   * tasks; the others are woken by their assignments. If nobody proposed, the first peer plans.
   */
  private _closeHuddle(why: string) {
    const huddle = this._huddle
    if (!huddle) return
    this._huddle = undefined
    const peers = this.spec.agents.map((a) => a.name)
    const proposals = this._state.board.filter((b) => b.seq > huddle.after && peers.includes(b.agent))
    const planner = proposals[0]?.agent ?? peers[0]
    if (!planner) return
    this._bootstrapAt = Date.now()
    this._bootstrapped = peers.indexOf(planner) + 1
    const listed = proposals.map((b) => `- ${b.agent}: ${b.text}`).join('\n') || '(no proposals were posted)'
    this._wake(
      planner,
      `The huddle is over (${why}). Proposals:\n${listed}\n\nYou proposed first, so write the plan: one note with section "plan" that merges the proposals, then create the tasks with create_task, each with assignee set to the peer who volunteered for it and the outputs it will produce. Then claim your own.\n\n${snapshot(this.spec, this._state)}`,
      'kickoff',
    )
  }

  append(draft: EventDraft): Promise<MyrEvent> {
    return this.log.appendOne(this.id, draft)
  }

  async appendAtomic(build: (state: ColonyState) => EventDraft[]): Promise<MyrEvent[]> {
    for (let attempt = 0; ; attempt++) {
      const head = this._state.lastSeq
      const drafts = build(this._state)
      if (drafts.length === 0) return []
      try {
        return await this.log.append(this.id, drafts, { expectedHead: head })
      } catch (err) {
        if (!(err instanceof MyrError && err.code === 'HEAD_MISMATCH') || attempt >= 20) throw err
        await Bun.sleep(5 + Math.random() * 20)
      }
    }
  }

  /** Fails loudly before anything starts if a model, credential, or capability is missing. */
  async preflight(): Promise<void> {
    const refs = new Set(this.spec.agents.map((a) => a.model))
    for (const c of this.spec.acceptance) if (c.verifier === 'llm-judge') refs.add(c.model)
    if (this.spec.taskJudge) refs.add(this.spec.taskJudge)
    for (const m of this.spec.team?.workerModels ?? []) refs.add(m)
    await Promise.all([...refs].map((ref) => this.resolver.probe(ref)))
    const needsExec =
      this.spec.acceptance.some((c) => c.verifier === 'command') ||
      this.spec.agents.some((a) => toolsFor(this.spec, a).includes('shell'))
    if (needsExec && this.sandbox.kind === 'none' && !this.unsafeNoSandbox) {
      const commandChecks = this.spec.acceptance.some((c) => c.verifier === 'command')
      if (commandChecks)
        throw new Error(
          'command acceptance checks need an OS sandbox; none found (use --unsafe-no-sandbox to override)',
        )
    }
  }

  async start(): Promise<void> {
    await this.preflight()
    const listener = (colonyId: ColonyId, events: readonly MyrEvent[]) => {
      if (colonyId !== this.id) return
      for (const e of events) {
        applyEvent(this._state, e)
        this._route(e)
      }
    }
    this._offLog = this.runtime.ctx.on('log/appended', listener)
    await this.append({
      type: 'colony/created',
      actor: SYSTEM,
      payload: {
        name: this.spec.name,
        mission: this.spec.mission,
        pattern: this.spec.pattern,
        agents: this.spec.agents.map((a) => ({
          name: a.name,
          role: a.role,
          model: a.model,
          tools: toolsFor(this.spec, a),
          ...(a.specialty ? { specialty: a.specialty } : {}),
          ...(a.focus ? { focus: a.focus } : {}),
        })),
        acceptance: this.spec.acceptance,
        budget: {
          wallMs: this.spec.budget.wallMs,
          maxTurns: this.spec.budget.maxTurns,
          ...(this.spec.budget.costUsd !== undefined ? { costUsd: this.spec.budget.costUsd } : {}),
        },
        unsafeNoSandbox: this.unsafeNoSandbox,
        ...(this.spec.chat
          ? {
              chat: {
                chatId: this.spec.chat.chatId,
                round: this.spec.chat.round,
                request: this.spec.chat.request,
                ...(this.spec.chat.history ? { history: this.spec.chat.history } : {}),
              },
            }
          : {}),
        ...(this.spec.team ? { team: this.spec.team } : {}),
        ...(this.spec.tier ? { tier: this.spec.tier } : {}),
        observerMs: this.spec.observer.intervalMs,
        ...(this.spec.taskJudge ? { taskJudge: this.spec.taskJudge } : {}),
        ...(this.spec.disabledTools?.length ? { disabledTools: this.spec.disabledTools } : {}),
      },
    })
    await this._seed?.()
    await this._launch(this.spec.budget.wallMs)
  }

  /**
   * Picks up a stopped or interrupted colony (built with `resumeId`) where it left off. Agents start with
   * fresh context: the durable state (tasks, notes, files, conversation) is all in the log, so the speaker gets
   * a summary of it plus anything the person said that nobody read, and agents holding tasks are told to
   * carry on. The wall clock restarts with what was left, or half the budget if less remained.
   */
  async resume(reason: string): Promise<void> {
    if (!this.options.resumeId) throw new Error('resume needs a colony built with resumeId')
    const past = await this.log.read(this.id)
    for (const e of past) applyEvent(this._state, e)
    if (this._state.status === 'completed') throw new Error('this round already completed')
    const started = past.find((e) => e.type === 'colony/started')
    const used = started ? Date.parse(past.at(-1)?.time ?? started.time) - Date.parse(started.time) : 0
    const left = Math.max(this.spec.budget.wallMs - used, this.spec.budget.wallMs / 2)
    await this.preflight()
    this._offLog = this.runtime.ctx.on('log/appended', (colonyId, events) => {
      if (colonyId !== this.id) return
      for (const e of events) {
        applyEvent(this._state, e)
        this._route(e)
      }
    })
    await this._launch(left, reason)
  }

  private async _launch(wallMs: number, resumedBecause?: string) {
    for (const a of this.spec.agents) {
      const agent = new ColonyAgent(a, this, this.resolver, { restore: true })
      agent.turn = this._state.agents[a.name]?.turns ?? 0
      this._agents.set(a.name, agent)
    }
    this._deadline = Date.now() + wallMs
    this._bootstrapAt = Date.now()
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team' && this.spec.agents.length > 1
    const planned =
      this._state.notes.some((n) => n.section === 'plan' && n.agent !== 'previous-round') ||
      Object.keys(this._state.tasks).length > 0
    if (swarm && !planned)
      this._huddle = { since: Date.now(), after: this._state.lastSeq, proposed: new Set() }
    await this.append({
      type: 'colony/started',
      actor: SYSTEM,
      payload: { pid: process.pid, hostname: hostname(), ...(resumedBecause ? { resumed: true } : {}) },
    })
    if (resumedBecause) this._wakeAfterResume(resumedBecause)
    for (const a of this._agents.values()) {
      a.run(!resumedBecause).catch((err) => {
        console.error(`[${a.name}] crashed:`, err)
        void this.append({
          type: 'agent/status',
          actor: SYSTEM,
          payload: { agent: a.name, status: 'failed', detail: String(err) },
        })
      })
    }
    this._timers.push(setInterval(() => void this._observe(), this.spec.observer.intervalMs))
    this._timers.push(setInterval(() => void this._watch(), 1000))
  }

  private _wakeAfterResume(reason: string) {
    const s = this._state
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team'
    const speaker = swarm
      ? (s.tasks['task-final']?.owner ?? this.spec.agents[0]?.name)
      : (this.spec.agents.find((a) => toolsFor(this.spec, a).includes('reply_user'))?.name ??
        this.spec.agents[0]?.name)
    const unread = s.chatMessages.filter((m, i) => i > 0 && m.from === 'user' && !m.readBy?.length)
    const said = unread.length
      ? `\n\nThe person said, and nobody has read it yet:\n${unread.map((m) => `- ${m.text}${attachedNote(m.attachments)}`).join('\n')}`
      : ''
    // Agents whose transcript was restored remember their own work; the rest start from the recorded state.
    const fresh = (name: string) =>
      this._agents.get(name)?.restored
        ? `This round was interrupted (${reason}) and has resumed. Your conversation so far is restored; here is where things stand now.`
        : `This round was interrupted (${reason}) and has resumed. Your earlier context is gone; everything that was recorded is below.`
    if (speaker) {
      const request = this.spec.chat ? `The request: ${this.spec.chat.request}\n\n` : ''
      this._wake(
        speaker,
        `${fresh(speaker)}\n\n${request}${snapshot(this.spec, s)}${said}\n\nContinue from where things stand.`,
        'resume',
      )
    }
    for (const t of Object.values(s.tasks)) {
      if (t.status !== 'in_progress' || !t.owner || t.owner === speaker) continue
      this._wake(
        t.owner,
        `${fresh(t.owner)}\n\nYou hold ${t.id} r${t.revision}: ${t.subject}\n${t.description}\n\nCheck the files and notes for what you had done, then finish and submit it.\n\n${snapshot(this.spec, s)}`,
        'resume',
      )
    }
  }

  async stop(reason: string): Promise<void> {
    if (this._state.status !== 'running') return
    await this.append({ type: 'colony/stopped', actor: SYSTEM, payload: { reason } })
    await this._end()
  }

  /** Runs `seed` right after colony/created, before any agent starts (used to carry files between chat rounds). */
  beforeStart(seed: () => Promise<void>) {
    this._seed = seed
  }

  async postUserMessage(
    text: string,
    mode: 'steer' | 'queue' = 'steer',
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    if (this._state.status !== 'running') throw new Error('this colony is not running')
    const names = await this.attach(attachments)
    await this.append({
      type: 'chat/user',
      actor: { kind: 'user', id: 'user' },
      payload: { text, mode, ...(names.length ? { attachments: names } : {}) },
    })
  }

  /** Stores files the person attached as `uploads/…` artifacts and returns their names. */
  async attach(files: readonly Attachment[]): Promise<string[]> {
    const names: string[] = []
    for (const file of files) {
      const base =
        file.name
          .replace(/[^A-Za-z0-9._-]+/g, '-')
          .replace(/^[-.]+/, '')
          .slice(-120) || 'file'
      let name = `uploads/${base}`
      for (let n = 2; this._state.artifacts[name] || names.includes(name); n++)
        name = `uploads/${base.replace(/(\.[^.]*)?$/, `-${n}$1`)}`
      const { hash, size } = await this.blobs.put(file.bytes)
      await this.append({
        type: 'artifact/versioned',
        actor: { kind: 'user', id: 'user' },
        payload: { name, version: 1, blob: hash, size, author: 'user', mediaType: guessMediaType(name) },
      })
      names.push(name)
    }
    return names
  }

  /**
   * Adds a specialist to an orchestrated team. `label` is its role (e.g. `researcher`); it gets a call sign
   * and sleeps until the lead assigns it a task.
   */
  async spawnWorker(by: string, label: string, focus: string, model?: string): Promise<string> {
    const team = this.spec.team
    if (team?.mode !== 'orchestrated') throw new Error('only an orchestrated team can add workers')
    if (this.spec.agents.find((a) => a.name === by)?.role !== 'lead')
      throw new Error('only the lead can spawn workers')
    const workers = this.spec.agents.filter((a) => a.role !== 'lead').length
    if (workers >= team.maxWorkers) throw new Error(`worker limit reached (${team.maxWorkers})`)
    const name = pickName(new Set(this.spec.agents.map((a) => a.name)))
    const chosen = model ?? team.workerModels[0]
    if (!chosen || !team.workerModels.includes(chosen)) {
      throw new Error(`model must be one of: ${team.workerModels.join(', ')}`)
    }
    const spec = {
      name,
      role: 'worker',
      model: chosen,
      specialty: label,
      focus,
      instructions: `Your focus, as defined by ${by}: ${focus}`,
    }
    this.spec.agents.push(spec)
    await this.append({
      type: 'agent/joined',
      actor: SYSTEM,
      payload: {
        agent: {
          name,
          role: 'worker',
          model: chosen,
          tools: toolsFor(this.spec, spec),
          specialty: label,
          focus,
        },
        by,
        focus: `${label}: ${focus}`,
      },
    })
    const agent = new ColonyAgent(spec, this, this.resolver)
    this._agents.set(name, agent)
    agent.run().catch((err) => {
      console.error(`[${name}] crashed:`, err)
      void this.append({
        type: 'agent/status',
        actor: SYSTEM,
        payload: { agent: name, status: 'failed', detail: String(err) },
      })
    })
    return `spawned ${name} as ${label} (${chosen}). It is asleep until you give it a task: create_task with assignee "${name}"`
  }

  async dismissWorker(by: string, name: string, reason: string): Promise<string> {
    if (this.spec.agents.find((a) => a.name === by)?.role !== 'lead')
      throw new Error('only the lead can dismiss workers')
    const worker = this.spec.agents.find((a) => a.name === name)
    if (!worker || worker.role === 'lead') throw new Error(`no worker named ${name}`)
    if (this._state.agents[name]?.dismissed) throw new Error(`${name} was already dismissed`)
    await this.append({ type: 'agent/dismissed', actor: SYSTEM, payload: { agent: name, by, reason } })
    this._agents.get(name)?.stop()
    const held = Object.values(this._state.tasks).filter(
      (t) => t.status === 'in_progress' && t.owner === name,
    )
    return `dismissed ${name}${held.length ? `; ${held.map((t) => t.id).join(', ')} will be released for re-assignment` : ''}`
  }

  requestTaskVerification(taskId: string, by: string): void {
    this._verifying += 1
    this._verifier
      .verifyTask(taskId)
      .catch(async (err) => {
        await this.append({
          type: 'board/posted',
          actor: { kind: 'user', id: 'verifier' },
          payload: {
            agent: 'verifier',
            text: `Task review for ${taskId} failed to run: ${String(err)}`,
            mentions: [by],
          },
        }).catch(() => {})
      })
      .finally(() => {
        this._verifying -= 1
      })
  }

  async requestFinalVerification(by: string, summary: string): Promise<string> {
    if (this._finalRunning) return 'a final verification is already running; wait for its verdicts'
    this._finalRunning = true
    this._verifying += 1
    try {
      await this.append({
        type: 'verifier/requested',
        actor: { kind: 'agent', id: by },
        payload: { target: 'colony', by },
      })
      const result = await this._verifier.verifyColony()
      if (result.pass) {
        await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts: result.verdicts } })
        void this._end()
        return `ALL CHECKS PASSED — the colony is complete.\n${result.report}`
      }
      // Outside chat, everyone hears about a failed check; in chat the speaker owns the fix.
      if (!this.spec.chat) {
        for (const agent of this._agents.values()) {
          if (agent.name !== by)
            agent.notify({
              trigger: 'verdict',
              text: `Final verification requested by ${by} FAILED:\n${result.report}`,
            })
        }
      }
      return `VERIFICATION FAILED. Fix these and request again:\n${result.report}\n\n(${by}'s summary: ${summary.slice(0, 500)})`
    } finally {
      this._finalRunning = false
      this._verifying -= 1
    }
  }

  /** A chat round's final answer verifies itself: no judge completes it outright, otherwise the judge runs. */
  private async _verifyFinalAnswer(by: string) {
    if (this.spec.acceptance.length === 0) {
      // Completion always cites a passing verdict; an unjudged direct answer records that it was delivered.
      const verdict = await this.append({
        type: 'verifier/verdict',
        actor: { kind: 'verifier', id: 'delivered' },
        payload: {
          target: 'colony',
          verifierId: 'delivered',
          pass: true,
          evidence: 'Direct answer delivered; answer-tier rounds are not judged.',
        },
      })
      await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts: [verdict.id] } })
      return void this._end()
    }
    const report = await this.requestFinalVerification(by, 'final answer sent to the person')
    if (this._state.status !== 'running') return
    this._failedVerifications += 1
    if (this._failedVerifications >= MAX_VERIFY_ROUNDS)
      return void this.stop(`verification failed ${MAX_VERIFY_ROUNDS} times; see the last verdict`)
    if (this.spec.team?.mode === 'swarm' && this.spec.tier === 'team') {
      // Peers fix the findings as a normal task; the speaker answers again once it is verified.
      this._speakerOwesAnswer = true
      await this.appendAtomic((s) => [
        {
          type: 'task/changed',
          actor: SYSTEM,
          payload: {
            by: 'verifier',
            task: {
              id: `task-${Object.keys(s.tasks).length + 1}`,
              revision: 1,
              subject: 'Address the verifier findings on the final answer',
              description: report.slice(0, 4000),
              status: 'pending',
              blockedBy: [],
              artifacts: [],
            },
          },
        },
      ])
      return
    }
    this._agents.get(by)?.notify({
      trigger: 'verdict',
      text: `${report}\n\nFix the work, then send an updated final answer with reply_user(final: true).`,
    })
  }

  batchEnded(agent: string): void {
    const queued = this._afterBatch.get(agent)
    if (!queued) return
    this._afterBatch.delete(agent)
    for (const announce of queued) announce()
  }

  private _wake(name: string, text: string, trigger: string, extra: Delivery = {}) {
    // While the person is being asked something, nobody acts on anything else.
    if (this._awaiting) {
      this._held.push({ name, text, trigger, ...extra })
      return
    }
    this._agents.get(name)?.notify({ text, trigger, ...extra })
  }

  private _route(e: MyrEvent) {
    const notify = (name: string, text: string, trigger: string, extra: Delivery = {}) =>
      this._wake(name, text, trigger, extra)
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team'
    switch (e.type) {
      case 'chat/user': {
        const p = e.payload as EventPayloads['chat/user']
        this._awaiting = false
        const held = this._held.splice(0)
        // The event id doubles as a mail id, so the agent's mail/delivered marks the message read.
        const delivery: Delivery = { mail: e.id, ...(p.mode === 'queue' ? { queue: true } : {}) }
        const text = `${p.text}${attachedNote(p.attachments)}`
        if (swarm) {
          const target = this._state.tasks['task-final']?.owner ?? this.spec.agents[0]?.name
          if (target) notify(target, `${text}\n\n${snapshot(this.spec, this._state)}`, 'user', delivery)
        } else {
          const talkers = [...this._agents.values()].filter((a) =>
            toolsFor(this.spec, a.spec).includes('reply_user'),
          )
          for (const a of talkers.length > 0 ? talkers : [...this._agents.values()])
            notify(a.name, text, 'user', delivery)
        }
        for (const { name, text, trigger, ...rest } of held) notify(name, text, trigger, rest)
        break
      }
      case 'chat/reply': {
        const p = e.payload as EventPayloads['chat/reply']
        if (p.question) this._awaiting = true
        else if (p.final && this.spec.chat) void this._verifyFinalAnswer(p.agent)
        break
      }
      case 'mail/sent': {
        const p = e.payload as EventPayloads['mail/sent']
        notify(p.to, `mail from ${p.from}${p.subject ? ` [${p.subject}]` : ''}: ${p.body}`, 'mail', {
          mail: e.id,
        })
        break
      }
      case 'board/posted': {
        const p = e.payload as EventPayloads['board/posted']
        if (this._huddle && this._agents.has(p.agent)) {
          this._huddle.proposed.add(p.agent)
          if (this._huddle.proposed.size >= this._agents.size) this._closeHuddle('every peer proposed')
        }
        for (const m of p.mentions)
          if (m !== p.agent) notify(m, `${p.agent} mentioned you on the board: ${p.text}`, 'mention')
        break
      }
      case 'observer/signal': {
        const p = e.payload as EventPayloads['observer/signal']
        const everyone =
          this.spec.chat && this.spec.tier === 'team' ? this._stallTargets() : [...this._agents.keys()]
        const targets = p.targets.length > 0 ? p.targets : everyone
        for (const t of targets) notify(t, `${p.kind} (${p.severity}): ${p.facts}`, `observer:${p.kind}`)
        break
      }
      case 'verifier/verdict': {
        const p = e.payload as EventPayloads['verifier/verdict']
        if (!p.target.startsWith('task:')) break
        const task = this._state.tasks[p.target.slice(5)]
        if (task?.owner) {
          notify(task.owner, `${task.id} ${p.pass ? 'VERIFIED' : 'REJECTED'}: ${p.evidence}`, 'verdict')
        }
        // Leads coordinate integration, so they hear about every task outcome, not only their own.
        for (const lead of this.spec.agents.filter((a) => a.role === 'lead' && a.name !== task?.owner)) {
          const open = Object.values(this._state.tasks).filter(
            (t) => t.status !== 'verified' && t.status !== 'deleted',
          )
          notify(
            lead.name,
            `${task?.id ?? p.target} by ${task?.owner ?? '?'} was ${p.pass ? 'VERIFIED' : 'REJECTED'}: ${p.evidence}. Open tasks: ${open.map((t) => `${t.id}[${t.status}]`).join(', ') || 'none — integrate and send the final answer'}`,
            'verdict',
          )
        }
        break
      }
      case 'task/changed': {
        const p = e.payload as EventPayloads['task/changed']
        const creator = this._agents.get(p.by)
        if (creator?.working) {
          const queued = this._afterBatch.get(p.by) ?? []
          queued.push(() => this._announceTask(p))
          this._afterBatch.set(p.by, queued)
        } else this._announceTask(p)
        if (p.task.status === 'verified') this._announceUnblocked(p.task.id)
        break
      }
      case 'agent/turn':
      case 'llm/response': {
        // Fallback for wakes held past a batch: release them when the creator speaks again or ends its turn.
        const agent = (e.payload as { agent: string }).agent
        if (e.type === 'llm/response' || (e.payload as EventPayloads['agent/turn']).phase === 'end')
          this.batchEnded(agent)
        if (e.type === 'agent/turn') {
          if ((e.payload as EventPayloads['agent/turn']).phase === 'end') this._remindHolder(agent)
          break
        }
        const limit = this.spec.budget.costUsd
        if (limit === undefined) break
        const spent = Object.values(this._state.agents).reduce((n, a) => n + a.cost, 0)
        if (spent >= limit) void this.stop(`budget: cost $${spent.toFixed(3)} reached limit $${limit}`)
        break
      }
    }
    if (e.type === 'artifact/versioned' || e.type === 'note/appended' || e.type === 'board/posted')
      this._scheduleMirror()
  }

  /** Wakes whoever should hear about a task: its assignee, or idle teammates for a new unassigned task. */
  /**
   * An agent that ends its turn still holding a task has usually stopped early. It is woken to finish and
   * submit, or release the task with what blocks it; at most twice per task, so a real blocker cannot loop.
   */
  private _remindHolder(agent: string) {
    if (this._state.status !== 'running' || this._awaiting) return
    const held = Object.values(this._state.tasks).find(
      (t) => t.status === 'in_progress' && t.owner === agent && t.id !== 'task-final',
    )
    if (!held) return
    const key = `${agent}:${held.id}`
    const sent = this._reminded.get(key) ?? 0
    if (sent >= 2) return
    this._reminded.set(key, sent + 1)
    this._wake(
      agent,
      `You stopped while holding ${held.id} r${held.revision} (${held.subject}). Finish it: publish its outputs and submit_task. If you truly cannot, release_task and post what blocks you. (Reminder ${sent + 1} of 2)`,
      'reminder',
    )
  }

  private _ready(t: TaskSnapshot) {
    return t.blockedBy.every((b) => this._state.tasks[b]?.status === 'verified')
  }

  /** Tasks waiting on `done` that have nothing left blocking them are announced now, as if just created. */
  private _announceUnblocked(done: string) {
    for (const t of Object.values(this._state.tasks)) {
      if (t.blockedBy.includes(done) && t.status === 'pending' && this._ready(t))
        this._announceTask({ task: t, by: 'scheduler' }, true)
    }
  }

  private _announceTask(p: EventPayloads['task/changed'], unblocked = false) {
    const t = p.task
    const open = t.status === 'pending' || t.status === 'rejected' || t.id === 'task-final'
    // Waking someone for a task they cannot claim yet only costs a turn; they hear once it is unblocked.
    if (open && !this._ready(t)) return
    if (t.assignee && open && this._assigned.get(t.id) !== t.assignee) {
      this._assigned.set(t.id, t.assignee)
      const outputs = t.outputs?.length ? `\nOutputs: ${t.outputs.join(', ')}` : ''
      this._wake(
        t.assignee,
        `Task ${t.id} r${t.revision} is yours: ${t.subject}\n${t.description}${outputs}\n\n${snapshot(this.spec, this._state)}`,
        'task',
      )
      return
    }
    if ((t.revision !== 1 && !unblocked) || t.assignee) return
    for (const a of this._agents.values()) {
      // In an orchestrated team the lead creates tasks for workers; it does not pick them up itself.
      if (a.name === p.by || !a.idle || (this.spec.team?.mode === 'orchestrated' && a.spec.role === 'lead'))
        continue
      const what = unblocked ? `Task ${t.id} is unblocked` : `New task ${t.id}`
      this._wake(a.name, `${what}: ${t.subject}\n\n${snapshot(this.spec, this._state)}`, 'task')
    }
  }

  private async _observe() {
    for (const signal of this._observer.tick()) {
      await this.append({
        type: 'observer/signal',
        actor: { kind: 'observer', id: 'factual' },
        payload: { ...signal, targets: signal.targets ?? [] },
      })
    }
  }

  private async _watch() {
    if (this._state.status !== 'running') return
    if (!this.runtime.ctx.get('log')) return void this._end()
    if (Date.now() >= this._deadline)
      return void this.stop(`budget: wall time ${Math.round(this.spec.budget.wallMs / 1000)}s exhausted`)
    const agents = [...this._agents.values()]
    const live = agents.filter((a) => {
      const status = this._state.agents[a.name]?.status
      return status !== 'failed' && status !== 'stopped'
    })
    if (live.length === 0) return void this.stop('all agents have stopped or failed')
    const now = Date.now()
    for (const a of agents) {
      if (a.idle) this._idleSince.set(a.name, this._idleSince.get(a.name) ?? now)
      else this._idleSince.delete(a.name)
    }
    if (!this._awaiting) {
      await this._releaseStaleClaims(now)
      if (this._huddle && now - this._huddle.since >= HUDDLE_MS) this._closeHuddle('time is up')
      if (this.spec.team?.mode === 'swarm' && this.spec.tier === 'team') await this._tendSwarm(now)
    }
    const quiet = this._verifying === 0 && live.every((a) => a.idle)
    if (!quiet) {
      this._quietSince = undefined
      return
    }
    this._quietSince ??= now
    if (now - this._quietSince < (this.options.quietMs ?? 8000)) return
    this._quietSince = undefined
    // In a chat, a colony that spoke last and then went quiet is waiting on the human, not stuck.
    const lastChat = this._state.chatMessages.at(-1)
    if (this.spec.chat && lastChat && lastChat.from !== 'user') return void this.stop(AWAITING_USER)
    if (this._nudges >= QUIET_NUDGES)
      return void this.stop('stalled: every agent is idle and the work is not finished')
    this._nudges += 1
    await this.append({
      type: 'observer/signal',
      actor: { kind: 'observer', id: 'factual' },
      payload: {
        targets: this._stallTargets(),
        kind: 'stall',
        severity: this._nudges === QUIET_NUDGES ? 'critical' : 'warn',
        facts: `Every agent is idle and the work is not finished. ${QUIET_NUDGES - this._nudges + 1} nudge(s) left before the colony stops. Check list_tasks and observe, then continue the work${this.spec.chat ? ' or send the final answer' : ' or request_final_verification'}.`,
      },
    })
  }

  /**
   * Who a stall nudge should wake. In a chat team, only the agents who can move things on: the speaker (lead,
   * swarm seed, or task-final holder) and anyone holding a task. Sleeping specialists stay asleep.
   */
  private _stallTargets(): string[] {
    if (!this.spec.chat || this.spec.tier !== 'team') return []
    const holders = Object.values(this._state.tasks)
      .filter((t) => t.status === 'in_progress' && t.owner)
      .map((t) => t.owner as string)
    const speaker =
      this.spec.team?.mode === 'swarm'
        ? (this._state.tasks['task-final']?.owner ?? this.spec.agents[0]?.name)
        : this.spec.agents.find((a) => a.role === 'lead')?.name
    return [...new Set([...(speaker ? [speaker] : []), ...holders])]
  }

  /** Puts tasks back in the pool when their holder has stopped, failed, or sat idle past the lease. */
  private async _releaseStaleClaims(now: number) {
    for (const t of Object.values(this._state.tasks)) {
      if (t.status !== 'in_progress' || !t.owner || t.id === 'task-final') continue
      const status = this._state.agents[t.owner]?.status
      const idleFor = now - (this._idleSince.get(t.owner) ?? now)
      if (status !== 'failed' && status !== 'stopped' && idleFor < LEASE_MS) continue
      await this.appendAtomic((s) => {
        const cur = s.tasks[t.id]
        if (cur?.status !== 'in_progress' || cur.owner !== t.owner) return []
        const { owner: _owner, ...rest } = cur
        return [
          {
            type: 'task/changed',
            actor: SYSTEM,
            payload: { by: 'scheduler', task: { ...rest, revision: cur.revision + 1, status: 'pending' } },
          },
        ]
      })
      const others = [...this._agents.values()].filter(
        (a) =>
          a.idle &&
          a.name !== t.owner &&
          !(this.spec.team?.mode === 'orchestrated' && a.spec.role === 'lead'),
      )
      const lead = this.spec.agents.find((a) => a.role === 'lead')
      const text = `${t.id} was released because ${t.owner} stopped working on it: ${t.subject}`
      if (this.spec.team?.mode === 'orchestrated' && lead)
        this._wake(lead.name, `${text}. Re-assign it with assign_task.`, 'task')
      else
        for (const a of others) this._wake(a.name, `${text}\n\n${snapshot(this.spec, this._state)}`, 'task')
    }
  }

  /** Swarm upkeep: a second bootstrapper if the first produced nothing, and a speaker once the work is done. */
  private async _tendSwarm(now: number) {
    const tasks = Object.values(this._state.tasks).filter((t) => t.status !== 'deleted')
    const work = tasks.filter((t) => t.id !== 'task-final')
    if (this._huddle) return
    if (work.length === 0) {
      const next = this.spec.agents[this._bootstrapped]
      const seedsIdle = this.spec.agents
        .slice(0, this._bootstrapped)
        .every((a) => this._agents.get(a.name)?.idle)
      if (
        next &&
        seedsIdle &&
        now - this._bootstrapAt >= BOOTSTRAP_MS &&
        this._state.chatMessages.at(-1)?.from === 'user'
      ) {
        this._bootstrapped += 1
        this._bootstrapAt = now
        this._wake(
          next.name,
          `No plan or tasks exist yet. Write the plan note and propose the first tasks, then claim one.\n\n${snapshot(this.spec, this._state)}`,
          'kickoff',
        )
      }
      return
    }
    if (this._verifying > 0 || !work.every((t) => t.status === 'verified')) return
    const final = this._state.tasks['task-final']
    if (!final) {
      const done = new Map<string, number>()
      for (const t of work) if (t.owner) done.set(t.owner, (done.get(t.owner) ?? 0) + 1)
      // Most verified tasks speaks; ties go to the earliest peer, so the choice is predictable.
      const order = this.spec.agents.map((a) => a.name)
      const speaker =
        [...done].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0]?.[0] ??
        order[0] ??
        ''
      await this.appendAtomic((s) =>
        s.tasks['task-final']
          ? []
          : [
              {
                type: 'task/changed',
                actor: SYSTEM,
                payload: {
                  by: 'scheduler',
                  task: {
                    id: 'task-final',
                    revision: 1,
                    subject: 'Deliver the final answer to the person',
                    description:
                      'Every task is verified. You are the speaker: read the plan, the files, and the findings, then send the complete final answer with reply_user(final: true).',
                    status: 'in_progress',
                    owner: speaker,
                    assignee: speaker,
                    blockedBy: [],
                    artifacts: [],
                  },
                },
              },
            ],
      )
      return
    }
    if (this._speakerOwesAnswer && final.owner && this._agents.get(final.owner)?.idle) {
      this._speakerOwesAnswer = false
      this._wake(
        final.owner,
        `The verifier findings are addressed. Send an updated final answer with reply_user(final: true).\n\n${snapshot(this.spec, this._state)}`,
        'verdict',
      )
    }
  }

  private _scheduleMirror() {
    if (this._mirrorTimer) return
    this._mirrorTimer = setTimeout(() => {
      this._mirrorTimer = undefined
      this.workspace
        .writeMirror(this._state, this.blobs)
        .catch((err) => console.error('mirror write failed:', err))
    }, 300)
  }

  private async _end() {
    for (const t of this._timers) clearInterval(t)
    this._timers.length = 0
    clearTimeout(this._mirrorTimer)
    this._mirrorTimer = undefined
    for (const a of this._agents.values()) a.stop()
    await Bun.sleep(50)
    await this.workspace.writeMirror(this._state, this.blobs).catch(() => {})
    this._offLog?.()
    this._finish(this._state)
  }
}
