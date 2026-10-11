import { Code2, Star } from 'lucide-react'
import { clamp, EASES, lerp, sp, SPRING, tween } from '../anim.ts'
import { type EyeState, LogoTile } from '../components/Led.tsx'
import { Chip } from '../components/Surface.tsx'
import { fitSize, T } from '../components/Text.tsx'
import { Wordmark, WORDMARK_COLS, WORDMARK_ROWS } from '../components/Wordmark.tsx'
import { SAFE, SPACE, TYPE } from '../design.ts'
import { BEAT, END, FILM_FRAMES } from '../timeline.ts'
import { C, W } from '../theme.ts'
import { dotLanded } from './Reach.tsx'

export const REPO = 'github.com/Robinbinu/myrmidon'
const TAGLINE = 'One chat. A whole crew.'

function markEyes(f: number): EyeState {
  const t = f - BEAT.end
  if (t < 70) return { mood: 'closed' }
  if (t >= 150 && t < 157) return { blink: true }
  if (t >= 200 && t < 250) return { look: [1, 0] }
  if (t >= 290 && t < 330) return { mood: 'wink' }
  return {}
}

/**
 * Beat 9: the dots land and MYRMIDON lights on its grid, then the line, what it is, and where to get it. Fully
 * composed 3 s after the dots land and held to the end.
 */
export function End(props: { f: number }) {
  const f = props.f
  if (f < BEAT.burst + 10) return null
  const breathe = 0.85 + 0.15 * Math.sin(f / 22)
  // A slow light passing across the lit dots once the card is composed.
  const sweep = tween(f, BEAT.star + 50, BEAT.star + 120, -0.2, 1.2, EASES.inOut)
  const words = TAGLINE.split(' ')
  const size = fitSize(TAGLINE, 'display', W - SAFE.x * 2)
  const sub = sp(f, BEAT.end + 116, SPRING.smooth)
  const pills = sp(f, BEAT.end + 142, SPRING.smooth)
  const star = f >= BEAT.star ? Math.sin(clamp((f - BEAT.star) / 26, 0, 1) * Math.PI) : 0
  const push = lerp(1, 1.015, tween(f, BEAT.end, FILM_FRAMES, 0, 1, EASES.inOut))
  // The mark lands as the last dots do, and comes alive: a look, a blink, a wink.
  const mark = sp(f, BEAT.end + 64, SPRING.pop)
  return (
    <div style={{ position: 'absolute', inset: 0, transform: `scale(${push})` }}>
      <div
        style={{
          position: 'absolute',
          left: END.logo.x - END.logo.size / 2,
          top: END.y - END.logo.size / 2,
          opacity: clamp(mark * 1.6, 0, 1),
          transform: `scale(${lerp(0.4, 1, mark)}) rotate(${(1 - mark) * -12}deg)`,
        }}
      >
        <LogoTile size={END.logo.size} glow={1.2 * breathe} eyes={markEyes(f)} />
      </div>
      <div style={{ position: 'absolute', left: END.x - (WORDMARK_COLS * END.pitch) / 2, top: END.y - (WORDMARK_ROWS * END.pitch) / 2 }}>
        <Wordmark
          pitch={END.pitch}
          grid={tween(f, BEAT.burst + 20, BEAT.burst + 60)}
          glow={breathe}
          lit={(k) => (dotLanded(k, f) ? 1 : 0)}
          sweep={sweep}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: SAFE.x,
          right: SAFE.x,
          top: 560,
          display: 'flex',
          justifyContent: 'center',
          columnGap: size * 0.26,
          ...TYPE.display,
          fontSize: size,
          color: C.label,
          whiteSpace: 'nowrap',
        }}
      >
        {words.map((w, i) => {
          const t = sp(f, BEAT.end + 80 + i * 5, SPRING.snappy)
          return (
            <span
              key={w}
              data-t=""
              style={{
                display: 'inline-block',
                opacity: clamp(t * 1.3, 0, 1),
                transform: `translateY(${(1 - t) * 40}px)`,
                filter: t < 0.95 ? `blur(${(1 - t) * 10}px)` : undefined,
                color: i >= 2 ? C.accent : undefined,
              }}
            >
              {w}
            </span>
          )
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 690, display: 'flex', justifyContent: 'center', opacity: sub, transform: `translateY(${(1 - sub) * 16}px)` }}>
        <T role="heading" weight="regular" color={C.label3}>
          Free and open source · Runs on your Mac
        </T>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 784, display: 'flex', justifyContent: 'center', gap: SPACE[4], opacity: pills, transform: `translateY(${(1 - pills) * 20}px)` }}>
        <Chip big mono icon={Code2}>
          {REPO}
        </Chip>
        <Chip
          big
          tone="accent"
          icon={Star}
          style={{
            transform: `scale(${1 + star * 0.08})`,
            boxShadow: `0 0 0 ${star * 14}px rgba(255,179,26,0.2), 0 12px 36px -10px rgba(255,179,26,0.6)`,
          }}
        >
          Star
        </Chip>
      </div>
    </div>
  )
}
