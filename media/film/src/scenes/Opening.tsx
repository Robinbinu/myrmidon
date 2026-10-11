import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASE_IN, EASE_IN_OUT, SPRING, clamp, lerp, rand, sp, tween } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon, type IconName } from '../components/Icon.tsx'
import { dotLayout, type EyeState, LedScreen, LogoTile } from '../components/Led.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { Composer } from '../components/Ui.tsx'
import { C, FONT, MONO } from '../theme.ts'

/** Ten tools, each its own bill, login or inbox. Generic names: no real products. */
const TOOLS: { name: string; note: string; icon: IconName; tint: string; badge?: number }[] = [
  { name: 'Coding agent', note: '$20 / mo', icon: 'terminal', tint: '#9be37a' },
  { name: 'Browser bot', note: 'another login', icon: 'globe', tint: '#7fdcff', badge: 2 },
  { name: 'Voice app', note: '$15 / mo', icon: 'mic', tint: '#ff8fc0' },
  { name: 'Chatbot', note: 'forgets everything', icon: 'message', tint: '#c8c8d0', badge: 5 },
  { name: 'Research tool', note: '$25 / mo', icon: 'search', tint: '#b69cff' },
  { name: 'Scheduler', note: 'one more API key', icon: 'calendar', tint: '#ff8a4c' },
  { name: 'Workflow builder', note: '$29 / mo', icon: 'workflow', tint: '#5ee6a8', badge: 1 },
  { name: 'Computer-use agent', note: 'waitlist', icon: 'pointer', tint: '#ffcf5c' },
  { name: 'Chat-app bot', note: 'one more inbox', icon: 'hash', tint: '#4d7cff', badge: 9 },
  { name: 'Model router', note: '$10 / mo', icon: 'router', tint: '#f25c8a' },
]

/** Where each card comes to rest in the pile, around its centre: x, y, rotation. */
const PILE: [number, number, number][] = [
  [-585, -165, -8],
  [590, -150, 7],
  [-195, -185, -3],
  [-400, 10, 10],
  [195, -175, 5],
  [400, 15, -9],
  [-200, 175, 6],
  [5, -5, -4],
  [590, 180, -12],
  [205, 185, 13],
]
const PILE_X = 960
const PILE_Y = 735
const CARD_W = 372
const CARD_H = 138

const DROP_START = 96
const DROP_GAP = 11
/** Frames a dropped card takes to land, near enough for the thud. */
const LAND = 22
const COLLAPSE = 330
const COMPOSER_AT = 372
const COMPOSER_Y = 640
const LOCKUP_AT = 522

function ToolCard(props: { i: number }) {
  const t = TOOLS[props.i]
  if (!t) return null
  return (
    <div
      style={{
        minWidth: CARD_W,
        height: CARD_H,
        whiteSpace: 'nowrap',
        borderRadius: 24,
        background: 'linear-gradient(180deg, #1a1a1f 0%, #141418 100%)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.1), inset 0 1px 0 rgba(255,255,255,0.06), 0 24px 50px -16px rgba(0,0,0,0.95)',
        display: 'flex',
        alignItems: 'center',
        gap: 22,
        padding: '0 34px 0 26px',
        fontFamily: FONT,
        position: 'relative',
      }}
    >
      <div
        style={{
          width: 70,
          height: 70,
          borderRadius: 18,
          display: 'grid',
          placeItems: 'center',
          background: `${t.tint}1f`,
          boxShadow: `inset 0 0 0 1px ${t.tint}40`,
          color: t.tint,
        }}
      >
        <Icon name={t.icon} size={36} stroke={1.8} />
      </div>
      <div>
        <div style={{ fontSize: 29, fontWeight: 620, color: C.label, letterSpacing: '-0.02em' }}>{t.name}</div>
        <div style={{ fontFamily: MONO, fontSize: 19, color: C.label3, marginTop: 8 }}>{t.note}</div>
      </div>
      {t.badge && (
        <div
          style={{
            position: 'absolute',
            right: -10,
            top: -10,
            minWidth: 34,
            height: 34,
            borderRadius: 99,
            background: '#ff453a',
            color: '#fff',
            fontSize: 19,
            fontWeight: 700,
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 0 0 3px #050506',
          }}
        >
          {t.badge}
        </div>
      )}
    </div>
  )
}

/** The eyes in the mascot screen over the opening: waking, watching the pile land, worrying, then hopeful. */
function openingEyes(frame: number): EyeState {
  if (frame < 40) return { mood: 'closed' }
  if (frame < 50) return { mood: 'squint' }
  if (frame >= 72 && frame < 79) return { blink: true }
  if (frame < DROP_START) return { look: [0, 0] }
  if (frame < COLLAPSE) {
    const landed = Math.floor((frame - DROP_START) / DROP_GAP)
    const target = PILE[clamp(landed, 0, PILE.length - 1)] ?? [0, 0, 0]
    const look: [number, number] = [Math.round(clamp(target[0] / 200, -2, 2)), 1]
    if (frame >= 236 && frame < 243) return { blink: true }
    if (frame > 270) return { mood: 'worried', look: [0, 0] }
    return { mood: landed >= 6 ? 'worried' : 'open', look }
  }
  if (frame < COMPOSER_AT + 12) return { mood: 'wide', look: [0, 1] }
  if (frame < LOCKUP_AT - 20) return { look: [0, 1] }
  return { mood: 'happy' }
}

/** Shake left by each card landing: a decaying wobble that adds up as the pile grows. */
function thud(frame: number): number {
  let y = 0
  for (let i = 0; i < TOOLS.length; i++) {
    const t = frame - (DROP_START + i * DROP_GAP + LAND)
    if (t > 0 && t < 40) y += Math.sin(t * 0.9) * 7 * Math.exp(-t / 7)
  }
  return y
}

export function Opening(props: { dur: number }) {
  const frame = useCurrentFrame()

  // The mascot screen wakes in the middle, then rises out of the way of the pile.
  const boot = tween(frame, 10, 44, 0, 1, EASE_IN_OUT)
  const rise = sp(frame, 80, SPRING.smooth)
  const screenScale = lerp(1, 0.46, rise) * (1 + thud(frame) * 0.002)
  const screenY = lerp(540, 196, rise) + thud(frame) * 0.4
  // Into the mark: the screen shrinks into the logo tile's place.
  const morph = tween(frame, LOCKUP_AT, LOCKUP_AT + 34, 0, 1, EASE_IN_OUT)

  const lockupX = 530
  const lockupY = 392
  const tileSize = 156

  const sx = lerp(960, lockupX + tileSize / 2, morph)
  const sy = lerp(screenY, lockupY, morph)
  const sScale = lerp(screenScale, (tileSize / 666) * 1.15, morph)

  const collapseT = (i: number) => tween(frame, COLLAPSE + 14 + i * 2, COLLAPSE + 46 + i * 2, 0, 1, EASE_IN)
  const anticipate = (i: number) =>
    tween(frame, COLLAPSE + i * 1.5, COLLAPSE + 14 + i * 1.5) * (1 - collapseT(i))

  const composerIn = sp(frame, COMPOSER_AT, SPRING.pop)
  const burst = tween(frame, COMPOSER_AT - 4, COMPOSER_AT + 46, 0, 1)

  // The wordmark: dots stream out of the mark and settle into dot-matrix letters, then become the type.
  const word = dotLayout('Myrmidon')
  const wordW = 660
  const pitch = wordW / word.width
  const wordLeft = lockupX + tileSize + 44
  const wordTop = lockupY - (7 * pitch) / 2
  const solid = tween(frame, LOCKUP_AT + 66, LOCKUP_AT + 92)
  const blink = frame >= 612 && frame < 619

  return (
    <Shot dur={props.dur} inFrames={0}>
      <Stage
        glow={{
          x: 960,
          y: lerp(lerp(540, 520, rise), COMPOSER_Y, tween(frame, COMPOSER_AT, COMPOSER_AT + 30)),
          strength: tween(frame, 20, 60) * (0.6 + 0.6 * burst * (1 - burst) * 4 + 0.3 * tween(frame, COMPOSER_AT, COMPOSER_AT + 20)),
        }}
      >
        {/* The pile of tools. */}
        {TOOLS.map((_, i) => {
          const p = PILE[i] ?? [0, 0, 0]
          const start = DROP_START + i * DROP_GAP
          const fall = sp(frame, start, SPRING.heavy)
          if (frame < start) return null
          const fromX = (rand(i + 3) - 0.5) * 700
          const fromRot = p[2] + (rand(i + 11) - 0.5) * 70
          let x = PILE_X + lerp(fromX, p[0], fall)
          let y = PILE_Y + lerp(-950, p[1], fall)
          let rot = lerp(fromRot, p[2], fall)
          let scale = 1
          let opacity = 1
          // Cards underneath get nudged by each one landing on top.
          const below = Math.max(0, Math.floor((frame - start - LAND) / DROP_GAP))
          y += below > 0 ? thud(frame) * 0.35 : 0
          if (frame >= COLLAPSE) {
            const a = anticipate(i)
            const c = collapseT(i)
            const dir = Math.atan2(p[1], p[0])
            x += Math.cos(dir) * 26 * a
            y += Math.sin(dir) * 26 * a
            scale = 1 + 0.04 * a
            x = lerp(x, 960, c)
            y = lerp(y, COMPOSER_Y, c)
            rot = lerp(rot, 0, c)
            scale = lerp(scale, 0.25, c)
            opacity = 1 - tween(frame, COLLAPSE + 34 + i * 2, COLLAPSE + 46 + i * 2)
          }
          if (opacity <= 0) return null
          return (
            <div
              key={TOOLS[i]?.name}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`,
                opacity,
                filter: frame >= COLLAPSE + 20 ? `blur(${collapseT(i) * 6}px)` : undefined,
              }}
            >
              <ToolCard i={i} />
            </div>
          )
        })}

        {/* The flash as everything collapses into one box. */}
        {burst > 0 && burst < 1 && (
          <div
            style={{
              position: 'absolute',
              left: 960 - 700 * burst,
              top: COMPOSER_Y - 260 * burst,
              width: 1400 * burst,
              height: 520 * burst,
              borderRadius: '50%',
              border: `1.5px solid rgba(255,179,26,${0.35 * (1 - burst)})`,
              boxShadow: `0 0 80px rgba(255,164,28,${0.5 * (1 - burst)})`,
            }}
          />
        )}

        {composerIn > 0.001 && (
          <div
            style={{
              position: 'absolute',
              left: 960 - 500,
              top: COMPOSER_Y - 80,
              opacity: clamp(composerIn * 1.5, 0, 1),
              transform: `scale(${lerp(0.6, 1.14, composerIn)})`,
            }}
          >
            <Composer width={1000} glow={0.7 + 0.6 * (1 - tween(frame, COMPOSER_AT, COMPOSER_AT + 60))} caret={Math.floor(frame / 30) % 2 === 0} placeholder="Ask for anything…" />
          </div>
        )}

        {/* The mascot's screen, becoming the mark. */}
        {morph < 1 && (
          <div
            style={{
              position: 'absolute',
              left: sx - 333,
              top: sy - 196,
              width: 666,
              transform: `scale(${sScale})`,
              opacity: 1 - tween(frame, LOCKUP_AT + 14, LOCKUP_AT + 34),
            }}
          >
            <LedScreen cell={30} boot={boot} eyes={openingEyes(frame)} />
          </div>
        )}
        {morph > 0 && (
          <div
            style={{
              position: 'absolute',
              left: lockupX,
              top: lockupY - tileSize / 2,
              opacity: tween(frame, LOCKUP_AT + 12, LOCKUP_AT + 30),
              transform: `scale(${lerp(1.15, 1, morph)})`,
            }}
          >
            <LogoTile size={tileSize} glow={1} eyes={{ blink, mood: frame < LOCKUP_AT + 40 ? 'happy' : 'open' }} />
          </div>
        )}

        {/* Wordmark, dots first. */}
        {frame >= LOCKUP_AT + 6 && (
          <svg
            width={1920}
            height={1080}
            style={{ position: 'absolute', left: 0, top: 0, opacity: 1 - solid }}
          >
            {word.dots.map(([dx, dy], k) => {
              const delay = LOCKUP_AT + 6 + (dx / word.width) * 30 + rand(k) * 10
              const t = sp(frame, delay, SPRING.snappy)
              const fromX = lockupX + tileSize / 2 + (rand(k + 99) - 0.5) * 60
              const fromY = lockupY + (rand(k + 199) - 0.5) * 50
              const x = lerp(fromX, wordLeft + dx * pitch + pitch / 2, t)
              const y = lerp(fromY, wordTop + dy * pitch + pitch / 2, t)
              return (
                <circle
                  key={`${dx}-${dy}`}
                  cx={x}
                  cy={y}
                  r={pitch * 0.36 * clamp(t * 1.4, 0, 1)}
                  fill={t < 0.95 ? C.wink : C.label}
                  opacity={clamp(t * 2, 0, 1)}
                />
              )
            })}
          </svg>
        )}
        {solid > 0 && (
          <div
            style={{
              position: 'absolute',
              left: wordLeft - 6,
              top: lockupY - 92,
              fontFamily: FONT,
              fontSize: 154,
              fontWeight: 700,
              letterSpacing: `${lerp(0.02, -0.045, solid)}em`,
              color: C.label,
              opacity: solid,
              filter: `blur(${(1 - solid) * 8}px)`,
              lineHeight: 1.2,
            }}
          >
            Myrmidon
          </div>
        )}

        <AbsoluteFill style={{ top: 316, height: 'auto', alignItems: 'center' }}>
          <Caption text="You use *ten* AI tools." start={102} end={318} size={88} />
        </AbsoluteFill>
        <AbsoluteFill style={{ top: 392, height: 'auto', alignItems: 'center' }}>
          <Caption text="What if *one chat* did all of it?" start={394} end={LOCKUP_AT - 6} size={84} />
        </AbsoluteFill>
      </Stage>
    </Shot>
  )
}
