import type { LucideIcon } from 'lucide-react'
import { ChevronDown, Circle } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { BORDER, RADIUS, SHADOW, SPACE, SURFACE } from '../design.ts'
import { C } from '../theme.ts'
import { T } from './Text.tsx'

/** Icons are the app's own (lucide-react, the version apps/web pins), at the film's two sizes. */
export const ICON = { sm: 18, md: 24 } as const
export const STROKE = 1.8

/**
 * The film's one material: every panel, card, window and sheet is a Surface, so they share a fill, a hairline and a
 * shadow. `tint` swaps the hairline for a coloured one (an agent's colour, the composer's amber focus ring).
 */
export function Surface(props: {
  width?: number
  height?: number
  radius?: keyof typeof RADIUS
  level?: 'panel' | 'card'
  tint?: string
  fill?: string
  glow?: number
  children?: ReactNode
  style?: CSSProperties
}) {
  const tint = props.tint
  const glow = props.glow ?? 0
  return (
    <div
      data-box=""
      style={{
        position: 'relative',
        width: props.width,
        height: props.height,
        borderRadius: RADIUS[props.radius ?? 'xl'],
        background: props.fill ?? SURFACE[props.level ?? 'panel'],
        boxShadow: [
          tint ? `inset 0 0 0 1px ${tint}` : BORDER.hair,
          SURFACE.rim,
          props.level === 'card' ? SHADOW.md : SHADOW.lg,
          glow > 0 && tint ? `0 0 ${60 * glow}px ${tint}` : null,
        ]
          .filter(Boolean)
          .join(', '),
        overflow: 'hidden',
        ...props.style,
      }}
    >
      {props.children}
    </div>
  )
}

/** The three traffic lights of a macOS window. */
export function Lights() {
  return (
    <div style={{ display: 'flex', gap: SPACE[2], flexShrink: 0 }}>
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
        <span key={c} style={{ width: 12, height: 12, borderRadius: RADIUS.pill, background: c, opacity: 0.9 }} />
      ))}
    </div>
  )
}

/** A macOS window: a Surface with a title bar. */
export function Window(props: {
  width: number
  height: number
  title?: ReactNode
  right?: ReactNode
  children?: ReactNode
  tint?: string
  style?: CSSProperties
  bar?: number
}) {
  const bar = props.bar ?? 48
  return (
    <Surface width={props.width} height={props.height} radius="lg" tint={props.tint} style={props.style}>
      <div
        style={{
          height: bar,
          display: 'flex',
          alignItems: 'center',
          gap: SPACE[4],
          padding: `0 ${SPACE[4]}px`,
          boxShadow: `inset 0 -1px 0 ${C.separator}`,
          background: C.window,
        }}
      >
        <Lights />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0 }}>{props.title}</div>
        {props.right}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: bar, bottom: 0, overflow: 'hidden' }}>
        {props.children}
      </div>
    </Surface>
  )
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'work' | 'warn' | 'bad'

const TONES: Record<Tone, { fg: string; bg: string; ring: string }> = {
  neutral: { fg: C.label2, bg: C.fill, ring: C.separatorStrong },
  accent: { fg: C.onAccent, bg: C.accent, ring: 'transparent' },
  ok: { fg: C.ok, bg: C.okSoft, ring: 'transparent' },
  work: { fg: C.accent, bg: C.accentSoft, ring: 'transparent' },
  warn: { fg: C.warn, bg: C.warnSoft, ring: 'rgba(255,138,76,0.4)' },
  bad: { fg: C.bad, bg: C.badSoft, ring: 'rgba(255,99,105,0.4)' },
}

/**
 * A chip: the composer's controls (model, crew, folder, mode), a tool, a channel. Label type, mono for paths and
 * names; `menu` adds the pop-up chevron the app's chips carry. `big` is the film-scale chip of the reach beat.
 */
export function Chip(props: {
  children: string
  tone?: Tone
  icon?: LucideIcon
  /** A brand mark (a model maker's or a channel's logo) in place of the icon. */
  mark?: ReactNode
  trail?: LucideIcon
  dot?: string
  mono?: boolean
  menu?: boolean
  big?: boolean
  style?: CSSProperties
}) {
  const tone = TONES[props.tone ?? 'neutral']
  const h = props.big ? 56 : 36
  const iconSize = props.big ? ICON.md : ICON.sm
  return (
    <span
      data-box=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: props.big ? SPACE[3] : SPACE[2],
        height: h,
        padding: `0 ${props.big ? SPACE[6] : SPACE[3]}px`,
        borderRadius: props.big ? RADIUS.pill : RADIUS.md,
        background: tone.bg,
        boxShadow: `inset 0 0 0 1px ${tone.ring}${props.big ? `, ${SHADOW.md}` : ''}`,
        color: tone.fg,
        flexShrink: 0,
        ...props.style,
      }}
    >
      {props.dot && (
        <span
          style={{
            width: props.big ? 12 : 8,
            height: props.big ? 12 : 8,
            borderRadius: RADIUS.pill,
            background: props.dot,
            boxShadow: `0 0 10px ${props.dot}`,
          }}
        />
      )}
      {props.mark}
      {props.icon && <props.icon size={iconSize} strokeWidth={STROKE} />}
      <T role={props.big ? 'heading' : 'label'} mono={props.mono} color={tone.fg} weight={props.big ? 'semibold' : 'medium'}>
        {props.children}
      </T>
      {props.trail && <props.trail size={iconSize} strokeWidth={STROKE} style={{ opacity: 0.8 }} />}
      {props.menu && <ChevronDown size={16} strokeWidth={2} style={{ opacity: 0.6, marginLeft: -2 }} />}
    </span>
  )
}

export type Status = 'queued' | 'working' | 'review' | 'done' | 'failed'
const STATUS: Record<Status, { label: string; tone: Tone }> = {
  queued: { label: 'waiting', tone: 'neutral' },
  working: { label: 'working', tone: 'work' },
  review: { label: 'in review', tone: 'warn' },
  done: { label: 'done', tone: 'ok' },
  failed: { label: 'failed', tone: 'bad' },
}

/** The app's status pill: "working" in amber, "done" in green with its ring, as beside a chat's title. */
export function StatusPill(props: { status: Status }) {
  const s = STATUS[props.status]
  const tone = TONES[s.tone]
  return (
    <span
      data-box=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: SPACE[1] + 2,
        height: 28,
        padding: `0 ${SPACE[2] + 2}px`,
        borderRadius: props.status === 'done' ? RADIUS.pill : RADIUS.sm,
        background: tone.bg,
        color: tone.fg,
        flexShrink: 0,
      }}
    >
      {props.status === 'done' && <Circle size={12} strokeWidth={2.4} />}
      <T role="label" color={tone.fg}>
        {s.label}
      </T>
    </span>
  )
}

/** A mono section label in caps with wide tracking, as the app sets its lanes and panel headings ("PLAN · LEAD"). */
export function SectionLabel(props: { children: string; color?: string; dot?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: SPACE[2] }}>
      {props.dot && <span style={{ width: 10, height: 10, borderRadius: RADIUS.pill, background: props.dot }} />}
      <T role="label" mono color={props.color ?? C.label3} style={{ textTransform: 'uppercase', letterSpacing: '0.14em' }}>
        {props.children}
      </T>
    </span>
  )
}

/** A button: amber for the one to press, borderless for the other. */
export function Button(props: {
  children: string
  primary?: boolean
  icon?: LucideIcon
  hover?: number
  press?: number
  style?: CSSProperties
}) {
  const hover = props.hover ?? 0
  const press = props.press ?? 0
  return (
    <span
      data-box=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACE[2],
        height: 52,
        padding: `0 ${SPACE[6]}px`,
        borderRadius: RADIUS.md,
        background: props.primary ? C.accent : 'transparent',
        boxShadow: props.primary
          ? `0 0 0 ${hover * 6}px rgba(255,179,26,0.2), 0 12px 30px -12px rgba(255,179,26,${0.4 + hover * 0.4})`
          : undefined,
        transform: `scale(${1 + hover * 0.03 - press * 0.06})`,
        color: props.primary ? C.onAccent : C.label2,
        ...props.style,
      }}
    >
      {props.icon && <props.icon size={ICON.sm} strokeWidth={2.2} />}
      <T role="body" weight="semibold" color={props.primary ? C.onAccent : C.label2}>
        {props.children}
      </T>
    </span>
  )
}
