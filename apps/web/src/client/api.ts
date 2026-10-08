import type { ColonyMetrics, MyrEvent } from '@myrmidon/protocol'
import { copy } from './copy.ts'

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
/**
 * The CLI's token, on this machine. A device paired with a remote gateway has none: its HttpOnly cookie goes along by
 * itself, on requests and sockets alike.
 */
const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
if (location.hash.includes('token=')) history.replaceState(null, '', location.pathname)
// Opening a fresh CLI link in an already-open tab only changes the hash; reload so the new token is used.
window.addEventListener('hashchange', () => {
  if (location.hash.includes('token=')) location.reload()
})

export class ApiError extends Error {}

const GATEWAY_KEY = 'myr-gateway'

/** The gateway this window shows: its own choice (this tab), else the last one chosen anywhere. */
function readGateway(): string | undefined {
  try {
    return sessionStorage.getItem(GATEWAY_KEY) ?? localStorage.getItem(GATEWAY_KEY) ?? undefined
  } catch {
    return undefined
  }
}

const gateway = readGateway()
/**
 * Where this window's requests go: this machine's own API, or another gateway's through it (`/gw/<id>`), which
 * forwards them with its token there. Every request and socket below goes through this one prefix.
 */
const base = gateway ? `/gw/${gateway}` : ''

/** The other gateway this window shows, if any; undefined for this machine. */
export const activeGateway = () => gateway

/** Shows another gateway (or this machine) in this window; everything reloads, so nothing of one mixes with another. */
export function switchGateway(id: string | undefined) {
  try {
    for (const store of [sessionStorage, localStorage]) {
      if (id) store.setItem(GATEWAY_KEY, id)
      else store.removeItem(GATEWAY_KEY)
    }
  } catch {
    // Storage blocked: the switch lasts until this page reloads by other means.
  }
  location.reload()
}

type PreviewConfig = { previewOrigin: string; previewToken: string } | { previewOrigin: null }
let previewConfig: Promise<PreviewConfig> | undefined

/**
 * Agent-built pages are served from a separate preview origin with this device's own key. Undefined when a remote
 * gateway has no preview address this device can reach.
 */
export async function previewUrl(colony: string, artifact: string): Promise<string | undefined> {
  previewConfig ??= api<PreviewConfig>('/api/config')
  const config = await previewConfig
  if (config.previewOrigin === null) return undefined
  return `${config.previewOrigin}/${colony}/${config.previewToken}/${artifact.split('/').map(encodeURIComponent).join('/')}`
}

export async function api<T>(path: string): Promise<T> {
  return hubApi<T>(`${base}${path}`)
}

/** A request to this machine itself, whichever gateway the window shows (the list of gateways lives here). */
export async function hubApi<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: auth })
  if (!res.ok) throw new ApiError(res.status === 401 ? copy.auth.notAuthorized : `${res.status} ${path}`)
  return res.json() as Promise<T>
}

/** A browser keyframe as an object URL for <img src>, fetched with the auth header (no token in URLs). */
export async function keyframeImage(colony: string, hash: string): Promise<string> {
  const res = await fetch(`${base}/api/colonies/${colony}/blobs/${hash}?as=jpeg`, {
    headers: auth,
  })
  if (!res.ok) throw new ApiError(`keyframe ${hash.slice(0, 8)}: ${res.status}`)
  return URL.createObjectURL(await res.blob())
}

/** A plugin's built UI, imported from an object URL so the token stays in the header, never in a URL. */
export async function importPluginUI(name: string): Promise<unknown> {
  // A plugin's screen runs as part of this page, with this machine's access; one from another gateway opens there.
  if (gateway) throw new ApiError(copy.gateways.pluginElsewhere)
  const res = await fetch(`/api/plugins/${encodeURIComponent(name)}/ui.js`, {
    headers: auth,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(body.error ?? `${name} UI: ${res.status}`)
  }
  const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function blobText(colony: string, hash: string): Promise<string> {
  const res = await fetch(`${base}/api/colonies/${colony}/blobs/${hash}`, {
    headers: auth,
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
    `${proto}://${location.host}${base}/api/colonies/${colony}/browser/${encodeURIComponent(agent)}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
  )
}

/** The person's own login shell, in a project folder (or home); output arrives as binary frames. */
export function terminalSocket(project: string | undefined, cols: number, rows: number): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const query = new URLSearchParams({
    ...(token ? { token } : {}),
    cols: String(cols),
    rows: String(rows),
    ...(project ? { project } : {}),
  })
  const ws = new WebSocket(`${proto}://${location.host}${base}/api/terminal?${query}`)
  ws.binaryType = 'arraybuffer'
  return ws
}

/** A speaking agent's reply as it is being written; `done` when that model message has ended. */
export interface ReplyStream {
  agent: string
  text: string
  done: boolean
}

export function streamEvents(
  colony: string,
  from: number,
  onEvents: (events: MyrEvent[]) => void,
  onStream?: (stream: ReplyStream) => void,
): () => void {
  let cursor = from
  let ws: WebSocket | undefined
  let closed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(
      `${proto}://${location.host}${base}/api/colonies/${colony}/stream?from=${cursor}${token ? `&token=${encodeURIComponent(token)}` : ''}`,
    )
    ws.onmessage = (msg) => {
      const data = JSON.parse(String(msg.data)) as MyrEvent[] | ({ type: 'stream' } & ReplyStream)
      if (!Array.isArray(data)) {
        if (data.type === 'stream') onStream?.({ agent: data.agent, text: data.text, done: data.done })
        return
      }
      const events = data
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
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
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
  /** Where `contextWindow` came from: set by the person, the provider, models.dev, or the model's name; absent for a guess. */
  windowSource?: 'set' | 'provider' | 'catalog' | 'name'
  source?: 'omp' | 'custom' | 'key'
  hidden?: boolean
}

export async function send<T>(
  method: 'PUT' | 'PATCH' | 'DELETE' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  return hubSend<T>(method, `${base}${path}`, body)
}

/** A change on this machine itself, whichever gateway the window shows. */
export async function hubSend<T>(
  method: 'PUT' | 'PATCH' | 'DELETE' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
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
  /** One of the person's saved specialists, by name: it joins as they set it up. */
  specialist?: string
}

/** An agent the person defined once and brings back (Settings → Specialists). */
export interface Specialist {
  id: string
  name: string
  specialty: string
  instructions: string
  model?: string
  /** Tool groups it may not use. */
  off: ('web' | 'shell' | 'files' | 'browser' | 'mcp')[]
  createdAt: string
}

/** Sent when specialists change, so pickers listing them load them again. */
export const SPECIALISTS_CHANGED = 'myr-specialists-changed'

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
  /** `always` starts every round as the team; omitted, the lead brings helpers in only when the work needs it. */
  helpers?: 'always'
}

/** When the reviewer checks the work: never, when the lead asks, or on every final answer. */
export type ReviewMode = 'off' | 'auto' | 'always'

type StoredSettings = { verification: { reviewer: ReviewMode } & Record<string, unknown> } & Record<
  string,
  unknown
>

export async function getReviewMode(): Promise<ReviewMode> {
  return (await api<{ settings: StoredSettings }>('/api/settings')).settings.verification.reviewer
}

/** Saving settings replaces them whole, so this reads them first and changes only the reviewer mode. */
export async function setReviewMode(reviewer: ReviewMode): Promise<void> {
  const { settings } = await api<{ settings: StoredSettings }>('/api/settings')
  await send('PUT', '/api/settings', { ...settings, verification: { ...settings.verification, reviewer } })
}

export const SPECIALISTS = ['researcher', 'coder', 'writer', 'reviewer', 'designer', 'analyst'] as const

/** The provider part of a `provider/model` ref. */
export const providerOf = (ref: string) => ref.slice(0, Math.max(0, ref.indexOf('/')))

/** A usable team config from saved preferences, including the older `auto`/`manual` shape. */
export function normalizeConfig(raw: Record<string, unknown>, fallbackModel: string): TeamConfig {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const leadModel = str(raw.leadModel) ?? fallbackModel
  const workerModel = str(raw.workerModel) ?? leadModel
  const judgeModel = str(raw.judgeModel) ?? leadModel
  const thinking = ['low', 'medium', 'high'].includes(raw.thinking as string)
    ? { thinking: raw.thinking as 'low' | 'medium' | 'high' }
    : {}
  const helpers = raw.helpers === 'always' ? { helpers: 'always' as const } : {}
  const roster = Array.isArray(raw.roster)
    ? (raw.roster as RosterEntry[])
        .filter((r) => typeof r?.role === 'string' && str(r?.model))
        .slice(0, 8)
        .map((r) => ({
          role: r.role,
          model: r.model,
          ...(typeof r.specialist === 'string' && r.specialist ? { specialist: r.specialist } : {}),
        }))
    : undefined
  if (raw.mode === 'swarm')
    return {
      mode: 'swarm',
      leadModel,
      roster: roster?.length ? roster : [0, 1, 2].map(() => ({ role: 'peer', model: workerModel })),
      extraWorkers: 0,
      judgeModel,
      ...thinking,
      ...helpers,
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
    ...helpers,
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
  /** The latest round stopped to wait for the person's answer. */
  awaiting?: boolean
  rounds: ChatRound[]
  /** The project folder the chat works in. */
  project?: { id: string; name: string }
  /** Crew members the person can write to directly (@name), the lead aside. */
  crew?: CrewMember[]
}

export interface CrewMember {
  name: string
  role: string
  specialty?: string
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

/** Who this is to the server: whether it is a remote gateway, and this device's scope. 401 when not signed in. */
export interface WhoAmI {
  scope: 'full' | 'chat'
  remote: boolean
  device?: { id: string; name: string }
}

/** Who this is to this machine (not to the gateway the window shows): pairing happens here. */
export async function whoami(): Promise<{ ok: true; me: WhoAmI } | { ok: false; remote: boolean }> {
  const res = await fetch('/api/whoami', { headers: auth })
  const data = (await res.json().catch(() => ({}))) as WhoAmI & { remote?: boolean }
  return res.ok ? { ok: true, me: data } : { ok: false, remote: data.remote === true }
}

/** Pairs this browser with the gateway using a code from `myrmidon pair`; the server sets the device cookie. */
export async function pairDevice(code: string, name: string): Promise<void> {
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(data.error ?? `pairing failed (${res.status})`)
}

/** Another gateway as this machine (the hub) lists it; its token stays here. */
export interface GatewayInfo {
  id: string
  name: string
  url: string
  scope: 'full' | 'chat'
  addedAt: string
  health: { ok: boolean; error?: string; checkedAt: string }
}

export const listGateways = () => hubApi<{ gateways: GatewayInfo[] }>('/api/gateways').then((r) => r.gateways)

/** Sent when gateways are added or removed, so the switcher lists them again at once. */
export const GATEWAYS_CHANGED = 'myr-gateways-changed'
