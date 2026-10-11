import { Mail } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Easing } from 'remotion'
import { clamp, lerp } from '../anim.ts'
import { BORDER, RADIUS, SHADOW, SPACE, SURFACE } from '../design.ts'
import { C, CAST, CREW, type CrewName, FPS } from '../theme.ts'
import { ModelMark } from './Brand.tsx'
import { type Status, StatusPill } from './Surface.tsx'
import { T } from './Text.tsx'

/** Dark or light text on a fill, whichever has more contrast (the app's inkOn). */
export function inkOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const ch = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * ch(((n >> 16) & 255) / 255) + 0.7152 * ch(((n >> 8) & 255) / 255) + 0.0722 * ch((n & 255) / 255)
  return (lum + 0.05) / 0.0534 > 1.05 / (lum + 0.05) ? '#0b0b0d' : '#ffffff'
}

const BODIES = {
  gumdrop: {
    draw: (fill: string) => (
      <path d="M50 8C57 8 62 14 67 24L87 66C93 80 86 93 70 93H30C14 93 7 80 13 66L33 24C38 14 43 8 50 8Z" fill={fill} />
    ),
    eyeY: 60,
  },
  ball: { draw: (fill: string) => <circle cx="50" cy="54" r="40" fill={fill} />, eyeY: 50 },
  flower: {
    draw: (fill: string) => (
      <g fill={fill}>
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <circle key={a} cx={50 + 24 * Math.cos((a * Math.PI) / 180)} cy={54 + 24 * Math.sin((a * Math.PI) / 180)} r="17" />
        ))}
        <circle cx="50" cy="54" r="27" />
      </g>
    ),
    eyeY: 53,
  },
} as const

/** A worker's character (the app's AgentCharacter): its body in its colour, with ink capsule eyes. */
export function Crewmate(props: { who: CrewName; size: number; blink?: boolean; happy?: boolean; style?: CSSProperties }) {
  const c = CREW[props.who]
  const body = BODIES[c.form]
  const xs = [40, 60]
  const h = props.blink ? 2 : 12
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 100 100" style={{ display: 'block', overflow: 'visible', flexShrink: 0, ...props.style }}>
      {body.draw(c.color)}
      {props.happy ? (
        <g fill="none" stroke={C.ink} strokeWidth="4" strokeLinecap="round">
          {xs.map((x) => (
            <path key={x} d={`M${x - 5} ${body.eyeY + 2}Q${x} ${body.eyeY - 5} ${x + 5} ${body.eyeY + 2}`} />
          ))}
        </g>
      ) : (
        <g fill={C.ink}>
          {xs.map((x) => (
            <rect key={x} x={x - 3.5} y={body.eyeY - h / 2} width="7" height={h} rx="3.5" />
          ))}
        </g>
      )}
    </svg>
  )
}

/** A blink every few seconds, staggered per crewmate. */
export const blinking = (f: number, seed: number) => (f + seed * 37) % 170 < 6

/* ------------------------------------------------------------------ cursors */

/** A waypoint of a cursor's trip: be at (x, y) by frame f; `click` presses there. */
export interface Stop {
  f: number
  x: number
  y: number
  click?: boolean
}

/** The app's cursor ease (ui/cursor.tsx): a virtual hand that starts gently and lands softly. */
const HAND = Easing.bezier(0.45, 0, 0.2, 1)
const TIP_HEADING = -135
const START_TILT = -14

function at(frame: number, stops: readonly Stop[]): { x: number; y: number } {
  const first = stops[0]
  if (!first) throw new Error('a cursor needs a stop')
  if (frame <= first.f) return first
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1] as Stop
    const b = stops[i] as Stop
    if (frame > b.f) continue
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    if (dist < 1) return b
    // Each trip bows to the other side from the last, like the app's virtual hand.
    const bow = dist * 0.22 * (i % 2 ? 1 : -1)
    const cx = (a.x + b.x) / 2 + (-(b.y - a.y) / dist) * bow
    const cy = (a.y + b.y) / 2 + ((b.x - a.x) / dist) * bow
    const trip = Math.min(b.f - a.f, Math.round(clamp(0.55 + dist / 520, 0.6, 1.6) * FPS))
    const t = HAND(clamp((frame - (b.f - trip)) / trip, 0, 1))
    const u = 1 - t
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y }
  }
  return stops[stops.length - 1] as Stop
}

/**
 * A crew cursor along its stops, as the app draws one: the arrow turns to point where it is going, the name tag
 * trails a few frames behind and swings by how far it lags, and a ring spreads where it clicks.
 */
export function CrewCursor(props: { name: string; color: string; frame: number; stops: readonly Stop[]; opacity?: number }) {
  const f = props.frame
  const p = at(f, props.stops)
  const prev = at(f - 1, props.stops)
  const lag = at(f - 5, props.stops)
  const vx = (p.x - prev.x) * FPS
  const vy = (p.y - prev.y) * FPS
  const weight = clamp(Math.hypot(vx, vy) / 1400, 0, 1)
  const pointing = (Math.atan2(vy, vx) * 180) / Math.PI - TIP_HEADING
  const turn = ((((pointing - START_TILT) % 360) + 540) % 360) - 180
  const rotate = START_TILT + turn * weight
  const swing = clamp(-(lag.x - p.x) * 0.11, -8, 8)
  const click = props.stops.filter((s) => s.click).map((s) => f - s.f).find((d) => d >= 0 && d < 24)
  const press = click === undefined ? 0 : Math.max(0, 1 - Math.abs(click - 3) / 6)
  const ink = inkOn(props.color)
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, opacity: props.opacity ?? 1, zIndex: 50 }}>
      {click !== undefined && (
        <span
          style={{
            position: 'absolute',
            left: p.x - 20,
            top: p.y - 20,
            width: 40,
            height: 40,
            borderRadius: RADIUS.pill,
            boxShadow: `inset 0 0 0 3px ${props.color}`,
            transform: `scale(${lerp(0.2, 1.8, click / 24)})`,
            opacity: 0.9 * (1 - click / 24),
          }}
        />
      )}
      <svg
        width={34}
        height={34}
        viewBox="0 0 24 24"
        style={{
          position: 'absolute',
          left: p.x - 4,
          top: p.y - 3.5,
          transform: `rotate(${rotate}deg) scale(${1 - press * 0.08})`,
          transformOrigin: `${(3 / 24) * 100}% ${(2.5 / 24) * 100}%`,
          filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.55))',
        }}
      >
        <path
          d="M3.6 2.4c-.8-.3-1.5.4-1.2 1.2l6.5 16.6c.3.8 1.4.8 1.7 0l2.6-6.6 6.6-2.6c.8-.3.8-1.4 0-1.7L3.6 2.4Z"
          fill={props.color}
          stroke="rgba(0,0,0,0.22)"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
      <div
        data-cover={`cursor-${props.name}`}
        style={{
          position: 'absolute',
          left: lag.x + 30,
          top: lag.y + 18,
          padding: `${SPACE[1] + 1}px ${SPACE[3]}px`,
          borderRadius: RADIUS.pill,
          background: props.color,
          boxShadow: SHADOW.sm,
          display: 'flex',
          transform: `rotate(${swing}deg)`,
          transformOrigin: '0 50%',
        }}
      >
        <T role="label" color={ink}>
          {props.name}
        </T>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ mail */

/** A message one crewmate sends another, as the app's Mail view shows it: who to whom, and what. */
export function MailCard(props: { from: CrewName; to: CrewName; text: string; width: number; style?: CSSProperties }) {
  const inner = props.width - SPACE[4] * 2
  return (
    <div
      data-box=""
      style={{
        width: props.width,
        padding: `${SPACE[3]}px ${SPACE[4]}px`,
        boxSizing: 'border-box',
        borderRadius: RADIUS.lg,
        background: SURFACE.card,
        boxShadow: `${BORDER.hair}, ${SHADOW.md}`,
        display: 'flex',
        flexDirection: 'column',
        gap: SPACE[1],
        ...props.style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
        <Crewmate who={props.from} size={22} />
        <T role="label" weight="semibold" color={CREW[props.from].color}>
          {props.from}
        </T>
        <T role="label" color={C.label3}>
          {`→ ${props.to}`}
        </T>
      </div>
      <T role="body" wrap style={{ display: 'block', width: inner }}>
        {props.text}
      </T>
    </div>
  )
}

/** The same message on one line, as it passes along the mail lane. `cover` names it for the overlap check. */
export function MailPill(props: { from: CrewName; to: CrewName; text: string; cover: string }) {
  return (
    <div
      data-box=""
      data-cover={props.cover}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SPACE[3],
        height: 64,
        padding: `0 ${SPACE[6]}px 0 ${SPACE[4]}px`,
        borderRadius: RADIUS.pill,
        background: SURFACE.card,
        boxShadow: `inset 0 0 0 1px ${CREW[props.from].color}66, ${SHADOW.md}, 0 0 40px -10px ${CREW[props.from].color}66`,
      }}
    >
      <Mail size={22} strokeWidth={2} color={CREW[props.from].color} />
      <Crewmate who={props.from} size={30} />
      <T role="body" weight="semibold" color={CREW[props.from].color}>
        {props.from}
      </T>
      <T role="body" color={C.label3}>
        {`→ ${props.to}`}
      </T>
      <T role="body">{props.text}</T>
    </div>
  )
}

/* ------------------------------------------------------------------ tasks */

export const TASKS: Record<CrewName, { id: string; subject: string }> = {
  nova: { id: 'task-1', subject: 'Find where checkout broke' },
  iris: { id: 'task-2', subject: 'Reproduce it on mobile' },
  quill: { id: 'task-3', subject: 'Fix it, with a regression test' },
}

export const TASK_CARD_H = 120

/**
 * A card on the crew's task board, as the app draws one: the task's id, its subject and who has it. The same card is a
 * line of the lead's plan, the header of the agent's panel and the card on the board, so it carries the eye between
 * all three.
 */
export function TaskCard(props: {
  who: CrewName
  width: number
  status: Status
  frame: number
  /** 0..1: the agent's colour lighting the card's top edge while it works. */
  live?: number
  happy?: boolean
  /** Messages from crewmates waiting for this agent. */
  mail?: number
  style?: CSSProperties
}) {
  const c = CREW[props.who]
  const task = TASKS[props.who]
  const live = props.live ?? 0
  const inner = props.width - SPACE[4] * 2
  return (
    <div
      data-box=""
      style={{
        position: 'relative',
        width: props.width,
        height: TASK_CARD_H,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: `${SPACE[3]}px ${SPACE[4]}px`,
        boxSizing: 'border-box',
        borderRadius: RADIUS.lg,
        background: SURFACE.card,
        boxShadow: `${BORDER.hair}, inset 0 2px 0 ${c.color}${Math.round(live * 220)
          .toString(16)
          .padStart(2, '0')}, ${SHADOW.md}`,
        ...props.style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', height: 28 }}>
        <T role="label" mono color={C.label3}>
          {task.id}
        </T>
        {(props.mail ?? 0) > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: SPACE[1],
              marginLeft: SPACE[3],
              padding: `0 ${SPACE[2]}px`,
              height: 24,
              borderRadius: RADIUS.pill,
              background: C.accentSoft,
              color: C.accent,
            }}
          >
            <Mail size={14} strokeWidth={2} />
            <T role="label" color={C.accent} weight="semibold">
              {String(props.mail)}
            </T>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <StatusPill status={props.status} />
      </div>
      <T role="body" weight="medium" fit={inner}>
        {task.subject}
      </T>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], height: 24 }}>
        <Crewmate who={props.who} size={24} blink={blinking(props.frame, props.who.length)} happy={props.happy} />
        <T role="label" color={C.label2}>
          {c.name}
        </T>
        <T role="label" color={C.label3}>
          {`· ${CAST[props.who].role} ·`}
        </T>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: SPACE[1], color: C.label2 }}>
          <ModelMark model={c.model} size={20} />
          <T role="label" color={C.label3}>
            {c.model}
          </T>
        </span>
      </div>
    </div>
  )
}
