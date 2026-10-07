import { useCallback, useEffect, useRef, useState } from 'react'
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
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
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
