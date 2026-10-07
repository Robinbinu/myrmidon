import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const ref = useRef<T>(null)
  const stick = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key is what sends the view back to the bottom
  useLayoutEffect(() => {
    stick.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [key])
  // biome-ignore lint/correctness/useExhaustiveDependencies: observers are set up again for each key's content
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight
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
      if (near) stick.current = true
      else if (reading()) stick.current = false
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
  return ref
}
