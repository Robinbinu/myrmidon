import { measureText } from '@remotion/layout-utils'
import { BatteryMedium, type LucideIcon, MessagesSquare, PhoneIncoming } from 'lucide-react'
import type { ReactNode } from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { clamp, EASES, lerp, quad, rand, sp, SPRING, tween } from '../anim.ts'
import { MotionBlur } from '../components/World.tsx'
import { ChannelMark, ModelMark } from '../components/Brand.tsx'
import { LogoTile } from '../components/Led.tsx'
import { STROKE } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { wordmarkDots } from '../components/Wordmark.tsx'
import { RADIUS, SHADOW, SPACE, TYPE } from '../design.ts'
import { BEAT, END } from '../timeline.ts'
import { C } from '../theme.ts'
import { BARS, bar, onScreen, WAVE } from './Call.tsx'

/** Brand marks in the orbit are drawn large enough to read at 1080p, even on the chips at the back. */
const MARK = 34

/** A chip's label and its mark: the app's channel logo, model maker logo, or a plain icon. */
const lucide = (Icon: LucideIcon) => () => <Icon size={MARK} strokeWidth={STROKE} />
const channel = (id: string) => () => <ChannelMark id={id} size={MARK} />
const maker = (model: string) => () => <ModelMark model={model} size={MARK} />

const CHANNELS: [string, () => ReactNode][] = [
  ['Telegram', channel('telegram')],
  ['WhatsApp', channel('whatsapp')],
  ['Slack', channel('slack')],
  ['Discord', channel('discord')],
  ['iMessage', channel('imessage')],
  ['Signal', channel('signal')],
  ['Teams', channel('msteams')],
  ['Email', channel('email')],
  ['SMS', channel('sms')],
  ['Matrix', channel('matrix')],
  ['Phone calls', lucide(PhoneIncoming)],
  ['+19 more', lucide(MessagesSquare)],
]
const MODELS: [string, () => ReactNode][] = [
  ['Claude', maker('claude')],
  ['GPT', maker('gpt')],
  ['Gemini', maker('gemini')],
  ['Llama', maker('llama')],
  ['Qwen', maker('qwen')],
  ['DeepSeek', maker('deepseek')],
  ['Mistral', maker('mistral')],
  ['Grok', maker('grok')],
  ['Kimi', maker('kimi')],
  ['GLM', maker('glm')],
  ['Local models', maker('ollama')],
  ['Your subscriptions', lucide(BatteryMedium)],
]
const N = CHANNELS.length
const CENTER = { x: 960, y: 612 }
const R = { x: 760, y: 250 }
const CHIP_H = 68
const MORPH = [BEAT.waveOut + 6, BEAT.reach + 40] as const

const widths = new Map<string, number>()
/** A big chip's width for its label: padding, icon, gap and the measured text. */
function chipWidth(label: string): number {
  const known = widths.get(label)
  if (known) return known
  const t = TYPE.heading
  const w =
    SPACE[6] * 2 +
    MARK +
    SPACE[3] +
    Math.ceil(measureText({ text: label, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: 600, letterSpacing: t.letterSpacing, validateFontIsLoaded: true }).width)
  widths.set(label, w)
  return w
}

const spinAt = (f: number) => {
  const t = Math.max(0, f - MORPH[0])
  const burst = tween(f, BEAT.burst, BEAT.burst + 60, 0, 1, EASES.in)
  return -Math.PI / 2 + 0.3 + t * 0.006 + burst * burst * 3.2
}

/** Chip `i` on the orbit: position, depth, and how far round it has turned to its model name. */
function chip(i: number, f: number) {
  const a = (i / N) * Math.PI * 2 + spinAt(f)
  const pull = 1 - tween(f, BEAT.burst, BEAT.burst + 50, 0, 1, EASES.inOut)
  const depth = Math.sin(a)
  const near = (depth + 1) / 2
  const flip = tween(f, BEAT.models + i * 4, BEAT.models + i * 4 + 16)
  return {
    x: CENTER.x + Math.cos(a) * R.x * pull,
    y: CENTER.y + depth * R.y * pull,
    near,
    scale: lerp(0.8, 1.08, near) * lerp(0.3, 1, pull),
    flip,
    model: flip >= 0.5,
  }
}

function OrbitChip(props: { i: number; f: number }) {
  const { i, f } = props
  const c = chip(i, f)
  const [label, Mark] = (c.model ? MODELS[i] : CHANNELS[i]) ?? ['', () => null]
  const target = chipWidth(label)
  // The waveform's bar this chip grew from: its place on the phone, and its height when the call ended.
  const m = tween(f, MORPH[0] + i * 2, MORPH[1] + i * 2, 0, 1, EASES.inOut)
  const b = bar(i * 2, BEAT.waveOut - 4)
  const from = onScreen(b.x, WAVE.y)
  const x = lerp(from.x, c.x, m)
  const y = lerp(from.y, c.y, m)
  const w = lerp(WAVE.w * 0.86, target, m)
  const h = lerp(b.h * 0.86, CHIP_H, m)
  const scale = lerp(1, c.scale, m)
  // The label shows only once the chip is wide enough to hold it.
  const content = tween(m, 0.95, 1) * (1 - tween(f, BEAT.burst, BEAT.burst + 24))
  const fade = 1 - tween(f, BEAT.burst + 30, BEAT.burst + 50)
  return (
    <div
      data-box=""
      style={{
        position: 'absolute',
        left: x - w / 2,
        top: y - h / 2,
        width: w,
        height: h,
        borderRadius: RADIUS.pill,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACE[3],
        background: m < 1 ? `rgba(${lerp(255, 27, m)},${lerp(179, 27, m)},${lerp(26, 32, m)},1)` : C.raised,
        boxShadow: `inset 0 0 0 1px ${C.separatorStrong}, ${SHADOW.md}`,
        transform: `scale(${scale}) scaleY(${Math.abs(Math.cos(c.flip * Math.PI))})`,
        opacity: lerp(1, lerp(0.35, 1, c.near), m) * fade,
        filter: m > 0.9 && c.near < 0.4 ? `blur(${(0.4 - c.near) * 7}px)` : undefined,
        zIndex: c.near > 0.5 ? 3 : 1,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[3], opacity: content, color: C.label, flexShrink: 0 }}>
        <Mark />
        <T role="heading" color={C.label}>
          {label}
        </T>
      </span>
    </div>
  )
}

/** Beat 8: the call's waveform bars stretch into twelve chips orbiting the mark; channels first, then models. */
export function Reach(props: { f: number }) {
  const f = props.f
  if (f < BEAT.waveOut - 4 || f > BEAT.burst + 60) return null
  const logo = sp(f, BEAT.reach, SPRING.pop) * (1 - tween(f, BEAT.burst, BEAT.burst + 40, 0, 1, EASES.in))
  const odd = 1 - tween(f, MORPH[0], MORPH[0] + 20)
  return (
    <AbsoluteFill>
      {odd > 0 &&
        Array.from({ length: BARS / 2 }, (_, k) => {
          const b = bar(k * 2 + 1, BEAT.waveOut - 4)
          const p = onScreen(b.x, WAVE.y)
          return (
            <span
              key={k}
              style={{ position: 'absolute', left: p.x - 2.5, top: p.y - (b.h * 0.86) / 2, width: 5, height: b.h * 0.86 * odd, borderRadius: RADIUS.pill, background: C.accent, opacity: odd }}
            />
          )
        })}
      {Array.from({ length: N }, (_, i) => chip(i, f))
        .map((c, i) => ({ c, i }))
        .sort((a, b) => a.c.near - b.c.near)
        .map(({ i }) => (
          <OrbitChip key={i} i={i} f={f} />
        ))}
      {logo > 0.01 && (
        <div style={{ position: 'absolute', left: CENTER.x - 90, top: CENTER.y - 90, zIndex: 2, transform: `scale(${logo})`, opacity: clamp(logo * 1.4, 0, 1) }}>
          <LogoTile size={180} glow={1.3} eyes={f > BEAT.models - 10 && f < BEAT.models + 30 ? { mood: 'wink' } : { look: [Math.round(Math.sin(f / 30)), 0] }} />
        </div>
      )}
    </AbsoluteFill>
  )
}

/* ------------------------------------------------------------------ the chips burst into the end card's dots */

const DOTS = wordmarkDots(END.pitch)
export const DOT_FLY = 56
/** When dot `k` leaves the orbit, staggered, and from which chip. */
export const dotStart = (k: number) => BEAT.burst + 30 + rand(k * 3 + 1) * 26

function dot(k: number, f: number) {
  const c = chip(k % N, Math.min(f, dotStart(k)))
  const [dx, dy] = DOTS[k] ?? [0, 0]
  const tx = END.x + dx
  const ty = END.y + dy
  const t = tween(f, dotStart(k), dotStart(k) + DOT_FLY, 0, 1, EASES.inOut)
  const [x, y] = quad(t, [c.x, c.y], [lerp(c.x, tx, 0.5) + (rand(k) - 0.5) * 300, Math.min(c.y, ty) - 120], [tx, ty])
  return { x, y, t }
}

function Dots() {
  const f = useCurrentFrame()
  const size = END.pitch * 0.72
  return (
    <AbsoluteFill>
      {DOTS.map((_, k) => {
        const p = dot(k, f)
        if (p.t <= 0 || p.t >= 1) return null
        return (
          <span
            key={k}
            style={{
              position: 'absolute',
              left: p.x - size / 2,
              top: p.y - size / 2,
              width: size,
              height: size,
              borderRadius: size * 0.28,
              background: C.eyeTop,
              boxShadow: `0 0 ${size}px ${C.glow}`,
              transform: `scale(${lerp(0.5, 1, p.t)})`,
            }}
          />
        )
      })}
    </AbsoluteFill>
  )
}

export function BurstDots(props: { f: number }) {
  const f = props.f
  if (f < BEAT.burst + 30 || f > BEAT.burst + 30 + 26 + DOT_FLY + 2) return null
  return (
    <MotionBlur samples={5}>
        <Dots />
      </MotionBlur>
  )
}

/** Whether end-card dot `k` has landed by frame f. */
export const dotLanded = (k: number, f: number) => f >= dotStart(k) + DOT_FLY
