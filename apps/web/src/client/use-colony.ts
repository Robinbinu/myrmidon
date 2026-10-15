import {
  applyEvent,
  type ColonyMetrics,
  type ColonyState,
  emptyColonyState,
  type MyrEvent,
  metricsBefore,
  type RoundSlice,
  roundSlice,
} from '@myrmidon/protocol'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api, type ReplyStream, streamEvents } from './api.ts'
import { perfOn, perfReport, watchFrames } from './perf.ts'
import { STREAM_RENDER_MS } from './ui-config.ts'

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
  /** Replies being written now, by agent; live only, never in the log. Read them with `useLiveReplies`. */
  readonly streams: LiveReplies
}

const NO_REPLIES: Readonly<Record<string, LiveReply>> = {}

/**
 * Replies being written now, by agent, kept outside React state: a reply moves on several times a second per agent,
 * and as state of the colony's view it re-rendered everything showing the colony (its log, panels, crew screen) each
 * time. Only what shows replies subscribes, and it hears at most one change every `STREAM_RENDER_MS`.
 */
export class LiveReplies {
  private value: Readonly<Record<string, LiveReply>> = NO_REPLIES
  private readonly listeners = new Set<() => void>()
  private notified = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly get = () => this.value

  /** Takes in one piece of a reply; `head` is the log's head now, where a reply that starts begins. */
  take(s: ReplyStream, head: number) {
    const current = this.value[s.agent]
    const since = current && !current.done ? current.since : head
    this.value = { ...this.value, [s.agent]: { text: s.text || current?.text || '', since, done: s.done } }
    this.schedule()
  }

  clear() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.value = NO_REPLIES
    this.notify()
  }

  private schedule() {
    if (this.timer) return
    const wait = this.notified + STREAM_RENDER_MS - performance.now()
    if (wait <= 0) return this.notify()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.notify()
    }, wait)
  }

  private notify() {
    this.notified = performance.now()
    for (const listener of this.listeners) listener()
  }
}

/** The replies being written now; `enabled` false reads none and re-renders for none. */
export function useLiveReplies(replies: LiveReplies, enabled = true): Readonly<Record<string, LiveReply>> {
  const get = enabled ? replies.get : () => NO_REPLIES
  return useSyncExternalStore(replies.subscribe, get, get)
}

/** A fold of a colony's log so far: the state after its first `count` events, the last of which was `last`. */
export interface Fold {
  readonly id: string
  readonly count: number
  readonly last?: MyrEvent
  /** Folded into in place; never handed out. */
  readonly working: ColonyState
  /** What was handed out for this fold. */
  readonly state: ColonyState
}

/**
 * The state at `cursor`, folded on from `prev` when the log only grew past it and the cursor did not move back, else
 * from the start. Folding the whole log again for every batch the stream brings costs more the longer the colony
 * runs (tens of ms at 50k events, for each view of the colony), and the stream brings one every few hundred ms.
 *
 * Each fold hands out a new top-level object, so what is memoized on the state sees the change; the entries inside it
 * (agents, mail, rounds …) are shared with earlier folds and updated in place, so memoize on the state or the events,
 * never on a part of the state alone.
 */
export function foldTo(
  prev: Fold | undefined,
  id: string,
  events: readonly MyrEvent[],
  cursor: number,
): Fold {
  const grew =
    prev !== undefined &&
    prev.id === id &&
    events.length >= prev.count &&
    events[prev.count - 1] === prev.last &&
    cursor >= (prev.last?.seq ?? 0)
  const working = grew ? prev.working : emptyColonyState(id)
  let count = grew ? prev.count : 0
  while (count < events.length && (events[count] as MyrEvent).seq <= cursor) {
    applyEvent(working, events[count] as MyrEvent)
    count++
  }
  if (grew && count === prev.count) return prev
  return { id, count, last: events[count - 1], working, state: { ...working } }
}

/** Loads a colony's log, keeps it streaming, and folds state at the replay cursor. */
export function useColony(id: string): ColonyView {
  const [events, setEvents] = useState<MyrEvent[]>([])
  const [cursor, setCursorState] = useState(0)
  const [live, setLive] = useState(true)
  const [error, setError] = useState<string>()
  const [streams] = useState(() => new LiveReplies())
  // When the last batch of events came in, and how many, for the responsiveness log.
  const arrived = useRef<{ at: number; count: number }>(undefined)
  const liveRef = useRef(live)
  liveRef.current = live
  const headRef = useRef(0)

  useEffect(() => {
    let stop = () => {}
    let cancelled = false
    setEvents([])
    setCursorState(0)
    setError(undefined)
    streams.clear()
    const onStream = (s: ReplyStream) => streams.take(s, headRef.current)
    const frames = perfOn() ? watchFrames() : () => {}
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
            arrived.current = { at: performance.now(), count: more.length }
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
      frames()
    }
  }, [id, streams])

  const head = events.at(-1)?.seq ?? 0
  const fold = useRef<Fold>(undefined)
  const state = useMemo(() => {
    const started = performance.now()
    fold.current = foldTo(fold.current, id, events, cursor)
    if (perfOn()) perfReport('fold', { ms: performance.now() - started, events: events.length })
    return fold.current.state
  }, [id, events, cursor])
  // From a batch coming in to the screen showing it: what the person waits for.
  useEffect(() => {
    const batch = arrived.current
    if (!batch || !perfOn()) return
    arrived.current = undefined
    perfReport('batch', { ms: performance.now() - batch.at, size: batch.count, events: events.length })
  }, [events])

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

/**
 * One round of the colony (the latest without `round`), as `roundSlice` cuts it, for a view that shows it as the log
 * grows. Slicing folds the log up to the round's start and end; a chat shows every round it ran, so doing that again
 * for each round on every batch the stream brings grows with rounds × events (over a second a batch at 100 rounds and
 * 50k events). What those folds give no longer changes once passed, so they are kept: an earlier round's slice until
 * the log reloads (only its round info is taken fresh), and the totals before the latest round began while it runs.
 */
export function useRoundSlice(colony: Pick<ColonyView, 'state' | 'events'>, round?: number): RoundSlice {
  const kept = useRef<{
    first?: MyrEvent
    start: number
    end?: number
    slice?: RoundSlice
    before?: ColonyMetrics
  }>(undefined)
  const { state, events } = colony
  return useMemo(() => {
    const info = round === undefined ? state.rounds.at(-1) : state.rounds.find((r) => r.round === round)
    if (!info) return roundSlice(state, events, round)
    const k = kept.current
    const same = k !== undefined && k.first === events[0] && k.start === info.startSeq
    // Only the latest round can still change: a resume reopens it; later rounds leave earlier ones as they ended.
    const ended = info !== state.rounds.at(-1) && info.endSeq !== undefined
    if (same && ended && k.end === info.endSeq && k.slice)
      return k.slice.info === info ? k.slice : { ...k.slice, info }
    const before = same && k.before ? k.before : metricsBefore(state.id, events, info)
    const slice = roundSlice(state, events, round, before)
    kept.current = {
      first: events[0],
      start: info.startSeq,
      end: info.endSeq,
      before,
      ...(ended ? { slice } : {}),
    }
    return slice
  }, [state, events, round])
}
