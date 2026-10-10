import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { EyeStyle } from './ui/pixel.tsx'
import {
  type CREW_BOLDNESS,
  GREETING_REFRESH_MS,
  GREETING_RETRY_MS,
  type MASCOT_COLORS,
  type MASCOT_IDLE,
  type MASCOT_SOUNDS,
} from './ui-config.ts'

export type DotShape = 'led' | 'round' | 'square'
export type GridLook = 'faint' | 'tinted' | 'off'
export type GlowLook = 'off' | 'soft' | 'strong'

/** How the person set the mascot up in Settings → You & mascot; the gateway's settings.ts holds the same shape. */
export interface MascotLook {
  eyes: EyeStyle
  look: 'neutral' | 'flower' | 'bow'
  color: keyof typeof MASCOT_COLORS
  screen: 'face' | 'clock' | 'name' | 'crew' | 'rotate'
  /** How often it plays a trick while left alone. */
  idle: keyof typeof MASCOT_IDLE.chance
  /** The shows that may take its whole screen. */
  shows: { pacman: boolean; life: boolean; confetti: boolean; boot: boolean }
  /** Calm: no bouncing, dizzy spells or knocked-over crew, and only quiet eye tricks. */
  temper: 'calm' | 'playful'
  crew: {
    show: boolean
    count: number
    /** Minions, the person's specialists, or their own list; Minions fill any places left. */
    names: 'minions' | 'specialists' | 'custom'
    custom: string[]
    boldness: keyof typeof CREW_BOLDNESS
  }
  display: {
    dots: DotShape
    grid: GridLook
    glow: GlowLook
    eyeColor: 'own' | 'theme'
    size: 'small' | 'medium' | 'large'
  }
  /** Soft blips (ui/sounds.ts): off until the person turns them on. */
  sounds: { enabled: boolean; reactions: boolean; typing: boolean; volume: keyof typeof MASCOT_SOUNDS.volume }
}

export const DEFAULT_MASCOT: MascotLook = {
  eyes: 'round',
  look: 'neutral',
  color: 'amber',
  screen: 'rotate',
  idle: 'normal',
  shows: { pacman: true, life: true, confetti: true, boot: true },
  temper: 'playful',
  crew: { show: true, count: 3, names: 'minions', custom: [], boldness: 'curious' },
  display: { dots: 'led', grid: 'faint', glow: 'soft', eyeColor: 'own', size: 'medium' },
  sounds: { enabled: false, reactions: true, typing: true, volume: 'quiet' },
}

/** What the mascot's settings may be missing, at any depth: older gateways send only the first four fields. */
export type MascotPatch = Partial<
  Omit<MascotLook, 'shows' | 'crew' | 'display' | 'sounds'> & {
    shows: Partial<MascotLook['shows']>
    crew: Partial<MascotLook['crew']>
    display: Partial<MascotLook['display']>
    sounds: Partial<MascotLook['sounds']>
  }
>

/** The mascot's settings with every group filled in from the defaults, then `patch` on top. */
export function withMascotDefaults(saved?: MascotPatch, patch?: MascotPatch): MascotLook {
  const a = saved ?? {}
  const b = patch ?? {}
  return {
    ...DEFAULT_MASCOT,
    ...a,
    ...b,
    shows: { ...DEFAULT_MASCOT.shows, ...a.shows, ...b.shows },
    crew: { ...DEFAULT_MASCOT.crew, ...a.crew, ...b.crew },
    display: { ...DEFAULT_MASCOT.display, ...a.display, ...b.display },
    sounds: { ...DEFAULT_MASCOT.sounds, ...a.sounds, ...b.sounds },
  }
}

/** The mascot's settings last seen, in this browser, so the screen opens as set up (no boot sweep that was turned off). */
const CACHE_KEY = 'myr-mascot'

function cachedLook(): MascotLook {
  try {
    return withMascotDefaults(JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') ?? undefined)
  } catch {
    return DEFAULT_MASCOT
  }
}

/** The home screen's mascot and the setup assistant's are one to the eye: setup's settles into the home screen's place. */
export const MASCOT_LAYOUT_ID = 'mascot'

/** Sent when Settings saves, so the mascot on the entry page picks up a new look at once. */
export const SETTINGS_SAVED = 'myr-settings-saved'

/** How the person set the mascot up in Settings. */
export function useMascotLook(): MascotLook {
  const [look, setLook] = useState(cachedLook)
  useEffect(() => {
    const load = () =>
      api<{ settings: { mascot?: MascotPatch } }>('/api/settings')
        .then((r) => {
          const next = withMascotDefaults(r.settings.mascot)
          setLook(next)
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(next))
          } catch {
            // Only saves a moment of the default look on the next load.
          }
        })
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
