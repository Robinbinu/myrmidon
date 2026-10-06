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
} from '@myrmidon/protocol'
import { ColonyAgent } from './agent.ts'
import { registerColonyEvents } from './events.ts'
import type { ColonyHost } from './host.ts'
import { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { FactualObserver } from './observer.ts'
import { snapshot, toolsFor } from './patterns.ts'
import { detectSandbox, type Sandbox } from './sandbox.ts'
import type { ColonySpec } from './spec.ts'
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
}

const QUIET_NUDGES = 2
/** Stop reason for a chat round that ended with a question or update for the human. */
export const AWAITING_USER = 'awaiting your reply'
/** A claimed task whose holder sits idle this long goes back to the pool. */
const LEASE_MS = 120_000
/** A swarm whose first peer produced no tasks in this long gets a second peer to bootstrap it. */
const BOOTSTRAP_MS = 60_000
/** Failed final verifications before a round gives up. */
const MAX_VERIFY_ROUNDS = 3

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
  private _held: { name: string; text: string; trigger: string; mail?: MyrEvent['id'] }[] = []
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

  constructor(
    private readonly runtime: Runtime,
    readonly spec: ColonySpec,
    private readonly options: RunOptions = {},
  ) {
    this.id = newColonyId(spec.name)
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
              },
            }
          : {}),
        ...(this.spec.team ? { team: this.spec.team } : {}),
        ...(this.spec.tier ? { tier: this.spec.tier } : {}),
      },
    })
    await this._seed?.()
    for (const a of this.spec.agents) this._agents.set(a.name, new ColonyAgent(a, this, this.resolver))
    this._deadline = Date.now() + this.spec.budget.wallMs
    this._bootstrapAt = Date.now()
    await this.append({
      type: 'colony/started',
      actor: SYSTEM,
      payload: { pid: process.pid, hostname: hostname() },
    })
    for (const a of this._agents.values()) {
      a.run().catch((err) => {
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

  async stop(reason: string): Promise<void> {
    if (this._state.status !== 'running') return
    await this.append({ type: 'colony/stopped', actor: SYSTEM, payload: { reason } })
    await this._end()
  }

  /** Runs `seed` right after colony/created, before any agent starts (used to carry files between chat rounds). */
  beforeStart(seed: () => Promise<void>) {
    this._seed = seed
  }

  async postUserMessage(text: string): Promise<void> {
    if (this._state.status !== 'running') throw new Error('this colony is not running')
    await this.append({ type: 'chat/user', actor: { kind: 'user', id: 'user' }, payload: { text } })
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
      instructions: `Your focus, as defined by ${by}: ${focus}`,
    }
    this.spec.agents.push(spec)
    await this.append({
      type: 'agent/joined',
      actor: SYSTEM,
      payload: {
        agent: { name, role: 'worker', model: chosen, tools: toolsFor(this.spec, spec), specialty: label },
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

  private _wake(name: string, text: string, trigger: string, extra: { mail?: MyrEvent['id'] } = {}) {
    // While the person is being asked something, nobody acts on anything else.
    if (this._awaiting) {
      this._held.push({ name, text, trigger, ...extra })
      return
    }
    this._agents.get(name)?.notify({ text, trigger, ...extra })
  }

  private _route(e: MyrEvent) {
    const notify = (name: string, text: string, trigger: string, extra: { mail?: MyrEvent['id'] } = {}) =>
      this._wake(name, text, trigger, extra)
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team'
    switch (e.type) {
      case 'chat/user': {
        const p = e.payload as EventPayloads['chat/user']
        this._awaiting = false
        const held = this._held.splice(0)
        if (swarm) {
          const target = this._state.tasks['task-final']?.owner ?? this.spec.agents[0]?.name
          if (target) notify(target, `${p.text}\n\n${snapshot(this.spec, this._state)}`, 'user')
        } else {
          const talkers = [...this._agents.values()].filter((a) =>
            toolsFor(this.spec, a.spec).includes('reply_user'),
          )
          for (const a of talkers.length > 0 ? talkers : [...this._agents.values()])
            notify(a.name, p.text, 'user')
        }
        for (const h of held) notify(h.name, h.text, h.trigger, h.mail ? { mail: h.mail } : {})
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
        for (const m of p.mentions)
          if (m !== p.agent) notify(m, `${p.agent} mentioned you on the board: ${p.text}`, 'mention')
        break
      }
      case 'observer/signal': {
        const p = e.payload as EventPayloads['observer/signal']
        const targets = p.targets.length > 0 ? p.targets : [...this._agents.keys()]
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
        break
      }
      case 'agent/turn':
      case 'llm/response': {
        const agent = (e.payload as { agent: string }).agent
        const queued = this._afterBatch.get(agent)
        if (
          queued &&
          (e.type === 'llm/response' || (e.payload as EventPayloads['agent/turn']).phase === 'end')
        ) {
          this._afterBatch.delete(agent)
          for (const announce of queued) announce()
        }
        if (e.type === 'agent/turn') break
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
  private _announceTask(p: EventPayloads['task/changed']) {
    const t = p.task
    const open = t.status === 'pending' || t.status === 'rejected' || t.id === 'task-final'
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
    if (t.revision !== 1 || t.assignee) return
    for (const a of this._agents.values()) {
      // In an orchestrated team the lead creates tasks for workers; it does not pick them up itself.
      if (a.name === p.by || !a.idle || (this.spec.team?.mode === 'orchestrated' && a.spec.role === 'lead'))
        continue
      this._wake(a.name, `New task ${t.id}: ${t.subject}\n\n${snapshot(this.spec, this._state)}`, 'task')
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
        kind: 'stall',
        severity: this._nudges === QUIET_NUDGES ? 'critical' : 'warn',
        facts: `Every agent is idle and the work is not finished. ${QUIET_NUDGES - this._nudges + 1} nudge(s) left before the colony stops. Check list_tasks and observe, then continue the work${this.spec.chat ? ' or send the final answer' : ' or request_final_verification'}.`,
        targets: [],
      },
    })
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
