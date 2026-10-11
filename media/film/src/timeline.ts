import { EASES, type Key, noise, track, tween } from './anim.ts'
import type { CameraState } from './components/World.tsx'

/**
 * The film's timeline: every beat's frames, the camera's path, the light, and the captions. SHOTLIST.md describes the
 * same frames in words; change them together.
 */
export const BEAT = {
  scatter: 0,
  collapse: 300,
  question: 395,
  wordmark: 560,
  dock: 760,
  ask: 780,
  phoneClose: 960,
  send: 1096,
  flight: 1120,
  plan: 1250,
  spawn: 1400,
  nova: 1540,
  iris: 1760,
  quill: 1960,
  /** The camera pulls back on all three finished panels and holds before they fold. */
  together: 2160,
  fold: 2245,
  review: 2425,
  stamp: 2555,
  trust: 2645,
  allow: 2945,
  recede: 3015,
  call: 3030,
  answer: 3133,
  waveOut: 3610,
  reach: 3650,
  models: 3870,
  burst: 4000,
  end: 4030,
  star: 4260,
} as const

export const FILM_FRAMES = 4380

/* ------------------------------------------------------------------ world layout */

/** Where things stand in the world (the camera's space), in px. */
export const WORLD = {
  app: { x: 160, y: 90, w: 1600, h: 960, sidebar: 300 },
  /** The composer on its own (beat 2) and docked in the app. */
  composer: { free: { x: 960, y: 620, w: 1000 }, docked: { x: 1110, y: 958, w: 860 }, h: 150 },
  wordmark: { free: { x: 960, y: 360, pitch: 16 }, docked: { x: 310, y: 176, pitch: 5 } },
  phone: { x: 2400, y: 545 },
  /** The user's message in the app's chat, and the lead's plan under it. */
  chat: { bubble: { right: 1540, top: 172, w: 372 }, lead: { x: 680, y: 334 }, plan: { x: 740, y: 376, w: 520 } },
  panels: { cx: [400, 960, 1520], top: 190, w: 520, h: 780 },
  board: { x: 160, y: 1200, w: 1600, h: 740 },
  approval: { x: 960, y: 1570, w: 880, h: 400 },
} as const

/** The end card in screen space: the wordmark's centre and dot pitch (the orbit's dots fly here), and the mark beside it. */
export const END = { x: 1068, y: 372, pitch: 18, logo: { x: 499, size: 176 } }

/* ------------------------------------------------------------------ camera */

type CamKey = { f: number; x?: number; y?: number; s?: number; rz?: number; rx?: number; ry?: number; ease?: (t: number) => number }

const CAMERA: CamKey[] = [
  { f: 0, x: 960, y: 540, s: 0.9, rz: -1.6, rx: 4, ry: 0 },
  { f: 300, s: 1.0, rz: 0, rx: 0, ease: EASES.out },
  { f: 345, s: 0.965, ease: EASES.inOut },
  { f: 405, s: 1.06, ease: EASES.in },
  { f: 470, s: 1.0, ease: EASES.out },
  { f: 760, s: 1.035, ease: EASES.inOut },
  { f: 870, x: 1290, y: 545, s: 0.66, ease: EASES.inOut },
  { f: 960, x: 1320, y: 545, s: 0.68, ease: EASES.out },
  { f: 1030, x: 2400, y: 560, s: 1.0, ease: EASES.inOut },
  { f: 1112, x: 2398, y: 566, s: 1.04, ease: EASES.out },
  { f: 1215, x: 1120, y: 420, s: 0.95, ease: EASES.inOut },
  { f: 1390, x: 1110, y: 452, s: 0.98, ease: EASES.out },
  { f: 1480, x: 960, y: 556, s: 1.0, ease: EASES.inOut },
  { f: 1545, x: 960, y: 556, s: 1.01, ease: EASES.out },
  { f: 1605, x: 400, y: 510, s: 1.15, ease: EASES.inOut },
  { f: 1765, x: 422, y: 507, s: 1.17, ease: EASES.out },
  { f: 1820, x: 960, y: 510, s: 1.15, ease: EASES.inOut },
  { f: 1965, x: 978, y: 507, s: 1.17, ease: EASES.out },
  { f: 2020, x: 1520, y: 510, s: 1.15, ease: EASES.inOut },
  { f: 2160, x: 1536, y: 507, s: 1.17, ease: EASES.out },
  { f: 2208, x: 960, y: 566, s: 0.97, ease: EASES.inOut },
  { f: 2255, x: 960, y: 568, s: 0.985, ease: EASES.out },
  { f: 2395, x: 960, y: 1570, s: 1.0, ease: EASES.inOut },
  { f: 2645, x: 960, y: 1570, s: 1.03, ease: EASES.out },
  { f: 3010, x: 960, y: 1570, s: 1.09, ease: EASES.inOut },
  { f: 3080, x: 960, y: 1570, s: 0.74, ease: EASES.in },
]

const PROPS = ['x', 'y', 's', 'rz', 'rx', 'ry'] as const

/** Each property's keys, carrying values forward where a key leaves them out. */
const TRACKS = (() => {
  const out = {} as Record<(typeof PROPS)[number], Key[]>
  for (const p of PROPS) {
    let last = CAMERA[0]?.[p] ?? 0
    out[p] = CAMERA.map((k) => {
      last = k[p] ?? last
      return { f: k.f, v: last, ease: k.ease }
    })
  }
  return out
})()

/** The camera at a frame: its path, a breath of handheld drift, and the shake when the stamp lands. */
export function cameraAt(frame: number): CameraState {
  const shake = frame >= BEAT.stamp ? Math.exp(-(frame - BEAT.stamp) / 7) * 9 : 0
  return {
    x: track(frame, TRACKS.x) + noise(frame * 0.011, 1) * 3 + noise(frame * 0.9, 11) * shake,
    y: track(frame, TRACKS.y) + noise(frame * 0.009, 2) * 2 + noise(frame * 0.9, 12) * shake,
    s: track(frame, TRACKS.s),
    rz: track(frame, TRACKS.rz) + noise(frame * 0.007, 3) * 0.12,
    rx: track(frame, TRACKS.rx),
    ry: track(frame, TRACKS.ry),
  }
}

/** The world fades into depth as the call comes in (beat 6 → 7). */
export function worldFade(frame: number): { opacity: number; blur: number } {
  const t = tween(frame, BEAT.recede, BEAT.recede + 62, 0, 1, EASES.in)
  return { opacity: 1 - t, blur: t * 10 }
}

/* ------------------------------------------------------------------ light */

const GLOW: { f: number; x: number; y: number; strength: number; size: number }[] = [
  { f: 0, x: 960, y: 540, strength: 0.3, size: 700 },
  { f: 300, x: 960, y: 560, strength: 0.6, size: 1200 },
  { f: 410, x: 960, y: 620, strength: 1.4, size: 1100 },
  { f: 700, x: 960, y: 420, strength: 1.2, size: 1300 },
  { f: 960, x: 1500, y: 540, strength: 0.8, size: 1400 },
  { f: 1110, x: 960, y: 560, strength: 0.9, size: 1100 },
  { f: 1400, x: 900, y: 500, strength: 0.8, size: 1300 },
  { f: 1600, x: 700, y: 520, strength: 1.0, size: 1200 },
  { f: 2100, x: 1200, y: 520, strength: 1.0, size: 1200 },
  { f: 2485, x: 700, y: 560, strength: 0.8, size: 1400 },
  { f: 2785, x: 960, y: 560, strength: 1.1, size: 1100 },
  { f: 3085, x: 960, y: 600, strength: 1.2, size: 1000 },
  { f: 3710, x: 960, y: 610, strength: 1.2, size: 1300 },
  { f: 4110, x: 960, y: 420, strength: 1.4, size: 1400 },
]

/** The amber pool of light behind the action, breathing slowly. */
export function glowAt(frame: number) {
  const k = (p: 'x' | 'y' | 'strength' | 'size') => track(frame, GLOW.map((g) => ({ f: g.f, v: g[p] })))
  return { x: k('x'), y: k('y'), strength: k('strength') * (0.9 + 0.1 * Math.sin(frame / 34)), size: k('size') }
}

/* ------------------------------------------------------------------ captions */

/** The film's lines: seven words at most, each held at least 1.6 s. `start` is the first word in, `end` the exit. */
export const CAPTIONS: { text: string; start: number; end: number; stagger?: number }[] = [
  { text: 'Ten tools. Ten tabs. *Zero teamwork.*', start: 110, end: 290 },
  { text: 'Ask from your *phone.*', start: 850, end: 955 },
  { text: 'A lead *plans* the work.', start: 1268, end: 1390 },
  { text: 'And hires a *crew.*', start: 1436, end: 1536 },
  { text: 'Slice the data. *Find the break.*', start: 1590, end: 1688 },
  { text: 'Reproduce it, *on your Mac.*', start: 1800, end: 1898 },
  { text: 'Debug it. Fix it. *Prove it.*', start: 2026, end: 2145 },
  { text: "They check each *other's work.*", start: 2400, end: 2505 },
  { text: 'Sandboxed. Logged. *Yours.*', start: 2697, end: 2970, stagger: 90 },
  { text: 'Then it *calls you back.*', start: 3077, end: 3255 },
  { text: 'Reach it from *30 apps.*', start: 3702, end: 3858 },
  { text: 'Any model. *Subscriptions you already have.*', start: 3886, end: 4010 },
]
