import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BlobStore, EventLog, MyrError, newColonyId, SqliteLogStore, sqliteLogStore } from '@myrmidon/core'
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
import { FactualObserver } from './observer.ts'
import { toolsFor } from './patterns.ts'
import { detectSandbox, type Sandbox } from './sandbox.ts'
import type { ColonySpec } from './spec.ts'
import { Verifier } from './verifier.ts'
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
  readonly sandbox?: Sandbox
  /** How long all agents may sit idle with empty inboxes before the colony is nudged. */
  readonly quietMs?: number
}

const QUIET_NUDGES = 2

export class ColonyRun implements ColonyHost {
  readonly id: ColonyId
  readonly blobs: BlobStore
  readonly workspace: ColonyWorkspace
  readonly sandbox: Sandbox
  readonly unsafeNoSandbox: boolean
  readonly resolver: ModelResolver
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
    for (const ref of refs) await this.resolver.requireApiKey(this.resolver.resolve(ref).model)
    const needsExec =
      this.spec.acceptance.some((c) => c.verifier === 'command') ||
      this.spec.agents.some((a) => toolsFor(this.spec, a).includes('shell'))
    if (needsExec && this.sandbox.kind === 'none' && !this.unsafeNoSandbox) {
      const commandChecks = this.spec.acceptance.some((c) => c.verifier === 'command')
      if (commandChecks) throw new Error('command acceptance checks need an OS sandbox; none found (use --unsafe-no-sandbox to override)')
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
        agents: this.spec.agents.map((a) => ({ name: a.name, role: a.role, model: a.model, tools: toolsFor(this.spec, a) })),
        acceptance: this.spec.acceptance,
        budget: {
          wallMs: this.spec.budget.wallMs,
          maxTurns: this.spec.budget.maxTurns,
          ...(this.spec.budget.costUsd !== undefined ? { costUsd: this.spec.budget.costUsd } : {}),
        },
        unsafeNoSandbox: this.unsafeNoSandbox,
      },
    })
    for (const a of this.spec.agents) this._agents.set(a.name, new ColonyAgent(a, this, this.resolver))
    this._deadline = Date.now() + this.spec.budget.wallMs
    await this.append({ type: 'colony/started', actor: SYSTEM, payload: {} })
    for (const a of this._agents.values()) {
      a.run().catch((err) => {
        console.error(`[${a.name}] crashed:`, err)
        void this.append({ type: 'agent/status', actor: SYSTEM, payload: { agent: a.name, status: 'failed', detail: String(err) } })
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

  requestTaskVerification(taskId: string, by: string): void {
    this._verifying += 1
    this._verifier
      .verifyTask(taskId)
      .catch(async (err) => {
        await this.append({
          type: 'board/posted',
          actor: { kind: 'user', id: 'verifier' },
          payload: { agent: 'verifier', text: `Task review for ${taskId} failed to run: ${String(err)}`, mentions: [by] },
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
      await this.append({ type: 'verifier/requested', actor: { kind: 'agent', id: by }, payload: { target: 'colony', by } })
      const result = await this._verifier.verifyColony()
      if (result.pass) {
        await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts: result.verdicts } })
        void this._end()
        return `ALL CHECKS PASSED — the colony is complete.\n${result.report}`
      }
      for (const agent of this._agents.values()) {
        if (agent.name !== by) agent.notify({ trigger: 'verdict', text: `Final verification requested by ${by} FAILED:\n${result.report}` })
      }
      return `VERIFICATION FAILED. Fix these and request again:\n${result.report}\n\n(${by}'s summary: ${summary.slice(0, 500)})`
    } finally {
      this._finalRunning = false
      this._verifying -= 1
    }
  }

  private _route(e: MyrEvent) {
    const notify = (name: string, text: string, trigger: string, extra: { mail?: MyrEvent['id'] } = {}) =>
      this._agents.get(name)?.notify({ text, trigger, ...extra })
    switch (e.type) {
      case 'mail/sent': {
        const p = e.payload as EventPayloads['mail/sent']
        notify(p.to, `mail from ${p.from}${p.subject ? ` [${p.subject}]` : ''}: ${p.body}`, 'mail', { mail: e.id })
        break
      }
      case 'board/posted': {
        const p = e.payload as EventPayloads['board/posted']
        for (const m of p.mentions) if (m !== p.agent) notify(m, `${p.agent} mentioned you on the board: ${p.text}`, 'mention')
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
        break
      }
      case 'task/changed': {
        const p = e.payload as EventPayloads['task/changed']
        if (p.task.revision !== 1) break
        for (const a of this._agents.values()) {
          if (a.name !== p.by && a.idle) notify(a.name, `New task ${p.task.id}: ${p.task.subject}`, 'task')
        }
        break
      }
      case 'llm/response': {
        const limit = this.spec.budget.costUsd
        if (limit === undefined) break
        const spent = Object.values(this._state.agents).reduce((n, a) => n + a.cost, 0)
        if (spent >= limit) void this.stop(`budget: cost $${spent.toFixed(3)} reached limit $${limit}`)
        break
      }
    }
    if (e.type === 'artifact/versioned' || e.type === 'note/appended' || e.type === 'board/posted') this._scheduleMirror()
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
    if (Date.now() >= this._deadline) return void this.stop(`budget: wall time ${Math.round(this.spec.budget.wallMs / 1000)}s exhausted`)
    const agents = [...this._agents.values()]
    const live = agents.filter((a) => {
      const status = this._state.agents[a.name]?.status
      return status !== 'failed' && status !== 'stopped'
    })
    if (live.length === 0) return void this.stop('all agents have stopped or failed')
    const quiet = this._verifying === 0 && live.every((a) => a.idle)
    if (!quiet) {
      this._quietSince = undefined
      return
    }
    this._quietSince ??= Date.now()
    if (Date.now() - this._quietSince < (this.options.quietMs ?? 8000)) return
    this._quietSince = undefined
    if (this._nudges >= QUIET_NUDGES) return void this.stop('stalled: every agent is idle and verification has not passed')
    this._nudges += 1
    await this.append({
      type: 'observer/signal',
      actor: { kind: 'observer', id: 'factual' },
      payload: {
        kind: 'stall',
        severity: this._nudges === QUIET_NUDGES ? 'critical' : 'warn',
        facts: `Every agent is idle and the colony is not verified. ${QUIET_NUDGES - this._nudges + 1} nudge(s) left before the colony stops. Check observe and list_tasks, then act or request_final_verification.`,
        targets: [],
      },
    })
  }

  private _scheduleMirror() {
    if (this._mirrorTimer) return
    this._mirrorTimer = setTimeout(() => {
      this._mirrorTimer = undefined
      this.workspace.writeMirror(this._state, this.blobs).catch((err) => console.error('mirror write failed:', err))
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
