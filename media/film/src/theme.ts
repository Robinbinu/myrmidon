/**
 * The film's palette and type, taken from the app's dark tokens (apps/web/src/client/tokens.css) and agent identities
 * (packages/protocol/src/identity.ts), so every frame reads as Myrmidon.
 */
export const C = {
  black: '#050506',
  window: '#0b0b0e',
  content: '#111114',
  raised: '#18181c',
  control: '#232328',
  fill: '#17171b',
  fillStrong: '#222228',
  separator: 'rgba(255,255,255,0.08)',
  separatorStrong: 'rgba(255,255,255,0.16)',
  label: '#f4f4f6',
  label2: '#c8c8d0',
  label3: '#9a9aa5',
  label4: '#5c5c66',
  accent: '#ffb31a',
  accentSoft: 'rgba(255,179,26,0.14)',
  onAccent: '#1a1204',
  bubble: '#2a2a31',
  wink: '#ffcf5c',
  ok: '#3ddc84',
  okSoft: 'rgba(61,220,132,0.11)',
  warn: '#ff8a4c',
  warnSoft: 'rgba(255,138,76,0.12)',
  badSoft: 'rgba(255,99,105,0.11)',
  sidebar: '#0d0d10',
  bad: '#ff6369',
  add: '#0f2a1d',
  del: '#351719',
  screen: '#050506',
  screenCell: 'rgba(255,255,255,0.05)',
  screenInk: '#88888b',
  judge: '#d4ff3a',
  user: '#e8e8ec',
  ink: '#16161a',
  eyeTop: '#ffcb6b',
  eyeBottom: '#ff9a12',
  eyeLight: '#ffe2a3',
  glow: '#ffa41c',
  terminal: '#0b0b0d',
  termText: '#d7d7de',
  termGreen: '#9be37a',
  termMuted: '#7a7a86',
} as const

/** The crew: call sign, role, model, and the colour and body their identity gives them in the app. */
export const CREW = {
  nova: { name: 'nova', role: 'researcher', model: 'Claude', color: '#ff7eb6', form: 'gumdrop' },
  quill: { name: 'quill', role: 'coder', model: 'GPT', color: '#f25c8a', form: 'flower' },
  iris: { name: 'iris', role: 'designer', model: 'Gemini', color: '#4d7cff', form: 'ball' },
} as const
export type CrewName = keyof typeof CREW

/** The crew as the film casts them: the incident gives each the job it does there (the posters keep CREW's). */
export const CAST = {
  nova: { ...CREW.nova, role: 'analyst' },
  quill: { ...CREW.quill, role: 'engineer' },
  iris: { ...CREW.iris, role: 'tester' },
} as const satisfies Record<CrewName, { role: string }>

export const FONT = '"Geist Variable", "Geist", -apple-system, system-ui, sans-serif'
export const MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace'

export const W = 1920
export const H = 1080
export const FPS = 60
