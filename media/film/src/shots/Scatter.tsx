import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { clamp, drift, EASES, lerp, quad, rand, sp, SPRING, tween } from '../anim.ts'
import { MotionBlur } from '../components/World.tsx'
import { RADIUS, SPACE } from '../design.ts'
import { Calendar, Code, Globe, Layers, type LucideIcon, MessageSquare, Mic, NotebookPen, Search, Terminal, Workflow } from 'lucide-react'
import { Surface } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { BEAT, WORLD } from '../timeline.ts'
import { C } from '../theme.ts'

/** Ten separate AI tools, each busy with its own small failure. Generic names: no product is meant. */
const TOOLS: { name: string; status: string; icon: LucideIcon; x: number; y: number; z: number; rot: number }[] = [
  { name: 'Chat assistant', status: 'new chat, context lost', icon: MessageSquare, x: 380, y: 290, z: -260, rot: -4 },
  { name: 'Code helper', status: 'paste the error again', icon: Code, x: 1540, y: 280, z: -180, rot: 3 },
  { name: 'Research agent', status: '14 tabs open', icon: Search, x: 280, y: 590, z: 40, rot: 2.5 },
  { name: 'Browser agent', status: 'waiting for login', icon: Globe, x: 1650, y: 620, z: -60, rot: -3 },
  { name: 'Terminal AI', status: 'permission denied', icon: Terminal, x: 520, y: 880, z: -120, rot: 3 },
  { name: 'Design copilot', status: 'export failed', icon: Layers, x: 1420, y: 890, z: 20, rot: -2 },
  { name: 'Voice assistant', status: "didn't catch that", icon: Mic, x: 760, y: 330, z: -620, rot: 1.5 },
  { name: 'Automations', status: '4 runs failed', icon: Workflow, x: 1190, y: 330, z: -520, rot: -2 },
  { name: 'Meeting notes', status: 'summary pending', icon: NotebookPen, x: 790, y: 790, z: -480, rot: -1 },
  { name: 'Scheduler', status: '3 reminders missed', icon: Calendar, x: 1170, y: 790, z: -700, rot: 2 },
]

const CARD = { w: 380, h: 124 }
const IN = 40
const STAGGER = 9
/** The order the cards fly in: the far ones first, so the near ones sweep across them. */
const ORDER = TOOLS.map((t, i) => ({ i, z: t.z })).sort((a, b) => a.z - b.z).map((o) => o.i)

function ToolCard(props: { i: number; frame: number; alarm: number }) {
  const t = TOOLS[props.i]
  if (!t) return null
  const f = props.frame
  const spin = (f * 6 + props.i * 40) % 360
  const badge = Math.min(9, Math.floor(clamp((f - IN - props.i * 14) / 26, 0, 99)))
  return (
    <Surface width={CARD.w} height={CARD.h} radius="lg" level="card" tint={props.alarm > 0.5 ? 'rgba(255,99,105,0.45)' : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[4], padding: SPACE[6], height: '100%', boxSizing: 'border-box' }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: RADIUS.md,
            display: 'grid',
            placeItems: 'center',
            background: C.fillStrong,
            color: C.label2,
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <t.icon size={28} strokeWidth={1.8} />
          {badge > 0 && (
            <span
              style={{
                position: 'absolute',
                right: -8,
                top: -8,
                width: 26,
                height: 26,
                borderRadius: RADIUS.pill,
                background: C.bad,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <T role="label" weight="bold" color="#fff" deco>
                {String(badge)}
              </T>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE[1], minWidth: 0, flex: 1 }}>
          <T role="body" weight="semibold" fit={250}>
            {t.name}
          </T>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
            <svg width={14} height={14} viewBox="0 0 14 14" style={{ transform: `rotate(${spin}deg)`, flexShrink: 0 }}>
              <circle cx="7" cy="7" r="5.5" fill="none" stroke={C.label4} strokeWidth="2" />
              <path d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke={props.alarm > 0.5 ? C.bad : C.accent} strokeWidth="2" strokeLinecap="round" />
            </svg>
            <T role="label" mono color={props.alarm > 0.5 ? C.bad : C.label3} fit={226}>
              {t.status}
            </T>
          </div>
        </div>
      </div>
    </Surface>
  )
}

/** Where card `i` is at a frame: arriving from depth, idling, flinching outward, then thrown into the composer. */
function cardState(i: number, f: number) {
  const t = TOOLS[i] as (typeof TOOLS)[number]
  const k = ORDER.indexOf(i)
  const arrive = sp(f, IN + k * STAGGER, SPRING.smooth)
  const jitter = tween(f, 220, BEAT.collapse + 30) * 3.2
  const dx = drift(f, i * 3 + 1, 10) + jitter * Math.sin(f * 1.7 + i)
  const dy = drift(f, i * 3 + 2, 8) + jitter * Math.cos(f * 1.9 + i * 2)
  // The wind-up: everything leans away from the centre, then is pulled in.
  const windup = tween(f, BEAT.collapse, BEAT.collapse + 45, 0, 1, EASES.out)
  const throwStart = BEAT.collapse + 45 + k * 3
  const fly = tween(f, throwStart, throwStart + 42, 0, 1, EASES.in)
  const away = [t.x - 960, t.y - 560]
  const len = Math.hypot(away[0] ?? 0, away[1] ?? 0) || 1
  const lean = windup * (1 - fly) * 26
  const sx = t.x + dx + ((away[0] ?? 0) / len) * lean
  const sy = t.y + dy + ((away[1] ?? 0) / len) * lean
  const target: [number, number] = [WORLD.composer.free.x, WORLD.composer.free.y]
  const control: [number, number] = [lerp(sx, target[0], 0.5) + (rand(i) - 0.5) * 300, lerp(sy, target[1], 0.5) - 160]
  const [x, y] = quad(fly, [sx, sy], control, target)
  return {
    x,
    y,
    z: lerp(lerp(-1400, t.z, arrive), 0, fly),
    rot: lerp(t.rot + drift(f, i * 3 + 3, 1.2), (rand(i + 7) - 0.5) * 30, fly),
    scale: lerp(1.15 + windup * 0.04, 0.22, fly),
    opacity: clamp(arrive * 1.4, 0, 1) * (1 - tween(f, throwStart + 30, throwStart + 42)),
    blur: Math.max(0, -t.z / 120) * (1 - fly) + (1 - arrive) * 14,
    flying: fly > 0 && fly < 1,
  }
}

function Card(props: { i: number; f: number }) {
  const s = cardState(props.i, props.f)
  if (s.opacity <= 0.001) return null
  const alarm = tween(props.f, 250 + props.i * 4, 262 + props.i * 4)
  return (
    <div data-cover={s.flying ? `tool-${props.i}` : undefined}
      style={{
        position: 'absolute',
        left: s.x - CARD.w / 2,
        top: s.y - CARD.h / 2,
        transform: `translateZ(${s.z}px) rotate(${s.rot}deg) scale(${s.scale})`,
        opacity: s.opacity,
        filter: s.blur > 0.4 ? `blur(${s.blur}px)` : undefined,
      }}
    >
      <ToolCard i={props.i} frame={props.f} alarm={alarm} />
    </div>
  )
}

/** The cards in flight, drawn alone so the motion blur only costs what moves. */
function Flying() {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill>
      {TOOLS.map((_, i) => (cardState(i, f).flying ? <Card key={i} i={i} f={f} /> : null))}
    </AbsoluteFill>
  )
}

/** Beat 1: ten tools scattered in depth, a blinking caret among them, then all of them thrown into one box. */
export function Scatter() {
  const f = useCurrentFrame()
  if (f > BEAT.question + 40) return null
  const flightWindow = f >= BEAT.collapse + 40 && f <= BEAT.question + 10
  return (
    <AbsoluteFill style={{ transformStyle: 'preserve-3d' }}>
      {TOOLS.map((_, i) => (cardState(i, f).flying ? null : <Card key={i} i={i} f={f} />))}
      {flightWindow && (
        <MotionBlur samples={6}>
            <Flying />
          </MotionBlur>
      )}
    </AbsoluteFill>
  )
}
