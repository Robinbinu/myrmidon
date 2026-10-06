import { join } from 'node:path'
import { BlobStore, type SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type ColonyStatus, foldColony } from '@myrmidon/protocol'
import { ColonyRun, type Runtime } from './colony.ts'
import type { ModelResolver } from './models.ts'
import type { AgentSpec, ColonySpec } from './spec.ts'

export interface TeamConfig {
  /** `auto`: the lead decides whether and whom to spawn; `manual`: exactly `workers` workers from the start. */
  readonly mode: 'auto' | 'manual'
  readonly leadModel: string
  readonly workerModel: string
  readonly workers: number
  readonly judgeModel: string
  readonly wallMinutes?: number
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

const RUBRIC = `Judge whether the colony accomplished the user's request completely and correctly.
- Every part of the request is addressed; nothing is silently skipped.
- Facts are accurate and, where relevant, backed by sources; code is correct and complete (no placeholders).
- Delivered files and the final reply are consistent with each other and usable as described.
Score 1.0 only for work you would hand to the user as-is.`

const MAX_WORKERS = 8

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

  constructor(
    private readonly runtime: Runtime,
    private readonly options: { resolver: ModelResolver; unsafeNoSandbox?: boolean },
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
      out.push({
        chatId,
        title: title(first.state.chat?.request ?? first.state.name),
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

  /** Delivers to the running round if there is one; otherwise starts a new round. */
  async send(
    text: string,
    config: TeamConfig,
    chatId?: string,
  ): Promise<{ chatId: string; colonyId: string; started: boolean }> {
    const message = text.trim()
    if (!message) throw new Error('message is empty')
    const id = chatId ?? newChatId()
    const live = this._live.get(id)
    if (live && live.state().status === 'running') {
      await live.postUserMessage(message)
      return { chatId: id, colonyId: live.id, started: false }
    }
    const previous = (await this.rounds()).get(id) ?? []
    const run = new ColonyRun(this.runtime, this.buildSpec(id, message, config, previous), {
      resolver: this.options.resolver,
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
    })
    const prior = previous.at(-1)
    // The opening message is logged before any agent exists, so it reaches the lead once, via kickoff.
    run.beforeStart(async () => {
      if (prior) await this.carryArtifacts(prior, run)
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

  async stop(chatId: string): Promise<void> {
    await this._live.get(chatId)?.stop('stopped by user')
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this._live.values()].map((r) => r.stop('server shutting down')))
  }

  private buildSpec(
    chatId: string,
    request: string,
    config: TeamConfig,
    previous: { state: ColonyState }[],
  ): ColonySpec {
    const workers = Math.min(Math.max(0, Math.floor(config.workers)), MAX_WORKERS)
    const agents: AgentSpec[] = [{ name: 'lead', role: 'lead', model: config.leadModel }]
    if (config.mode === 'manual') {
      for (let i = 1; i <= workers; i++)
        agents.push({ name: `worker-${i}`, role: 'worker', model: config.workerModel })
    }
    const history = previous
      .map(({ state }) => {
        const replies = state.chatMessages.filter((m) => m.from !== 'user')
        const final = replies.filter((m) => m.final).at(-1) ?? replies.at(-1)
        return `User: ${state.chat?.request ?? ''}\nColony (${state.status}): ${final?.text ?? '(no reply)'}`
      })
      .join('\n\n')
    return {
      name: title(request),
      mission: history
        ? `${request}\n\n(Context from earlier rounds of this conversation)\n${history}`
        : request,
      pattern: 'lead-workers',
      agents,
      acceptance: [{ verifier: 'llm-judge', model: config.judgeModel, rubric: RUBRIC, threshold: 0.7 }],
      budget: { wallMs: Math.round((config.wallMinutes ?? 30) * 60_000), maxTurns: 40 },
      observer: { intervalMs: 45_000 },
      chat: { chatId, round: previous.length + 1, request, history },
      team: {
        mode: config.mode,
        maxWorkers: config.mode === 'auto' ? workers : 0,
        workerModels: [config.workerModel],
      },
    }
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
