import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { STATUS_POLL_MS } from './ui-config.ts'

/** What `/api/status` says about this gateway; a chats-only device gets `overall` and `problems` only. */
export interface GatewayStatus {
  overall: 'ok' | 'degraded'
  problems: ({ kind: 'no-models' } | { kind: 'channel'; channel: string; label: string; error: string })[]
  startedAt?: string
  remote?: boolean
  publicUrl?: string
  home?: string
  models?: number
  sandbox?: string
  running?: { chatId: string; title: string }[]
  channels?: {
    id: string
    label: string
    enabled: boolean
    status: { state: string; account?: string; error?: string }
    health: {
      connectedAt?: string
      reconnects: number
      lastError?: string
      lastIn?: string
      lastOut?: string
      owed: number
    }
    waiting: number
  }[]
  waiting?: {
    channel: string
    label: string
    id: string
    kind: 'person' | 'group'
    name: string
    createdAt: string
  }[]
  activity?: { at: string; channel: string; kind: string; text: string }[]
}

interface StatusState {
  status?: GatewayStatus
  /** The gateway did not answer the last check (a network error, not a refusal). */
  offline: boolean
  /** How long the last check took, in milliseconds. */
  ping?: number
  refresh(): void
}

const StatusContext = createContext<StatusState>({ offline: false, refresh: () => {} })

/** The shared view of how the shown gateway is doing, checked every so often and whenever the window comes back. */
export function useStatus() {
  return useContext(StatusContext)
}

export function StatusProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<Omit<StatusState, 'refresh'>>({ offline: false })
  const busy = useRef(false)
  const check = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    const started = performance.now()
    try {
      const status = await api<GatewayStatus>('/api/status')
      setState({ status, offline: false, ping: Math.round(performance.now() - started) })
    } catch (err) {
      // A refusal (401, 403) is an answer: the gateway is up. Only a failed request means it is unreachable.
      setState((s) => ({ ...s, offline: err instanceof TypeError }))
    } finally {
      busy.current = false
    }
  }, [])
  useEffect(() => {
    void check()
    const timer = setInterval(() => void check(), STATUS_POLL_MS)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [check])
  return (
    <StatusContext.Provider value={{ ...state, refresh: () => void check() }}>
      {props.children}
    </StatusContext.Provider>
  )
}
