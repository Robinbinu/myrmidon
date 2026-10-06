import { type ColonyState, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, streamEvents } from './api.ts'

export interface ColonyView {
  readonly events: readonly MyrEvent[]
  readonly state: ColonyState
  readonly cursor: number
  readonly head: number
  readonly live: boolean
  setCursor(seq: number): void
  setLive(live: boolean): void
  readonly error?: string
}

/** Loads a colony's log, keeps it streaming, and folds state at the replay cursor. */
export function useColony(id: string): ColonyView {
  const [events, setEvents] = useState<MyrEvent[]>([])
  const [cursor, setCursorState] = useState(0)
  const [live, setLive] = useState(true)
  const [error, setError] = useState<string>()
  const liveRef = useRef(live)
  liveRef.current = live

  useEffect(() => {
    let stop = () => {}
    let cancelled = false
    setEvents([])
    setCursorState(0)
    setError(undefined)
    api<MyrEvent[]>(`/api/colonies/${id}/events?from=1&limit=20000`)
      .then((initial) => {
        if (cancelled) return
        setEvents(initial)
        setCursorState(initial.at(-1)?.seq ?? 0)
        stop = streamEvents(id, (initial.at(-1)?.seq ?? 0) + 1, (more) => {
          setEvents((prev) => {
            const last = prev.at(-1)?.seq ?? 0
            const fresh = more.filter((e) => e.seq > last)
            return fresh.length ? [...prev, ...fresh] : prev
          })
          if (liveRef.current) setCursorState(more.at(-1)?.seq ?? 0)
        })
      })
      .catch((err) => setError(String(err.message ?? err)))
    return () => {
      cancelled = true
      stop()
    }
  }, [id])

  const head = events.at(-1)?.seq ?? 0
  const state = useMemo(() => foldColony(id, events, cursor), [id, events, cursor])

  return {
    events,
    state,
    cursor,
    head,
    live,
    error,
    setLive: (v) => {
      setLive(v)
      if (v) setCursorState(head)
    },
    setCursor: (seq) => {
      setLive(seq >= head)
      setCursorState(Math.max(0, Math.min(seq, head)))
    },
  }
}
