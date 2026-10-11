import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { clamp, EASES, lerp, quad, sp, SPRING, tween, typed } from '../anim.ts'
import { MotionBlur } from '../components/World.tsx'
import { ArrowUp } from 'lucide-react'
import { ConversionChart } from '../components/Chart.tsx'
import { LogoTile } from '../components/Led.tsx'
import { Phone, PHONE_H, PHONE_W, SCREEN_TOP, SCREEN_W } from '../components/Phone.tsx'
import { T } from '../components/Text.tsx'
import { RADIUS, SHADOW, SPACE } from '../design.ts'
import { BEAT, WORLD } from '../timeline.ts'
import { C } from '../theme.ts'

export const MESSAGE = 'Checkout conversions dropped 18% overnight. Find out why, fix it, and call me.'
const TYPE_START = BEAT.phoneClose
const CPS = 40
const BUBBLE_W = WORLD.chat.bubble.w
const BUBBLE_X = SCREEN_W - SPACE[4] - BUBBLE_W
const BUBBLE_Y = 470
const BEZEL = 13
const ALERT_W = 340
const LIFT = BEAT.flight
const TRAVEL = [BEAT.flight + 12, BEAT.flight + 85] as const

/** Mixes two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16)
  const pb = Number.parseInt(b.slice(1), 16)
  const ch = (s: number) => Math.round(lerp((pa >> s) & 255, (pb >> s) & 255, t))
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`
}

/**
 * Alex's message: amber as it leaves the phone, the app's bubble grey once it has landed in the chat. `t` is how far
 * along that change it is; the landed bubble is fully grey.
 */
export function Bubble(props: { landed?: boolean; t?: number; lift?: number }) {
  const t = props.landed ? 1 : (props.t ?? 0)
  const lift = props.lift ?? 0
  return (
    <div
      data-box=""
      style={{
        width: BUBBLE_W,
        padding: `${SPACE[3]}px ${SPACE[4]}px`,
        boxSizing: 'border-box',
        borderRadius: RADIUS.xl,
        borderBottomRightRadius: RADIUS.sm,
        background: mix(C.accent, C.bubble, t),
        boxShadow: `${SHADOW.md}${lift > 0 ? `, 0 ${30 * lift}px ${60 * lift}px -20px rgba(0,0,0,0.9)` : ''}`,
      }}
    >
      <T role="body" wrap color={mix(C.onAccent, C.label, t)} style={{ display: 'block' }}>
        {MESSAGE}
      </T>
    </div>
  )
}

/** Where the bubble is in the world at a frame of its flight from the phone to the chat. */
function flight(f: number) {
  const p = WORLD.phone
  const x0 = p.x - PHONE_W / 2 + BEZEL + BUBBLE_X
  const y0 = p.y - PHONE_H / 2 + BEZEL + BUBBLE_Y
  const b = WORLD.chat.bubble
  const x1 = b.right - BUBBLE_W
  const y1 = b.top
  const t = tween(f, TRAVEL[0], TRAVEL[1], 0, 1, EASES.inOut)
  const [x, y] = quad(t, [x0, y0], [lerp(x0, x1, 0.5), Math.min(y0, y1) - 260], [x1, y1])
  const lift = tween(f, LIFT, TRAVEL[0], 0, 1, EASES.out) * (1 - tween(f, TRAVEL[1] - 10, TRAVEL[1] + 6))
  const settle = sp(f, TRAVEL[1], SPRING.pop)
  return { x, y, t, lift, scale: 1 + lift * 0.06 - (f > TRAVEL[1] ? (1 - settle) * 0.04 : 0) }
}

function Flying() {
  const f = useCurrentFrame()
  const s = flight(f)
  return (
    <AbsoluteFill>
      <div data-cover="bubble" style={{ position: 'absolute', left: s.x, top: s.y, transform: `scale(${s.scale}) rotate(${Math.sin(s.t * Math.PI) * -4}deg)`, transformOrigin: '100% 0' }}>
        <Bubble t={clamp((s.t - 0.4) * 2, 0, 1)} lift={s.lift} />
      </div>
    </AbsoluteFill>
  )
}

/** The bubble between the phone and the chat: one object crossing the world, the camera following it. */
export function BubbleFlight(props: { f: number }) {
  const f = props.f
  if (f < LIFT || f >= TRAVEL[1] + 1) return null
  const moving = f > TRAVEL[0] && f < TRAVEL[1]
  if (!moving) {
    const s = flight(f)
    return (
      <div data-cover="bubble" style={{ position: 'absolute', left: s.x, top: s.y, transform: `scale(${s.scale})`, transformOrigin: '100% 0' }}>
        <Bubble t={0} lift={s.lift} />
      </div>
    )
  }
  return (
    <MotionBlur samples={6}>
        <Flying />
      </MotionBlur>
  )
}

function Thread(props: { f: number }) {
  const f = props.f
  const text = typed(MESSAGE, f, TYPE_START, CPS)
  const sent = f >= BEAT.send
  const pop = sp(f, BEAT.send + 2, SPRING.pop)
  const caret = Math.floor(f / 28) % 2 === 0 || (text.length > 0 && text.length < MESSAGE.length)
  const press = tween(f, BEAT.send - 6, BEAT.send) * (1 - tween(f, BEAT.send, BEAT.send + 10))
  const alert = sp(f, BEAT.ask + 40, SPRING.smooth)
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: SCREEN_TOP,
          height: 84,
          display: 'flex',
          alignItems: 'center',
          gap: SPACE[3],
          padding: `0 ${SPACE[6]}px`,
          boxShadow: `inset 0 -1px 0 ${C.separator}`,
        }}
      >
        <LogoTile size={48} eyes={{ look: [Math.round(Math.sin(f / 40)), 0] }} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <T role="body" weight="semibold">
            Myrmidon
          </T>
          <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
            <span style={{ width: 8, height: 8, borderRadius: RADIUS.pill, background: C.ok, boxShadow: `0 0 8px ${C.ok}`, opacity: 0.6 + 0.4 * Math.sin(f / 10) }} />
            <T role="label" color={C.ok}>
              online
            </T>
          </span>
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: SPACE[4],
          top: 168,
          width: ALERT_W,
          padding: `${SPACE[3]}px ${SPACE[4]}px ${SPACE[4]}px`,
          boxSizing: 'border-box',
          borderRadius: RADIUS.xl,
          borderBottomLeftRadius: RADIUS.sm,
          background: C.bubble,
          opacity: alert,
          transform: `translateY(${(1 - alert) * 20}px)`,
        }}
        data-box=""
      >
        <T role="body" wrap style={{ display: 'block' }}>
          Heads up, Robin: checkout conversion is down 18% since 21:40.
        </T>
        <div style={{ marginTop: SPACE[3], display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <T role="label" mono color={C.label3}>
            conversion · 24h
          </T>
          <T role="label" mono weight="semibold" color={C.bad}>
            −18%
          </T>
        </div>
        <div style={{ marginTop: SPACE[2] }}>
          <ConversionChart width={ALERT_W - SPACE[4] * 2} height={96} draw={tween(f, BEAT.ask + 60, BEAT.ask + 150, 0, 1, EASES.inOut)} />
        </div>
      </div>
      {sent && f < LIFT && (
        <div style={{ position: 'absolute', left: BUBBLE_X, top: BUBBLE_Y, transform: `scale(${pop})`, transformOrigin: '100% 100%' }}>
          <Bubble t={0} />
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          left: SPACE[4],
          right: SPACE[4],
          bottom: SPACE[8],
          display: 'flex',
          alignItems: 'flex-end',
          gap: SPACE[2],
        }}
      >
        <div
          data-box=""
          style={{
            flex: 1,
            minHeight: 52,
            padding: `${SPACE[3]}px ${SPACE[4]}px`,
            borderRadius: RADIUS.xl,
            background: C.fill,
            boxShadow: `inset 0 0 0 1px ${C.separatorStrong}`,
            boxSizing: 'border-box',
          }}
        >
          {!sent && text ? (
            <T role="body" wrap style={{ display: 'inline' }}>
              {text}
            </T>
          ) : (
            <T role="body" color={C.label4}>
              Message
            </T>
          )}
          {!sent && f >= TYPE_START - 20 && (
            <span style={{ display: 'inline-block', width: 2, height: 24, marginLeft: 2, verticalAlign: -5, background: C.accent, opacity: caret ? 1 : 0 }} />
          )}
        </div>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: RADIUS.pill,
            display: 'grid',
            placeItems: 'center',
            background: text && !sent ? C.accent : C.control,
            color: text && !sent ? C.onAccent : C.label3,
            transform: `scale(${1 - press * 0.15})`,
            flexShrink: 0,
          }}
        >
          <ArrowUp size={24} strokeWidth={2.2} />
        </div>
      </div>
    </>
  )
}

/** Beat 3: Alex's phone rises beside the app, Alex types the ask and sends it. */
export function PhoneAsk(props: { f: number }) {
  const f = props.f
  if (f < BEAT.ask || f > BEAT.plan + 20) return null
  const rise = sp(f, BEAT.ask + 20, SPRING.heavy)
  const p = WORLD.phone
  return (
    <div
      style={{
        position: 'absolute',
        left: p.x - PHONE_W / 2,
        top: p.y - PHONE_H / 2,
        transform: `translateY(${(1 - rise) * 900}px) rotate(${(1 - rise) * 8}deg)`,
      }}
    >
      <Phone>
        <Thread f={f} />
      </Phone>
    </div>
  )
}
