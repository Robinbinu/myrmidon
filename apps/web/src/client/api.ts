import type { ColonyMetrics, MyrEvent } from '@myrmidon/protocol'

function readToken(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token')
  try {
    if (fromHash) sessionStorage.setItem('myr-token', fromHash)
    return fromHash ?? sessionStorage.getItem('myr-token') ?? ''
  } catch {
    return fromHash ?? ''
  }
}

const token = readToken()
if (location.hash.includes('token=')) history.replaceState(null, '', location.pathname)
// Opening a fresh CLI link in an already-open tab only changes the hash; reload so the new token is used.
window.addEventListener('hashchange', () => {
  if (location.hash.includes('token=')) location.reload()
})

export class ApiError extends Error {}

let previewConfig: Promise<{ previewOrigin: string; previewToken: string }> | undefined

/** Agent-built pages are served from a separate preview origin with its own token. */
export async function previewUrl(colony: string, artifact: string): Promise<string> {
  previewConfig ??= api<{ previewOrigin: string; previewToken: string }>('/api/config')
  const { previewOrigin, previewToken } = await previewConfig
  return `${previewOrigin}/${colony}/${previewToken}/${artifact.split('/').map(encodeURIComponent).join('/')}`
}

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok)
    throw new ApiError(
      res.status === 401 ? 'Not authorized: open the link printed by the CLI.' : `${res.status} ${path}`,
    )
  return res.json() as Promise<T>
}

/** A browser keyframe as an object URL for <img src>, fetched with the auth header (no token in URLs). */
export async function keyframeImage(colony: string, hash: string): Promise<string> {
  const res = await fetch(`/api/colonies/${colony}/blobs/${hash}?as=jpeg`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(`keyframe ${hash.slice(0, 8)}: ${res.status}`)
  return URL.createObjectURL(await res.blob())
}

export async function blobText(colony: string, hash: string): Promise<string> {
  const res = await fetch(`/api/colonies/${colony}/blobs/${hash}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(`blob ${hash.slice(0, 8)}: ${res.status}`)
  return res.text()
}

export interface ColonySummary {
  id: string
  name: string
  status: string
  statusReason?: string
  pattern: string
  createdAt?: string
  agents: { name: string; model: string; role: string }[]
  metrics: ColonyMetrics
}

/** Streams events from `from` onward, reconnecting with the last seen seq. Returns a closer. */
/** The live-view socket for one agent's browser tab. */
export function browserSocket(colony: string, agent: string): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return new WebSocket(
    `${proto}://${location.host}/api/colonies/${colony}/browser/${encodeURIComponent(agent)}?token=${encodeURIComponent(token)}`,
  )
}

/** The person's own login shell, in a project folder (or home); output arrives as binary frames. */
export function terminalSocket(project: string | undefined, cols: number, rows: number): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const query = new URLSearchParams({
    token,
    cols: String(cols),
    rows: String(rows),
    ...(project ? { project } : {}),
  })
  const ws = new WebSocket(`${proto}://${location.host}/api/terminal?${query}`)
  ws.binaryType = 'arraybuffer'
  return ws
}

export function streamEvents(
  colony: string,
  from: number,
  onEvents: (events: MyrEvent[]) => void,
): () => void {
  let cursor = from
  let ws: WebSocket | undefined
  let closed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(
      `${proto}://${location.host}/api/colonies/${colony}/stream?from=${cursor}&token=${encodeURIComponent(token)}`,
    )
    ws.onmessage = (msg) => {
      const events = JSON.parse(String(msg.data)) as MyrEvent[]
      if (events.length === 0) return
      cursor = (events.at(-1)?.seq ?? cursor - 1) + 1
      onEvents(events)
    }
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 1500)
    }
  }
  connect()
  return () => {
    closed = true
    clearTimeout(retry)
    ws?.close()
  }
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${path}`)
  return data as T
}

export interface ModelOption {
  ref: string
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow?: number
  source?: 'omp' | 'custom' | 'key'
  hidden?: boolean
}

export async function send<T>(
  method: 'PUT' | 'PATCH' | 'DELETE' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${path}`)
  return data as T
}

export interface RosterEntry {
  /** What this teammate is for, e.g. `researcher`; `peer` for an unspecialised swarm peer. */
  role: string
  model: string
}

export interface TeamConfig {
  /** `orchestrated`: a lead assigns tasks to specialists; `swarm`: equal peers share notes and tasks. */
  mode: 'orchestrated' | 'swarm'
  leadModel: string
  /** Specialists (orchestrated) or peers (swarm). */
  roster: RosterEntry[]
  /** Orchestrated: how many more specialists the lead may add. */
  extraWorkers: number
  judgeModel: string
  /** How hard reasoning models think in work rounds; omitted lets each role decide. */
  thinking?: 'low' | 'medium' | 'high'
}

export const SPECIALISTS = ['researcher', 'coder', 'writer', 'reviewer', 'designer', 'analyst'] as const

/** The provider part of a `provider/model` ref. */
export const providerOf = (ref: string) => ref.slice(0, Math.max(0, ref.indexOf('/')))

/**
 * A usable team config from saved preferences, including the older `auto`/`manual` shape. Without a saved judge,
 * the judge comes from another provider than the lead when one is available: a different model catches more of
 * the team's blind spots than the same model grading itself.
 */
export function normalizeConfig(
  raw: Record<string, unknown>,
  fallbackModel: string,
  models: readonly ModelOption[] = [],
): TeamConfig {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const leadModel = str(raw.leadModel) ?? fallbackModel
  const workerModel = str(raw.workerModel) ?? leadModel
  const judgeModel =
    str(raw.judgeModel) ??
    models.find((m) => !m.hidden && m.provider !== providerOf(leadModel))?.ref ??
    leadModel
  const thinking = ['low', 'medium', 'high'].includes(raw.thinking as string)
    ? { thinking: raw.thinking as 'low' | 'medium' | 'high' }
    : {}
  const roster = Array.isArray(raw.roster)
    ? (raw.roster as RosterEntry[]).filter((r) => typeof r?.role === 'string' && str(r?.model)).slice(0, 8)
    : undefined
  if (raw.mode === 'swarm')
    return {
      mode: 'swarm',
      leadModel,
      roster: roster?.length ? roster : [0, 1, 2].map(() => ({ role: 'peer', model: workerModel })),
      extraWorkers: 0,
      judgeModel,
      ...thinking,
    }
  return {
    mode: 'orchestrated',
    leadModel,
    roster: roster ?? [
      { role: 'researcher', model: workerModel },
      { role: 'coder', model: workerModel },
    ],
    extraWorkers: typeof raw.extraWorkers === 'number' ? raw.extraWorkers : 2,
    judgeModel,
    ...thinking,
  }
}

export interface ChatRound {
  colonyId: string
  round: number
  status: string
  request: string
  swarm?: boolean
}

export interface ChatSummary {
  chatId: string
  title: string
  updatedAt: string
  status: string
  rounds: ChatRound[]
  /** The project folder the chat works in. */
  project?: { id: string; name: string }
}

/** A folder chats can work in, like a Claude Code or Codex project. */
export interface Project {
  id: string
  name: string
  path: string
  addedAt: string
  /** How freely agents may change the folder; absent means autonomous. */
  permissions?: { mode: 'auto' | 'ask' | 'read-only'; allow: string[] }
}
