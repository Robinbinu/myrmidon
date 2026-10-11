import { Audio, Sequence, staticFile } from 'remotion'
import { BEAT } from './timeline.ts'
import { TICK_AT } from './shots/Board.tsx'
import { landAt, MESSAGES } from './shots/Crew.tsx'
import { QUESTION } from './shots/Composer.tsx'
import { MESSAGE } from './shots/Ask.tsx'
import { FPS } from './theme.ts'
import manifest from './vo-manifest.json'
import { VO_LINES } from './vo.ts'

type Sfx =
  | 'key1'
  | 'key2'
  | 'key3'
  | 'click'
  | 'whoosh'
  | 'chime'
  | 'ping'
  | 'tick'
  | 'error'
  | 'shutter'
  | 'thud'
  | 'riser'
  | 'ring'
  | 'pickup'
  | 'hit'
  | 'sparkle'

interface Cue {
  sfx: Sfx
  at: number
  volume: number
}

/** A keystroke for each character typed at `cps` from `start`, skipping spaces, at a soft, slightly varied level. */
function typing(text: string, start: number, cps: number, volume: number, every = 1): Cue[] {
  const keys: Sfx[] = ['key1', 'key2', 'key3']
  const out: Cue[] = []
  for (let i = 0; i < text.length; i += every) {
    if (text[i] === ' ') continue
    out.push({ sfx: keys[(i * 7) % 3] ?? 'key1', at: Math.round(start + (i / cps) * FPS), volume: volume * (0.8 + ((i * 13) % 5) / 20) })
  }
  return out
}

/** Every sound effect in the film, with the frame it lands on. Synthesized by scripts/sfx.sh. */
const CUES: Cue[] = [
  // 1 · The scattered tools: tension rising into the throw, the cards gathering into the composer.
  { sfx: 'riser', at: 213, volume: 0.35 },
  { sfx: 'whoosh', at: 345, volume: 0.5 },
  { sfx: 'chime', at: BEAT.question + 2, volume: 0.28 },
  // 2 · The question typed, sent, and broken into the wordmark's dots.
  ...typing(QUESTION, BEAT.question + 25, 22, 0.35),
  { sfx: 'click', at: BEAT.wordmark, volume: 0.45 },
  { sfx: 'whoosh', at: BEAT.wordmark + 12, volume: 0.3 },
  { sfx: 'sparkle', at: BEAT.wordmark + 76, volume: 0.4 },
  { sfx: 'whoosh', at: BEAT.dock, volume: 0.3 },
  // 3 · The phone: in, typed, sent, and the bubble's flight into the chat.
  { sfx: 'whoosh', at: BEAT.phoneClose - 30, volume: 0.3 },
  ...typing(MESSAGE, BEAT.phoneClose, 40, 0.22),
  { sfx: 'click', at: BEAT.send, volume: 0.4 },
  { sfx: 'whoosh', at: BEAT.flight + 12, volume: 0.45 },
  { sfx: 'chime', at: BEAT.flight + 85, volume: 0.35 },
  // 4 · The plan, the crew spawning, and the three at work.
  { sfx: 'ping', at: BEAT.plan + 40, volume: 0.25 },
  { sfx: 'whoosh', at: BEAT.spawn + 12, volume: 0.45 },
  ...[0, 1, 2].map((i) => ({ sfx: 'tick' as const, at: landAt(i), volume: 0.2 })),
  ...typing('SELECT device, currency, conv_rate(ts) AS rate FROM checkout_events GROUP BY 1, 2', 1552, 46, 0.12, 3),
  { sfx: 'tick', at: 1606, volume: 0.3 },
  { sfx: 'click', at: 1650, volume: 0.3 },
  { sfx: 'tick', at: 1682, volume: 0.25 },
  { sfx: 'click', at: 1742, volume: 0.3 },
  { sfx: 'whoosh', at: BEAT.iris - 5, volume: 0.3 },
  ...[1776, 1792, 1812].map((at) => ({ sfx: 'tick' as const, at, volume: 0.15 })),
  { sfx: 'click', at: 1810, volume: 0.4 },
  { sfx: 'error', at: 1836, volume: 0.35 },
  { sfx: 'shutter', at: 1888, volume: 0.4 },
  { sfx: 'whoosh', at: BEAT.quill + 5, volume: 0.3 },
  { sfx: 'click', at: 2036, volume: 0.3 },
  ...typing('+ return Math.round(amount)', 2040, 70, 0.12, 2),
  { sfx: 'click', at: 2068, volume: 0.3 },
  ...[2082, 2088].map((at) => ({ sfx: 'tick' as const, at, volume: 0.25 })),
  { sfx: 'chime', at: 2128, volume: 0.3 },
  ...MESSAGES.map((m) => ({ sfx: 'ping' as const, at: m.at, volume: 0.3 })),
  // 5 · The pull back, the fold onto the board, the crew's mail, the reviewer, the stamp.
  { sfx: 'whoosh', at: BEAT.together, volume: 0.3 },
  { sfx: 'whoosh', at: BEAT.fold + 20, volume: 0.45 },
  ...[0, 1, 2, 3, 4].map((k) => ({ sfx: 'ping' as const, at: BEAT.fold + 90 + k * 30, volume: 0.15 })),
  ...TICK_AT.map((at) => ({ sfx: 'tick' as const, at, volume: 0.3 })),
  { sfx: 'riser', at: BEAT.stamp - 132, volume: 0.35 },
  { sfx: 'thud', at: BEAT.stamp, volume: 0.8 },
  // 6 · The verdict becomes the approval; Robin allows; the world falls away.
  { sfx: 'whoosh', at: BEAT.trust + 20, volume: 0.25 },
  { sfx: 'click', at: BEAT.allow, volume: 0.5 },
  { sfx: 'chime', at: BEAT.allow + 6, volume: 0.35 },
  { sfx: 'whoosh', at: BEAT.recede, volume: 0.4 },
  // 7 · The call.
  { sfx: 'ring', at: BEAT.call + 10, volume: 0.4 },
  { sfx: 'pickup', at: BEAT.answer, volume: 0.4 },
  // 8 · The waveform becomes the orbit; the chips flip; everything gathers into the end card.
  { sfx: 'whoosh', at: BEAT.waveOut, volume: 0.4 },
  ...Array.from({ length: 12 }, (_, i) => ({ sfx: 'tick' as const, at: BEAT.models + i * 4, volume: 0.08 })),
  { sfx: 'riser', at: BEAT.burst - 102, volume: 0.35 },
  { sfx: 'whoosh', at: BEAT.burst + 20, volume: 0.45 },
  // 9 · The mark lands; the star.
  { sfx: 'hit', at: BEAT.end + 64, volume: 0.75 },
  { sfx: 'sparkle', at: BEAT.end + 90, volume: 0.25 },
  { sfx: 'click', at: BEAT.star, volume: 0.35 },
]

/** Frames where a voice is speaking, so the effects under it can step back. */
const SPOKEN: [number, number][] = VO_LINES.flatMap((l) =>
  (manifest[l.id as keyof typeof manifest]?.speech ?? []).map(([a, b]) => [l.at + (a ?? 0) * FPS, l.at + (b ?? 0) * FPS] as [number, number]),
)
const under = (at: number) => SPOKEN.some(([a, b]) => at >= a - 6 && at <= b + 6)

/** The voice-over and the effects, each a sequence starting on its frame. The effects duck under the voice. */
export function Soundtrack() {
  return (
    <>
      {VO_LINES.map((l) => (
        <Sequence key={l.id} name={`vo ${l.id}`} from={l.at} layout="none">
          <Audio src={staticFile(`vo/${l.id}.mp3`)} volume={l.speaker === 'myrmidon' ? 0.9 : 1} />
        </Sequence>
      ))}
      {CUES.map((c, i) => (
        <Sequence key={`${c.sfx}-${c.at}-${i}`} name={c.sfx} from={c.at} layout="none">
          <Audio src={staticFile(`sfx/${c.sfx}.wav`)} volume={c.volume * (under(c.at) ? 0.55 : 1)} />
        </Sequence>
      ))}
    </>
  )
}
