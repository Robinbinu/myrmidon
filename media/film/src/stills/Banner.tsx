import { AbsoluteFill } from 'remotion'
import { rand } from '../anim.ts'
import { DotWord, LogoTile } from '../components/Led.tsx'
import { Stage } from '../components/Stage.tsx'
import { Cursor } from '../components/Ui.tsx'
import { C, CREW, FONT, MONO } from '../theme.ts'
import { Grain } from './kit.tsx'

export const BW = 2400
export const BH = 800
const HORIZON = 580

/**
 * The LED grid laid down as a floor running to a glowing horizon: rows of dots that close up and dim with distance,
 * the mascot's screen turned into a landscape.
 */
function DotHorizon() {
  const dots = []
  const rows = 34
  for (let r = 0; r < rows; r++) {
    // Depth z runs from 1 (the bottom edge) out to the horizon; perspective puts each row at HORIZON + depth / z.
    const z = 1 + r * 0.42
    const y = HORIZON + (BH - HORIZON + 14) / z
    const near = 1 / z
    const pitch = 96 * near
    const size = Math.max(1.3, 9 * near)
    const alpha = Math.min(0.62, 0.05 + near * 0.6)
    const count = Math.ceil(BW / pitch / 2) + 2
    for (let i = -count; i <= count; i++) {
      const x = BW / 2 + i * pitch
      if (x < -20 || x > BW + 20) continue
      // A few cells lit amber, like pixels the crew is working on.
      const lit = rand(r * 977 + i * 31) > 0.965 && r < 18
      dots.push(
        <rect
          key={`${r}:${i}`}
          x={x - size / 2}
          y={y - size / 2}
          width={size}
          height={size}
          rx={size * 0.3}
          fill={lit ? C.eyeTop : '#ffffff'}
          opacity={lit ? Math.min(1, alpha * 2.4) : alpha}
        />,
      )
    }
  }
  return (
    <svg
      width={BW}
      height={BH}
      style={{
        position: 'absolute',
        inset: 0,
        maskImage: `linear-gradient(180deg, transparent ${HORIZON - 8}px, black ${HORIZON + 70}px), linear-gradient(90deg, transparent 0%, black 22%, black 78%, transparent 100%)`,
        maskComposite: 'intersect',
      }}
    >
      {dots}
    </svg>
  )
}

/** A crew cursor drifting across the frame, with a dotted trail behind it. */
function Drifter(props: {
  who: keyof typeof CREW
  x: number
  y: number
  trail: string
  opacity?: number
  blur?: number
  size?: number
}) {
  const c = CREW[props.who]
  return (
    <>
      <svg width={BW} height={BH} style={{ position: 'absolute', inset: 0, opacity: (props.opacity ?? 1) * 0.5 }}>
        <defs>
          <linearGradient id={`tr${props.who}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={props.x} y2={props.y}>
            <stop offset="0.35" stopColor={c.color} stopOpacity="0" />
            <stop offset="1" stopColor={c.color} stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <path d={props.trail} fill="none" stroke={`url(#tr${props.who})`} strokeWidth="2.4" strokeDasharray="1 11" strokeLinecap="round" />
      </svg>
      <div style={{ opacity: props.opacity ?? 1, filter: props.blur ? `blur(${props.blur}px)` : undefined }}>
        <Cursor
          color={c.color}
          size={props.size ?? 46}
          tilt={-6}
          label={
            <span>
              {c.name}
              <span style={{ opacity: 0.6, fontWeight: 500 }}> · {c.role}</span>
            </span>
          }
          style={{ left: props.x, top: props.y }}
        />
      </div>
    </>
  )
}

/** The README's banner, 2400×800: the mark and the name, the line, and the crew drifting over an LED horizon. */
export function Banner() {
  return (
    <Stage drift={0} grid={0.55}>
      {/* The horizon's light: a wide, low amber haze where the floor meets the dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(1500px 260px at 50% ${HORIZON}px, rgba(255,164,28,0.2) 0%, rgba(255,164,28,0.06) 45%, transparent 75%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: 'radial-gradient(900px 420px at 50% 250px, rgba(255,164,28,0.07) 0%, transparent 70%)',
        }}
      />
      <DotHorizon />
      <div
        style={{
          position: 'absolute',
          left: BW * 0.18,
          right: BW * 0.18,
          top: HORIZON - 1,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(255,207,92,0.55) 30%, rgba(255,226,163,0.85) 50%, rgba(255,207,92,0.55) 70%, transparent)',
          filter: 'blur(0.6px)',
        }}
      />

      <Drifter who="nova" x={300} y={196} size={44} opacity={0.82} trail="M40 470 C 140 380, 200 260, 300 196" />
      <Drifter who="quill" x={1980} y={150} size={40} opacity={0.78} blur={0.4} trail="M2330 330 C 2220 300, 2120 200, 1980 150" />
      <Drifter who="iris" x={2010} y={500} size={50} opacity={0.9} trail="M2380 690 C 2250 640, 2120 540, 2010 500" />

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 104,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          fontFamily: FONT,
          color: C.label,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 44 }}>
          <LogoTile size={176} glow={1.3} />
          <DotWord text="Myrmidon" width={940} />
        </div>
        <div style={{ marginTop: 50, fontSize: 70, fontWeight: 640, letterSpacing: '-0.04em', lineHeight: 1 }}>
          One chat. <span style={{ color: C.wink }}>A whole crew of AI agents.</span>
        </div>
        <div
          style={{
            marginTop: 40,
            display: 'flex',
            alignItems: 'center',
            gap: 22,
            fontFamily: MONO,
            fontSize: 34,
            letterSpacing: '0.02em',
            color: C.label2,
          }}
        >
          <span>Free and open source</span>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: C.accent, boxShadow: `0 0 10px ${C.glow}` }} />
          <span>Runs on your Mac</span>
        </div>
      </div>
      <Grain opacity={0.045} />
    </Stage>
  )
}
