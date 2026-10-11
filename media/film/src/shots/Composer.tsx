import { measureText } from '@remotion/layout-utils'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { clamp, EASES, lerp, quad, rand, sp, SPRING, track, tween, typed } from '../anim.ts'
import { MotionBlur } from '../components/World.tsx'
import { ArrowUp, BatteryMedium, Folder, Paperclip, Users, Zap } from 'lucide-react'
import { ModelMark } from '../components/Brand.tsx'
import { Chip, ICON, STROKE, Surface } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { Wordmark, WORDMARK_COLS, WORDMARK_ROWS, wordmarkDots } from '../components/Wordmark.tsx'
import { RADIUS, SPACE, TYPE } from '../design.ts'
import { BEAT, WORLD } from '../timeline.ts'
import { C } from '../theme.ts'

export const QUESTION = 'What if one chat did all of it?'
const TYPE_START = BEAT.question + 25
const CPS = 22
const SEND = BEAT.wordmark
const PAD = SPACE[6]
const H = WORLD.composer.h

/** The composer's centre, width, and how far it has grown out of the last tool card, at a frame. */
export function composerState(f: number) {
  const birth = sp(f, BEAT.question, SPRING.pop)
  const dock = tween(f, BEAT.dock, BEAT.dock + 110, 0, 1, EASES.inOut)
  const { free, docked } = WORLD.composer
  return {
    x: lerp(free.x, docked.x, dock),
    y: lerp(free.y, docked.y, dock),
    w: lerp(lerp(330, free.w, birth), docked.w, dock),
    h: lerp(112, H, birth),
    birth,
    dock,
  }
}

function caretOn(f: number): number {
  return 0.5 + 0.5 * Math.cos((f / 30) * Math.PI * 2) > 0.35 ? 1 : 0.15
}

/** The composer: the one box everything starts from. */
export function Composer(props: { f: number }) {
  const f = props.f
  if (f < BEAT.question) return null
  const s = composerState(f)
  const text = f < SEND + 8 ? typed(QUESTION, f, TYPE_START, CPS) : ''
  const lift = tween(f, SEND + 8, SEND + 40, 0, 1, EASES.in)
  const typing = f >= TYPE_START && text.length < QUESTION.length
  const press = tween(f, SEND, SEND + 6) * (1 - tween(f, SEND + 6, SEND + 16))
  const ring = Math.exp(-Math.max(0, f - BEAT.question) / 20)
  // The amber focus ring of the home screen's composer, quieter once it sits docked in the chat.
  const glow = (0.55 + 0.25 * Math.sin(f / 26) + ring) * (1 - 0.6 * s.dock)
  const content = clamp((s.birth - 0.6) * 2.5, 0, 1)
  return (
    <div style={{ position: 'absolute', left: s.x - s.w / 2, top: s.y - s.h / 2 }}>
      <Surface
        width={s.w}
        height={s.h}
        radius="xl"
        tint={`rgba(255,179,26,${0.35 + 0.35 * glow})`}
        glow={glow * 0.8}
        style={{ boxShadow: `inset 0 0 0 1px rgba(255,179,26,${0.35 + 0.3 * glow}), 0 0 0 ${6 + ring * 22}px rgba(255,179,26,${0.06 + ring * 0.08}), 0 0 ${70 * glow}px rgba(255,164,28,0.22), 0 50px 110px -30px rgba(0,0,0,0.95)` }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            padding: PAD,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            opacity: content,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 34,
              opacity: text ? 1 - lift : f < SEND ? 1 : tween(f, SEND + 50, SEND + 80),
            }}
          >
            {text ? (
              <T role="heading" weight="regular">
                {text}
              </T>
            ) : (
              <T role="heading" weight="regular" color={C.label4}>
                {f < SEND ? 'Describe what you want done…' : 'Ask a follow-up or request changes…'}
              </T>
            )}
            {f > BEAT.question + 22 && f < SEND + 4 && (
              <span
                style={{
                  width: 3,
                  height: 32,
                  marginLeft: 2,
                  borderRadius: 2,
                  background: C.accent,
                  opacity: typing ? 1 : caretOn(f),
                }}
              />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
            <Paperclip size={ICON.md} strokeWidth={STROKE} color={C.label3} style={{ marginRight: SPACE[1] }} />
            <Chip mark={<ModelMark model="claude" size={22} />} trail={BatteryMedium} menu>
              Claude Sonnet 5.5
            </Chip>
            <Chip icon={Users} menu>
              Crew
            </Chip>
            <Chip icon={Folder}>acme/shop</Chip>
            <Chip icon={Zap} menu>
              Auto
            </Chip>
            <div style={{ flex: 1 }} />
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: RADIUS.pill,
                display: 'grid',
                placeItems: 'center',
                background: text ? C.accent : C.control,
                color: text ? C.onAccent : C.label3,
                transform: `scale(${1 - press * 0.12})`,
                boxShadow: text ? `0 0 ${18 + press * 30}px rgba(255,179,26,0.5)` : undefined,
              }}
            >
              <ArrowUp size={ICON.md} strokeWidth={2.2} />
            </div>
          </div>
        </div>
      </Surface>
    </div>
  )
}

/** The caret that blinks alone in the dark before anything else, then slides into the composer as it forms. */
export function LoneCaret(props: { f: number }) {
  const f = props.f
  if (f > BEAT.question + 24) return null
  const into = tween(f, BEAT.question, BEAT.question + 22, 0, 1, EASES.expoOut)
  const x = lerp(960, WORLD.composer.free.x - WORLD.composer.free.w / 2 + PAD, into)
  const y = lerp(560, WORLD.composer.free.y - H / 2 + PAD + 17, into)
  const fadeIn = tween(f, 6, 20)
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 2,
        top: y - 22,
        width: 4,
        height: 44,
        borderRadius: 2,
        background: C.accent,
        boxShadow: `0 0 18px ${C.glow}`,
        opacity: fadeIn * caretOn(f),
      }}
    />
  )
}

/* ------------------------------------------------------------------ the question becomes the wordmark */

const DOTS = wordmarkDots(WORLD.wordmark.free.pitch)
const FLY_START = SEND + 10
const FLY_LEN = 62

let charX: number[] | null = null
/**
 * Where each character of the question sat in the composer, so its dots leave from there. Measured on first use, which
 * is always after the fonts are in (fonts.ts holds the render until then).
 */
function charOffsets(): number[] {
  if (charX) return charX
  const t = TYPE.heading
  charX = [0]
  for (let i = 1; i <= QUESTION.length; i++)
    charX.push(
      measureText({
        text: QUESTION.slice(0, i),
        fontFamily: t.fontFamily,
        fontSize: t.fontSize,
        fontWeight: 400,
        letterSpacing: t.letterSpacing,
        validateFontIsLoaded: true,
      }).width,
    )
  return charX
}

function particle(i: number, f: number) {
  const ch = Math.floor((i / DOTS.length) * QUESTION.length)
  const { free } = WORLD.composer
  const xs = charOffsets()
  const x0 = free.x - free.w / 2 + PAD + lerp(xs[ch] ?? 0, xs[ch + 1] ?? 0, rand(i * 3))
  const y0 = free.y - H / 2 + PAD + 17 + (rand(i * 5) - 0.5) * 20
  const [dx, dy] = DOTS[i] ?? [0, 0]
  const x1 = WORLD.wordmark.free.x + dx
  const y1 = WORLD.wordmark.free.y + dy
  const start = FLY_START + rand(i * 7) * 26
  const t = tween(f, start, start + FLY_LEN, 0, 1, EASES.inOut)
  const c: [number, number] = [lerp(x0, x1, 0.3) + (rand(i * 11) - 0.5) * 260, Math.min(y0, y1) - 90 - rand(i * 13) * 120]
  const [x, y] = quad(t, [x0, y0], c, [x1, y1])
  return { x, y, t, start }
}

function Particles() {
  const f = useCurrentFrame()
  const size = WORLD.wordmark.free.pitch * 0.72
  return (
    <AbsoluteFill>
      {DOTS.map((_, i) => {
        const p = particle(i, f)
        if (p.t <= 0 || p.t >= 1) return null
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: p.x - size / 2,
              top: p.y - size / 2,
              width: size,
              height: size,
              borderRadius: size * 0.28,
              background: C.eyeTop,
              boxShadow: `0 0 ${size}px ${C.glow}`,
              opacity: clamp(p.t * 6, 0, 1),
              transform: `scale(${lerp(0.4, 1, p.t)})`,
            }}
          />
        )
      })}
    </AbsoluteFill>
  )
}

/** The dots of the question in flight, with motion blur. */
export function QuestionDots(props: { f: number }) {
  if (props.f < FLY_START || props.f > FLY_START + FLY_LEN + 30) return null
  return (
    <MotionBlur samples={5}>
        <Particles />
      </MotionBlur>
  )
}

/**
 * The wordmark: its grid fades up as the question leaves the composer, each dot lights as its particle lands, it holds
 * and breathes, then shrinks into the app's sidebar as the app draws itself around the composer.
 */
export function WordmarkShot(props: { f: number }) {
  const f = props.f
  if (f < SEND) return null
  const { free, docked } = WORLD.wordmark
  const dock = tween(f, BEAT.dock, BEAT.dock + 110, 0, 1, EASES.inOut)
  const pitch = lerp(free.pitch, docked.pitch, dock)
  const x = lerp(free.x, docked.x, dock)
  const y = lerp(free.y, docked.y, dock)
  const breathe = 0.85 + 0.15 * Math.sin(f / 20)
  const flash = Math.exp(-Math.max(0, f - (FLY_START + FLY_LEN + 20)) / 18) * clamp((f - FLY_START - FLY_LEN) / 10, 0, 1)
  return (
    <div style={{ position: 'absolute', left: x - (WORDMARK_COLS * pitch) / 2, top: y - (WORDMARK_ROWS * pitch) / 2 }}>
      <Wordmark
        pitch={pitch}
        grid={track(f, [
          { f: SEND, v: 0 },
          { f: SEND + 40, v: 1, ease: EASES.out },
          { f: BEAT.dock + 40, v: 1 },
          { f: BEAT.dock + 110, v: 0.5 },
        ])}
        glow={breathe * lerp(1, 0.5, dock) + flash}
        lit={(i) => {
          const p = particle(i, f)
          return p.t >= 1 ? 1 : 0
        }}
      />
    </div>
  )
}
