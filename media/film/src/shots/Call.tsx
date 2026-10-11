import { BadgeCheck, Check, Mic, Phone as PhoneIcon, PhoneOff, Volume2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { clamp, EASES, lerp, noise, sp, SPRING, tween } from '../anim.ts'
import { ConversionChart } from '../components/Chart.tsx'
import { LedScreen } from '../components/Led.tsx'
import { Phone, PHONE_H, PHONE_W, SCREEN_TOP, SCREEN_W } from '../components/Phone.tsx'
import { ICON, STROKE, Surface } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { RADIUS, SPACE, SURFACE } from '../design.ts'
import { BEAT } from '../timeline.ts'
import manifest from '../vo-manifest.json'
import { VO_LINES } from '../vo.ts'
import { C, FPS } from '../theme.ts'

/** The phone on the call, in screen space: centred, a little smaller than life so the caption band stays clear. */
export const CALL = { x: 960, y: 596, scale: 0.86 }
const BEZEL = 13
export const BARS = 24
const BAR_W = 6
const BAR_GAP = 7
const WAVE_Y = 318

/** The phone's scale: a slow push in while the call plays, settled before the waveform leaves it. */
export const phoneScale = (f: number) => CALL.scale * lerp(1, 1.07, tween(f, BEAT.answer, BEAT.waveOut - 40, 0, 1, EASES.inOut))

/** Screen position of a point on the phone's screen as the call ends, when the waveform's bars leave it. */
export function onScreen(px: number, py: number): { x: number; y: number } {
  const s = phoneScale(BEAT.waveOut)
  return {
    x: CALL.x + (BEZEL + px - PHONE_W / 2) * s,
    y: CALL.y + (BEZEL + py - PHONE_H / 2) * s,
  }
}

/** Bar `i` of the call's waveform: where it sits on the phone's screen and how tall the voice makes it. */
export function bar(i: number, f: number): { x: number; h: number } {
  const total = BARS * BAR_W + (BARS - 1) * BAR_GAP
  const x = (SCREEN_W - total) / 2 + i * (BAR_W + BAR_GAP) + BAR_W / 2
  const talking = SPEECH.some(([a, b]) => f >= a && f < b) ? 1 : 0.18
  const env = Math.sin((i / (BARS - 1)) * Math.PI) * 0.7 + 0.3
  const h = 8 + Math.abs(noise(f * 0.18 + i * 1.7, i)) * 56 * env * talking
  return { x, h }
}
export const WAVE = { y: WAVE_Y, w: BAR_W }

/** The call's voice line, and where in the film its speech falls (src/vo-manifest.json, measured from the audio). */
const VOICE = VO_LINES.find((l) => l.id === 'call')
if (!VOICE || !manifest.call) throw new Error('The call needs its voice line; run scripts/voice.mjs')
const SPEECH = manifest.call.speech.map(([a, b]) => [VOICE.at + (a ?? 0) * FPS, VOICE.at + (b ?? 0) * FPS] as const)

/** The transcript, one line per sentence the voice says; each starts as its sentence does (pauses of 0.4 s part them). */
const LINES = (() => {
  const texts = ['Found it: a rounding bug in euro checkout.', 'Fixed, tested and deployed.', 'Conversions are back.']
  const groups: [number, number][] = []
  for (const [a, b] of SPEECH) {
    const last = groups.at(-1)
    if (last && a - last[1] < 0.4 * FPS) last[1] = b
    else groups.push([a, b])
  }
  if (groups.length !== texts.length) throw new Error(`The call's audio has ${groups.length} sentences, not ${texts.length}`)
  return texts.map((text, i) => ({ text, at: groups[i]?.[0] ?? 0, until: groups[i]?.[1] ?? 0 }))
})()
const LAST = LINES[LINES.length - 1] ?? { at: 0, until: 0 }

function RoundButton(props: { color: string; children: ReactNode; size?: number; press?: number }) {
  const size = props.size ?? 76
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: RADIUS.pill,
        background: props.color,
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        transform: `scale(${1 - (props.press ?? 0) * 0.12})`,
      }}
    >
      {props.children}
    </span>
  )
}

function Incoming(props: { f: number }) {
  const f = props.f
  const press = tween(f, BEAT.answer - 4, BEAT.answer) * (1 - tween(f, BEAT.answer, BEAT.answer + 8))
  const pulse = ((f - BEAT.call) % 60) / 60
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: SCREEN_TOP + 48, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SPACE[1] }}>
        <T role="title">Myrmidon</T>
        <T role="body" color={C.label3}>
          calling…
        </T>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 300, display: 'flex', justifyContent: 'center' }}>
        <div style={{ position: 'relative' }}>
          {[0, 0.5].map((o) => {
            const p = (pulse + o) % 1
            return (
              <span
                key={o}
                style={{
                  position: 'absolute',
                  inset: -20,
                  borderRadius: 60,
                  boxShadow: `inset 0 0 0 2px rgba(255,179,26,${0.5 * (1 - p)})`,
                  transform: `scale(${1 + p * 0.25})`,
                }}
              />
            )
          })}
          <LedScreen cols={15} rows={8} cell={14} eyes={{ look: [Math.round(Math.sin(f / 14) * 1.4), 0], blink: f % 90 < 5 }} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 90, display: 'flex', justifyContent: 'space-around' }}>
        {[
          { label: 'Decline', color: '#ff3b30', icon: <PhoneOff size={32} strokeWidth={2} /> },
          { label: 'Accept', color: '#34c759', icon: <PhoneIcon size={32} strokeWidth={2} /> },
        ].map((b) => (
          <div key={b.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SPACE[2] }}>
            <RoundButton color={b.color} press={b.label === 'Accept' ? press : 0}>
              {b.icon}
            </RoundButton>
            <T role="label" color={C.label2}>
              {b.label}
            </T>
          </div>
        ))}
      </div>
    </div>
  )
}

function InCall(props: { f: number; barsGone: boolean }) {
  const f = props.f
  const secs = Math.max(0, Math.floor((f - BEAT.answer) / 60))
  const speaking = LINES.filter((l) => f >= l.at).length - 1
  const recovered = tween(f, LAST.at, LAST.at + 70, 0, 1, EASES.inOut)
  const inner = SCREEN_W - SPACE[6] * 2
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: SCREEN_TOP + 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SPACE[2] }}>
        <LedScreen cols={15} rows={8} cell={7} eyes={f > LAST.at ? { mood: 'happy' } : { look: [Math.round(Math.sin(f / 20)), 0] }} />
        <T role="heading">Myrmidon</T>
        <T role="label" mono color={C.label3}>
          {`00:${String(secs).padStart(2, '0')}`}
        </T>
      </div>
      {!props.barsGone &&
        Array.from({ length: BARS }, (_, i) => {
          const b = bar(i, f)
          return (
            <span
              key={i}
              style={{ position: 'absolute', left: b.x - BAR_W / 2, top: WAVE_Y - b.h / 2, width: BAR_W, height: b.h, borderRadius: RADIUS.pill, background: C.accent }}
            />
          )
        })}
      <div
        data-box=""
        style={{
          position: 'absolute',
          left: SPACE[6],
          top: 372,
          width: inner,
          boxSizing: 'border-box',
          padding: SPACE[3],
          borderRadius: RADIUS.lg,
          background: SURFACE.card,
          boxShadow: `inset 0 0 0 1px ${C.separator}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: SPACE[2] }}>
          <T role="label" mono color={C.label3}>
            conversion
          </T>
          <T role="label" mono weight="semibold" color={recovered > 0.6 ? C.ok : C.bad}>
            {recovered > 0.6 ? 'back to 3.4%' : '−18%'}
          </T>
        </div>
        <ConversionChart width={inner - SPACE[3] * 2} height={96} recovered={recovered} />
      </div>
      <div style={{ position: 'absolute', left: SPACE[6], top: 552, width: inner, display: 'flex', flexDirection: 'column', gap: SPACE[2] }}>
        {LINES.map((l, i) => {
          if (f < l.at) return null
          const t = sp(f, l.at, SPRING.smooth)
          const words = l.text.split(' ')
          const shown = Math.ceil(clamp((f - l.at) / Math.max(1, l.until - l.at), 0, 1) * words.length)
          return (
            <T key={l.text} role="body" wrap weight={i === speaking ? 'medium' : 'regular'} color={i === speaking ? C.label : C.label3} style={{ display: 'block', width: inner, opacity: t }}>
              {words.slice(0, shown).join(' ')}
            </T>
          )
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 56, display: 'flex', justifyContent: 'space-around' }}>
        <RoundButton color={C.fillStrong} size={64}>
          <Mic size={26} strokeWidth={2} />
        </RoundButton>
        <RoundButton color={C.fillStrong} size={64}>
          <Volume2 size={26} strokeWidth={2} />
        </RoundButton>
        <RoundButton color="#ff3b30" size={64}>
          <PhoneOff size={26} strokeWidth={2} />
        </RoundButton>
      </div>
    </div>
  )
}

/** Beat 7: the same phone rises as the world falls away, rings, answers, and the lead says what it found. */
export function Call(props: { f: number }) {
  const f = props.f
  if (f < BEAT.call || f > BEAT.reach + 30) return null
  const rise = sp(f, BEAT.call, SPRING.heavy)
  const fall = tween(f, BEAT.waveOut, BEAT.waveOut + 50, 0, 1, EASES.in)
  const out = tween(f, BEAT.answer + 1, BEAT.answer + 9, 0, 1, EASES.in)
  const swap = tween(f, BEAT.answer + 7, BEAT.answer + 22, 0, 1, EASES.out)
  return (
    <>
      <Recap f={f} />
      <Recovery f={f} />
      <div
        style={{
          position: 'absolute',
          left: CALL.x - PHONE_W / 2,
          top: CALL.y - PHONE_H / 2,
          transform: `perspective(1600px) translateY(${(1 - rise) * 900 + fall * 160}px) rotateX(${(1 - rise) * 24}deg) scale(${phoneScale(f) * lerp(1, 0.92, fall)})`,
          opacity: 1 - fall,
          filter: fall > 0.05 ? `blur(${fall * 8}px)` : undefined,
        }}
      >
        <Phone>
          {out < 1 && (
            <div style={{ position: 'absolute', inset: 0, opacity: 1 - out }}>
              <Incoming f={f} />
            </div>
          )}
          {swap > 0 && (
            <div style={{ position: 'absolute', inset: 0, opacity: swap }}>
              <InCall f={f} barsGone={f >= BEAT.waveOut - 4} />
            </div>
          )}
        </Phone>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ beside the phone */

/** A card beside the phone: in as its line is spoken, out before the waveform leaves the phone. */
function Beside(props: { f: number; at: number; side: -1 | 1; children: ReactNode }) {
  const t = sp(props.f, props.at, SPRING.smooth)
  const gone = tween(props.f, BEAT.waveOut - 24, BEAT.waveOut + 6, 0, 1, EASES.in)
  if (props.f < props.at) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: props.side < 0 ? SIDE.left : SIDE.right,
        top: SIDE.top,
        width: SIDE.w,
        opacity: clamp(t * 1.4, 0, 1) * (1 - gone),
        transform: `translateX(${(1 - t) * 60 * props.side + gone * 80 * props.side}px)`,
        filter: gone > 0.05 ? `blur(${gone * 6}px)` : undefined,
      }}
    >
      {props.children}
    </div>
  )
}

const SIDE = { left: 150, right: 1290, top: 300, w: 480 }

const RECAP: string[] = [
  'Root cause: euro rounding in toCents()',
  'Regression test added',
  '412 tests passed',
  'Reviewed · score 0.97',
  'Allowed by Robin · event #2047',
]

/** On the left, as Myrmidon says it is fixed: what was done, line by line, as the app would log it. */
function Recap(props: { f: number }) {
  const f = props.f
  const at = LINES[1]?.at ?? BEAT.answer
  const inner = SIDE.w - SPACE[6] * 2
  return (
    <Beside f={f} at={at} side={-1}>
      <Surface width={SIDE.w} radius="xl" level="card" style={{ padding: SPACE[6], boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[3], marginBottom: SPACE[4] }}>
          <BadgeCheck size={ICON.md} strokeWidth={STROKE} color={C.ok} />
          <T role="heading">Hotfix deployed</T>
        </div>
        <T role="label" mono color={C.label3} style={{ display: 'block', marginBottom: SPACE[4] }}>
          quill/fix-eur-rounding → production
        </T>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE[3] }}>
          {RECAP.map((line, i) => {
            const t = sp(f, at + 10 + i * 9, SPRING.smooth)
            return (
              <div key={line} style={{ display: 'flex', alignItems: 'center', gap: SPACE[3], opacity: t, transform: `translateX(${(1 - t) * -12}px)` }}>
                <Check size={ICON.sm} strokeWidth={2.4} color={C.ok} style={{ flexShrink: 0 }} />
                <T role="body" color={C.label2} fit={inner - 30}>
                  {line}
                </T>
              </div>
            )
          })}
        </div>
      </Surface>
    </Beside>
  )
}

/** On the right, from Myrmidon's first words: checkout conversion, still down, then climbing back as it says so. */
function Recovery(props: { f: number }) {
  const f = props.f
  const recovered = tween(f, LAST.at, LAST.at + 70, 0, 1, EASES.inOut)
  const value = lerp(2.8, 3.4, recovered)
  return (
    <Beside f={f} at={LINES[0]?.at ?? BEAT.answer} side={1}>
      <Surface width={SIDE.w} radius="xl" level="card" style={{ padding: SPACE[6], boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: SPACE[2] }}>
          <T role="body" color={C.label2}>
            Checkout conversion
          </T>
          <T role="label" mono weight="semibold" color={recovered > 0.6 ? C.ok : C.bad}>
            {recovered > 0.6 ? 'recovered' : '−18%'}
          </T>
        </div>
        <T role="title" mono color={recovered > 0.6 ? C.label : C.bad} style={{ display: 'block', marginBottom: SPACE[4] }}>
          {`${value.toFixed(1)}%`}
        </T>
        <ConversionChart width={SIDE.w - SPACE[6] * 2} height={170} recovered={recovered} marker={1} />
      </Surface>
    </Beside>
  )
}
