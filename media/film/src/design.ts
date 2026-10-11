import type { CSSProperties } from 'react'
import { C, FONT, MONO } from './theme.ts'

/**
 * The film's one design system. Every size, weight, gap, corner, border and shadow on screen comes from here, so a
 * panel in the first shot and a panel in the last are the same object. Colours are `C` in theme.ts (the app's dark
 * tokens); fonts are Geist and Geist Mono only.
 */

/** Weights: Geist ships variable, but the film uses four stops so the type never drifts between shots. */
export const WEIGHT = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const

/**
 * The type scale. Seven sizes, nothing in between: display for the end card, caption for the film's lines, title and
 * heading for UI headings, body for UI text, label for metadata, mono for code and terminals. Any face may use any
 * size; the role says which.
 */
export const TYPE = {
  display: { fontSize: 88, fontWeight: WEIGHT.bold, letterSpacing: '-0.045em', lineHeight: 1.02, fontFamily: FONT },
  caption: { fontSize: 64, fontWeight: WEIGHT.semibold, letterSpacing: '-0.035em', lineHeight: 1.1, fontFamily: FONT },
  title: { fontSize: 38, fontWeight: WEIGHT.semibold, letterSpacing: '-0.025em', lineHeight: 1.15, fontFamily: FONT },
  heading: { fontSize: 28, fontWeight: WEIGHT.semibold, letterSpacing: '-0.015em', lineHeight: 1.2, fontFamily: FONT },
  body: { fontSize: 22, fontWeight: WEIGHT.regular, letterSpacing: '-0.005em', lineHeight: 1.4, fontFamily: FONT },
  label: { fontSize: 16, fontWeight: WEIGHT.medium, letterSpacing: '0em', lineHeight: 1.25, fontFamily: FONT },
  mono: { fontSize: 18, fontWeight: WEIGHT.regular, letterSpacing: '0em', lineHeight: 1.6, fontFamily: MONO },
} as const satisfies Record<string, CSSProperties & { fontSize: number; fontFamily: string }>
export type TypeRole = keyof typeof TYPE

/** Spacing: every padding, gap and margin is one of these. */
export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const

/** Corners, from the app's radius scale (styles.css @theme). */
export const RADIUS = { sm: 6, md: 10, lg: 14, xl: 22, pill: 999 } as const

/** Borders are always a 1 px hairline, drawn as an inset shadow so they never change a box's size. */
export const BORDER = {
  hair: `inset 0 0 0 1px ${C.separator}`,
  strong: `inset 0 0 0 1px ${C.separatorStrong}`,
  accent: `inset 0 0 0 1px ${C.accent}`,
} as const

/** Shadows: a lift for chips, a float for cards, a deep drop for windows and panels. */
export const SHADOW = {
  sm: '0 2px 6px -2px rgba(0,0,0,0.6)',
  md: '0 18px 40px -18px rgba(0,0,0,0.85)',
  lg: '0 50px 110px -30px rgba(0,0,0,0.95), 0 20px 40px -20px rgba(0,0,0,0.8)',
} as const

/** The raised material every panel, card, window and sheet is made of. */
export const SURFACE = {
  panel: 'linear-gradient(180deg, #16161a 0%, #111114 100%)',
  card: 'linear-gradient(180deg, #1b1b20 0%, #16161a 100%)',
  inset: '#0c0c0f',
  rim: 'inset 0 1px 0 rgba(255,255,255,0.05)',
} as const

/** Title-safe area (5% of each side) and the band captions own. */
export const SAFE = { x: 96, top: 54, captionBottom: 150, uiTop: 170 } as const
