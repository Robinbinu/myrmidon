import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { EyeStyle } from './ui/pixel.tsx'
import { GREETING_REFRESH_MS, GREETING_RETRY_MS, type MASCOT_COLORS } from './ui-config.ts'

export interface MascotLook {
  eyes: EyeStyle
  look: 'neutral' | 'flower' | 'bow'
  color: keyof typeof MASCOT_COLORS
  screen: 'face' | 'clock' | 'name' | 'crew' | 'rotate'
}

export const DEFAULT_MASCOT: MascotLook = { eyes: 'round', look: 'neutral', color: 'amber', screen: 'rotate' }

/** The home screen's mascot and the setup assistant's are one to the eye: setup's settles into the home screen's place. */
export const MASCOT_LAYOUT_ID = 'mascot'

/** Sent when Settings saves, so the mascot on the entry page picks up a new look at once. */
export const SETTINGS_SAVED = 'myr-settings-saved'

/** How the person dressed the mascot in Settings. */
export function useMascotLook(): MascotLook {
  const [look, setLook] = useState(DEFAULT_MASCOT)
  useEffect(() => {
    const load = () =>
      api<{ settings: { mascot?: MascotLook } }>('/api/settings')
        .then((r) => setLook({ ...DEFAULT_MASCOT, ...r.settings.mascot }))
        .catch(() => {})
    load()
    window.addEventListener(SETTINGS_SAVED, load)
    return () => window.removeEventListener(SETTINGS_SAVED, load)
  }, [])
  return look
}

export interface Greeting {
  headline: string
}

const LAST_SEEN = 'myr-last-seen'

/** When the person last had Myrmidon open, read once per page load; from then on this visit is "now". */
const lastSeen = (() => {
  try {
    const previous = localStorage.getItem(LAST_SEEN) ?? undefined
    const mark = () => localStorage.setItem(LAST_SEEN, new Date().toISOString())
    mark()
    setInterval(mark, 60_000)
    window.addEventListener('pagehide', mark)
    return previous
  } catch {
    return undefined
  }
})()

/**
 * The entry page's greeting and the person's name. Asked for again when `news` (what the chats are doing) changes and
 * every few minutes; while the model is still writing it, the rules' line shows and the page asks again shortly.
 */
export function useGreeting(news: string): { greeting?: Greeting; name?: string } {
  const [state, setState] = useState<{ greeting?: Greeting; name?: string }>({})
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `news` changing is what asks for a fresh greeting
  useEffect(() => {
    let alive = true
    let tries = 0
    const load = () => {
      clearTimeout(timer.current)
      api<{ greeting: Greeting; name: string; pending: boolean }>(
        `/api/greeting${lastSeen ? `?lastSeen=${encodeURIComponent(lastSeen)}` : ''}`,
      )
        .then((r) => {
          if (!alive) return
          setState({ greeting: r.greeting, name: r.name })
          const retry = r.pending && tries++ < 5
          timer.current = setTimeout(load, retry ? GREETING_RETRY_MS : GREETING_REFRESH_MS)
        })
        .catch(() => {
          if (alive) timer.current = setTimeout(load, GREETING_REFRESH_MS)
        })
    }
    load()
    window.addEventListener(SETTINGS_SAVED, load)
    return () => {
      alive = false
      clearTimeout(timer.current)
      window.removeEventListener(SETTINGS_SAVED, load)
    }
  }, [news])
  return state
}
