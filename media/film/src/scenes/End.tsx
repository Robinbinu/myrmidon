import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { SPRING, clamp, lerp, sp, tween } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon } from '../components/Icon.tsx'
import { type EyeState, LogoTile } from '../components/Led.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { C, FONT, MONO } from '../theme.ts'

export const REPO = 'github.com/Robinbinu/myrmidon'

function endEyes(frame: number): EyeState {
  if (frame < 10) return { mood: 'closed' }
  if (frame >= 150 && frame < 157) return { blink: true }
  if (frame >= 196 && frame < 250) return { look: [1, 0] }
  if (frame >= 278 && frame < 310) return { mood: 'wink' }
  return {}
}

export function End(props: { dur: number }) {
  const frame = useCurrentFrame()
  const tile = sp(frame, 0, SPRING.pop)
  const word = 'Myrmidon'
  const sub = sp(frame, 46, SPRING.smooth)
  const pills = sp(frame, 62, SPRING.smooth)
  const star = sp(frame, 120, SPRING.pop)
  const breathe = 0.85 + 0.15 * Math.sin(frame / 22)
  return (
    <Shot dur={props.dur} outFrames={24}>
      <Stage glow={{ x: 960, y: 440, strength: 1.2 * breathe, size: 1300 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 250, height: 200, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 44 }}>
          <div style={{ transform: `scale(${lerp(0.4, 1, tile)}) rotate(${(1 - tile) * -10}deg)`, opacity: clamp(tile * 2, 0, 1) }}>
            <LogoTile size={196} glow={1.2 * breathe} eyes={endEyes(frame)} />
          </div>
          <div style={{ display: 'flex', fontFamily: FONT, fontSize: 176, fontWeight: 700, letterSpacing: '-0.05em', color: C.label, lineHeight: 1 }}>
            {[...word].map((ch, i) => {
              const t = sp(frame, 6 + i * 2.5, SPRING.snappy)
              return (
                <span
                  key={`${ch}${i}`}
                  style={{
                    display: 'inline-block',
                    opacity: clamp(t * 1.4, 0, 1),
                    transform: `translateY(${(1 - t) * 70}px)`,
                    filter: t < 0.95 ? `blur(${(1 - t) * 10}px)` : undefined,
                  }}
                >
                  {ch}
                </span>
              )
            })}
          </div>
        </div>

        <AbsoluteFill style={{ top: 520, height: 'auto', alignItems: 'center' }}>
          <Caption text="One chat. *A whole crew.*" start={24} end={props.dur + 60} size={84} />
        </AbsoluteFill>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 650,
            textAlign: 'center',
            fontFamily: FONT,
            fontSize: 32,
            color: C.label3,
            letterSpacing: '-0.01em',
            opacity: sub,
            transform: `translateY(${(1 - sub) * 20}px)`,
          }}
        >
          Free and open source · Runs on your Mac
        </div>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 754,
            display: 'flex',
            justifyContent: 'center',
            gap: 16,
            opacity: pills,
            transform: `translateY(${(1 - pills) * 24}px)`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              height: 72,
              padding: '0 30px 0 24px',
              borderRadius: 999,
              background: '#141418',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.14)',
              fontFamily: MONO,
              fontSize: 28,
              color: C.label,
            }}
          >
            <Icon name="code" size={28} color={C.label3} />
            {REPO}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              height: 72,
              padding: '0 30px 0 24px',
              borderRadius: 999,
              background: C.accent,
              color: '#1a1204',
              fontFamily: FONT,
              fontSize: 28,
              fontWeight: 700,
              boxShadow: `0 0 0 ${tween(frame, 120, 160) < 1 ? (1 - tween(frame, 120, 160)) * 14 * star : 0}px rgba(255,179,26,0.25), 0 12px 36px -10px rgba(255,179,26,0.6)`,
              transform: `scale(${1 + Math.sin(clamp((frame - 120) / 24, 0, 1) * Math.PI) * 0.08})`,
            }}
          >
            <Icon name="star" size={28} color="#1a1204" fill="#1a1204" stroke={1.2} />
            Star
          </div>
        </div>
      </Stage>
    </Shot>
  )
}
