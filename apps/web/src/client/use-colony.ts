import { type ColonyState, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ReplyStream, streamEvents } from './api.ts'

/** A reply still being written, and the log's head when it began (the finished reply lands after it). */
export interface LiveReply {
  readonly text: string
  readonly since: number
  readonly done: boolean
}

export interface ColonyView {
  readonly events: readonly MyrEvent[]
  readonly state: ColonyState
  readonly cursor: number
  readonly head: number
  readonly live: boolean
  setCursor(seq: number): void
  setLive(live: boolean): void
  readonly error?: string
  /** Replies being written now, by agent; live only, never in the log. */
  readonly streams: Readonly<Record<string, LiveReply>>
}

/** Loads a colony's log, keeps it streaming, and folds state at the replay cursor. */
export function useColony(id: string): ColonyView {
  const [events, setEvents] = useState<MyrEvent[]>([])
  const [cursor, setCursorState] = useState(0)
  const [live, setLive] = useState(true)
  const [error, setError] = useState<string>()
  const [streams, setStreams] = useState<Record<string, LiveReply>>({})
  const liveRef = useRef(live)
  liveRef.current = live
  const headRef = useRef(0)

  useEffect(() => {
    let stop = () => {}
    let cancelled = false
    setEvents([])
    setCursorState(0)
    setError(undefined)
    setStreams({})
    const onStream = (s: ReplyStream) =>
      setStreams((prev) => {
        const current = prev[s.agent]
        const since = current && !current.done ? current.since : headRef.current
        return { ...prev, [s.agent]: { text: s.text || current?.text || '', since, done: s.done } }
      })
    api<MyrEvent[]>(`/api/colonies/${id}/events?from=1&limit=20000`)
      .then((initial) => {
        if (cancelled) return
        setEvents(initial)
        setCursorState(initial.at(-1)?.seq ?? 0)
        headRef.current = initial.at(-1)?.seq ?? 0
        stop = streamEvents(
          id,
          (initial.at(-1)?.seq ?? 0) + 1,
          (more) => {
            headRef.current = Math.max(headRef.current, more.at(-1)?.seq ?? 0)
            setEvents((prev) => {
              const last = prev.at(-1)?.seq ?? 0
              const fresh = more.filter((e) => e.seq > last)
              return fresh.length ? [...prev, ...fresh] : prev
            })
            if (liveRef.current) setCursorState(more.at(-1)?.seq ?? 0)
          },
          onStream,
        )
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
    streams,
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
