import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, reachable } from './api.ts'
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
  /** The sandbox is off in Settings: the person's chats run with full access. */
  fullAccess?: boolean
  running?: { chatId: string; title: string }[]
  /** The skill curator's last archiving. */
  skillsArchived?: { at: string; names: string[] }
  channels?: {
    id: string
    label: string
    enabled: boolean
    /** Set up (on or off); when absent the server listed only channels in use. */
    configured?: boolean
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
  /** The gateway answered the last check with an error, in plain words. */
  error?: string
  /** How long the last check took, in milliseconds. */
  ping?: number
  refresh(): void
}

export const StatusContext = createContext<StatusState>({ offline: false, refresh: () => {} })

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
      // A refusal or an error is an answer: the gateway is up. Only a request nobody answered means it is unreachable.
      const offline = !reachable()
      setState((s) => ({ ...s, offline, ...(offline ? {} : { error: (err as Error).message }) }))
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
