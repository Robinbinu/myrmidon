import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { STICK_SLACK_PX, USER_SCROLL_MS } from '../ui-config.ts'
import { matchCombo } from './shortcuts.ts'

export type ThemeChoice = 'system' | 'light' | 'dark'

export function readStored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback
  } catch {
    return fallback
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Preferences are a convenience; private browsing simply forgets them.
  }
}

/** Light / dark / system theme, applied as `data-theme` on <html>. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(() => readStored('myr-theme', 'system'))
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    store('myr-theme', theme)
  }, [theme])
  return [theme, setTheme]
}

/** Whether this browser should notify the person when a round finishes in the background. */
export const NOTIFY_KEY = 'myr-notify'

export function usePersistentFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => readStored(key, initial ? '1' : '0') === '1')
  return [
    value,
    (v) => {
      setValue(v)
      store(key, v ? '1' : '0')
    },
  ]
}

/**
 * How far the person has read each of a colony's mail conversations: the last message seq they saw, by conversation
 * id. Kept in this browser; a conversation never opened here counts all its messages as unread.
 */
export function useSeenMail(
  colonyId: string,
): [Record<string, number>, (thread: string, seq: number) => void] {
  const key = `myr-mail-seen:${colonyId}`
  const [seen, setSeen] = useState<Record<string, number>>(() => readSeen(key))
  useEffect(() => {
    setSeen(readSeen(key))
  }, [key])
  const mark = useCallback(
    (thread: string, seq: number) =>
      setSeen((prev) => {
        if ((prev[thread] ?? 0) >= seq) return prev
        const next = { ...prev, [thread]: seq }
        store(key, JSON.stringify(next))
        return next
      }),
    [key],
  )
  return [seen, mark]
}

const CHATS_SEEN = 'myr-chat-seen'

/**
 * Which chats finished since the person last looked at them, as Codex and Claude Code mark them with a blue dot. Each
 * chat's `updatedAt` when last open is kept in this browser; the chat open now is always seen. The first time, every
 * chat already listed counts as seen, so an existing list does not light up all at once.
 */
export function useUnreadChats(
  chats: readonly { chatId: string; updatedAt: string }[],
  loaded: boolean,
  open: string | undefined,
): (chat: { chatId: string; updatedAt: string }) => boolean {
  const [seen, setSeen] = useState<Record<string, string>>(() => readSeenChats() ?? {})
  const openAt = chats.find((c) => c.chatId === open)?.updatedAt
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded once, from the first list that loads
  useEffect(() => {
    if (!loaded || readSeenChats() !== undefined) return
    const first = Object.fromEntries(chats.map((c) => [c.chatId, c.updatedAt]))
    store(CHATS_SEEN, JSON.stringify(first))
    setSeen(first)
  }, [loaded])
  useEffect(() => {
    if (!open || !openAt) return
    setSeen((prev) => {
      if ((prev[open] ?? '') >= openAt) return prev
      const next = { ...prev, [open]: openAt }
      store(CHATS_SEEN, JSON.stringify(next))
      return next
    })
  }, [open, openAt])
  return (chat) => chat.chatId !== open && chat.updatedAt > (seen[chat.chatId] ?? '')
}

function readSeenChats(): Record<string, string> | undefined {
  try {
    const raw: unknown = JSON.parse(readStored(CHATS_SEEN, 'null'))
    if (!raw || typeof raw !== 'object') return undefined
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<
      string,
      string
    >
  } catch {
    return undefined
  }
}

function readSeen(key: string): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(readStored(key, '{}'))
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number')) as Record<
      string,
      number
    >
  } catch {
    return {}
  }
}

/**
 * The in-app Reduce motion setting. Motion's components read it through MotionConfig; CSS animations cannot, so it is
 * also applied as `data-reduce-motion` on <html>.
 */
export function useReduceMotion(): [boolean, (v: boolean) => void] {
  const [reduce, setReduce] = usePersistentFlag('myr-reduce-motion', false)
  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduce)
  }, [reduce])
  return [reduce, setReduce]
}

/** Whether the window is at least `px` wide, following it as it resizes or zooms. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const change = () => setMatch(media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [query])
  return match
}

/**
 * When a control replaces the one that had focus (a call bar for the Call button that started it), focus lands on
 * `ref` instead of falling to the page, where the keyboard would have to start again from the top.
 */
export function useFocusWhenLost(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const at = document.activeElement
    if (!at || at === document.body) ref.current?.focus()
  }, [ref])
}

/** Copies text and reports `copied` for a moment so buttons can confirm it. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1400)
    })
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [copied, copy]
}

export interface Hotkey {
  /** e.g. 'mod+k', '/', 'escape', 'mod+shift+[' (see shortcuts.ts) */
  readonly combo: string
  readonly run: (e: KeyboardEvent) => void
  /** Fire even while typing in an input. */
  readonly inInputs?: boolean
}

export function useHotkeys(keys: readonly Hotkey[]) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      for (const k of ref.current) {
        if (!matchCombo(k.combo, e)) continue
        if (typing && !k.inInputs) continue
        e.preventDefault()
        k.run(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Relative time like "3m ago", refreshed by the caller's re-renders. */
export function ago(iso?: string): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 45) return copy.time.justNow
  if (s < 3600) return copy.time.minutesAgo(Math.round(s / 60))
  if (s < 86_400) return copy.time.hoursAgo(Math.round(s / 3600))
  return copy.time.daysAgo(Math.round(s / 86_400))
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const CLOCK_SECONDS = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const DAY_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function local(format: Intl.DateTimeFormat, iso: string | undefined): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(at) ? '' : format.format(at)
}

/** The time of day of an event, in the reader's own zone and clock style; events are stamped in UTC. */
export function clock(iso: string | undefined, seconds = false): string {
  return local(seconds ? CLOCK_SECONDS : CLOCK, iso)
}

/** The local date of a UTC timestamp, with its time of day when `withTime`. */
export function day(iso: string | undefined, withTime = false): string {
  return local(withTime ? DAY_TIME : DAY, iso)
}

/**
 * A run's cost when it is known. Providers report $0 for a model they have no price for, so a zero after tokens were
 * spent means unknown rather than free.
 */
export function knownCost(cost: number | undefined, tokens: number): number | undefined {
  return cost === 0 && tokens > 0 ? undefined : cost
}

/** A run's cost for display, or "n/a" when it is not known. */
export function money(cost: number | undefined, tokens: number): string {
  const known = knownCost(cost, tokens)
  return known === undefined ? copy.unknownCost : `$${known.toFixed(3)}`
}

export function compact(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n)
}

/**
 * Keeps a scrolling view on its newest content, at the bottom: when it opens, and as content loads or grows, unless the
 * reader scrolled up to read something older (scrolling back down picks it up again). A new `key` (another chat or
 * conversation opened) starts at the bottom again.
 */
export function useStickToBottom<T extends HTMLElement>(key?: unknown) {
  return useFollowLatest<T>(key).ref
}

export interface FollowLatest<T extends HTMLElement> {
  readonly ref: RefObject<T | null>
  /** The reader scrolled up, away from the newest content. */
  readonly away: boolean
  /** More content arrived while they were away. */
  readonly fresh: boolean
  /** Back to the newest content, following it again. */
  jump(): void
}

/** useStickToBottom, plus whether the reader has left the bottom, so the view can offer a way back. */
export function useFollowLatest<T extends HTMLElement>(key?: unknown): FollowLatest<T> {
  const ref = useRef<T>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  // The content's height when the reader left the bottom: growing past it is new activity, a pill appearing is not.
  const leftAt = useRef(0)
  const setStick = useCallback((value: boolean) => {
    if (!value && stick.current) leftAt.current = ref.current?.scrollHeight ?? 0
    stick.current = value
    setAway(!value)
    if (value) setFresh(false)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key is what sends the view back to the bottom
  useLayoutEffect(() => {
    setStick(true)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [key])
  const jump = useCallback(() => {
    setStick(true)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setStick])
  // biome-ignore lint/correctness/useExhaustiveDependencies: observers are set up again for each key's content
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight
      else if (el.scrollHeight > leftAt.current) setFresh(true)
    }
    // Only the reader scrolling can stop the follow. The browser also moves the view on its own (scroll anchoring
    // keeps what is on screen in place while earlier content loads), and that must not count as reading back.
    let touched = 0
    let dragging = false
    const reading = () => dragging || Date.now() - touched < USER_SCROLL_MS
    const touch = () => {
      touched = Date.now()
    }
    const press = () => {
      dragging = true
      touch()
    }
    const release = () => {
      dragging = false
    }
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX
      if (near) setStick(true)
      else if (reading()) setStick(false)
    }
    const intents = ['wheel', 'touchmove', 'keydown'] as const
    for (const name of intents) el.addEventListener(name, touch, { passive: true })
    el.addEventListener('pointerdown', press, { passive: true })
    window.addEventListener('pointerup', release, { passive: true })
    // Content grows after it opens (rounds load their events, cards animate in), so watch the content, not renders:
    // its size (animations, images) and its DOM (new messages). Size changes are only reported when the page renders,
    // so a window opened in the background relies on the DOM changes.
    const sizes = new ResizeObserver(follow)
    const watch = () => {
      sizes.observe(el)
      for (const child of el.children) sizes.observe(child)
    }
    const changes = new MutationObserver(() => {
      watch()
      follow()
    })
    watch()
    changes.observe(el, { childList: true, subtree: true, characterData: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      sizes.disconnect()
      changes.disconnect()
      el.removeEventListener('scroll', onScroll)
      for (const name of intents) el.removeEventListener(name, touch)
      el.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
    }
  }, [key])
  return { ref, away, fresh, jump }
}
