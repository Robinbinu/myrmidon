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

export interface TeamConfig {
  mode: 'auto' | 'manual'
  leadModel: string
  workerModel: string
  workers: number
  judgeModel: string
}

export interface ChatRound {
  colonyId: string
  round: number
  status: string
  request: string
}

export interface ChatSummary {
  chatId: string
  title: string
  updatedAt: string
  status: string
  rounds: ChatRound[]
}
