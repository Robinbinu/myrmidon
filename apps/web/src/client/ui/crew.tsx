import { identityOf } from '@myrmidon/protocol'
import { motion, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { AVATARS, lookSpring } from '../ui-config.ts'
import { usePersona } from './avatar-bag.ts'
import type { Accessory, BodyShape, Persona } from './personas.ts'
import { type Mood, moodFor, Snore, useAgentMood } from './pixel.tsx'

/*
 * Crewmate characters: a plain rounded shape in the agent's colour with ink eyes, drawn in a 100×100 box, each
 * wearing one of the personas in personas.ts (its eyes, mouth, extras and the way it moves). Each body declares where
 * its eyes sit, where the top of its head is (for hats and sprouts), and how wide it is at the eyes.
 */
interface Body {
  draw: (fill: string) => ReactNode
  eyeY: number
  eyeGap: number
  /** The top of the head at its middle. */
  top: number
  /** Half its width at the eyes. */
  side: number
  mouthY?: number
  /** Where a scarf goes: its height and half its width there. */
  neck?: readonly [number, number]
}

const SHINE = 'var(--character-shine)'
const INK = 'var(--character-ink)'
const GOLD = 'var(--character-gold)'
const LEAF = 'var(--character-leaf)'
const BOW = 'var(--character-bow)'
const BLUSH = 'var(--character-blush)'

/** A rounded star's points, drawn with round joins so its tips stay soft. */
const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 === 0 ? 40 : 19
  const a = ((-90 + i * 36) * Math.PI) / 180
  return `${(50 + r * Math.cos(a)).toFixed(1)},${(56 + r * Math.sin(a)).toFixed(1)}`
}).join(' ')

const BODIES: Record<BodyShape, Body> = {
  gumdrop: {
    draw: (fill) => (
      <path
        d="M50 8C57 8 62 14 67 24L87 66C93 80 86 93 70 93H30C14 93 7 80 13 66L33 24C38 14 43 8 50 8Z"
        fill={fill}
      />
    ),
    eyeY: 60,
    eyeGap: 20,
    top: 9,
    side: 30,
    neck: [82, 34],
  },
  ball: {
    draw: (fill) => <circle cx="50" cy="54" r="40" fill={fill} />,
    eyeY: 50,
    eyeGap: 20,
    top: 14,
    side: 40,
    neck: [80, 28],
  },
  cloud: {
    draw: (fill) => (
      <path
        d="M27 84C13 84 7 73 10 63C12 54 19 50 25 50C25 37 37 28 50 30C57 21 75 22 79 35C91 37 95 51 89 61C95 72 88 84 75 84Z"
        fill={fill}
      />
    ),
    eyeY: 58,
    eyeGap: 20,
    top: 27,
    side: 38,
    neck: [78, 34],
  },
  heart: {
    draw: (fill) => (
      <path
        d="M50 88C30 74 10 61 11 41C12 27 25 18 37 21C44 23 48 28 50 33C52 28 56 23 63 21C75 18 88 27 89 41C90 61 70 74 50 88Z"
        fill={fill}
      />
    ),
    eyeY: 47,
    eyeGap: 24,
    top: 31,
    side: 36,
    neck: [70, 22],
  },
  squircle: {
    draw: (fill) => <rect x="12" y="16" width="76" height="76" rx="30" fill={fill} />,
    eyeY: 52,
    eyeGap: 20,
    top: 16,
    side: 38,
    neck: [78, 34],
  },
  pill: {
    draw: (fill) => <rect x="24" y="8" width="52" height="86" rx="26" fill={fill} />,
    eyeY: 40,
    eyeGap: 18,
    top: 8,
    side: 26,
    mouthY: 53,
    neck: [66, 26],
  },
  bunny: {
    draw: (fill) => (
      <g fill={fill}>
        <ellipse cx="36" cy="25" rx="8.5" ry="20" transform="rotate(-12 36 25)" />
        <ellipse cx="64" cy="25" rx="8.5" ry="20" transform="rotate(12 64 25)" />
        <ellipse cx="50" cy="63" rx="35" ry="30" />
      </g>
    ),
    eyeY: 61,
    eyeGap: 20,
    top: 34,
    side: 35,
    neck: [82, 27],
  },
  flower: {
    draw: (fill) => (
      <g fill={fill}>
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <circle
            key={a}
            cx={50 + 24 * Math.cos((a * Math.PI) / 180)}
            cy={54 + 24 * Math.sin((a * Math.PI) / 180)}
            r="17"
          />
        ))}
        <circle cx="50" cy="54" r="27" />
      </g>
    ),
    eyeY: 53,
    eyeGap: 20,
    top: 13,
    side: 40,
  },
  ghost: {
    draw: (fill) => (
      <path
        d="M50 10C72 10 86 26 86 48V86C86 90 82 92 79 89L72 82L64 90C62 92 59 92 57 90L50 83L43 90C41 92 38 92 36 90L28 82L21 89C18 92 14 90 14 86V48C14 26 28 10 50 10Z"
        fill={fill}
      />
    ),
    eyeY: 44,
    eyeGap: 20,
    top: 10,
    side: 36,
    neck: [70, 36],
  },
  cat: {
    draw: (fill) => (
      <g fill={fill}>
        <path d="M18 44L21 13C21.5 8 26 6.5 29.5 10L46 28Z" />
        <path d="M82 44L79 13C78.5 8 74 6.5 70.5 10L54 28Z" />
        <ellipse cx="50" cy="59" rx="37" ry="33" />
      </g>
    ),
    eyeY: 56,
    eyeGap: 22,
    top: 26,
    side: 36,
    neck: [84, 26],
  },
  bear: {
    draw: (fill) => (
      <g fill={fill}>
        <circle cx="25" cy="26" r="12" />
        <circle cx="75" cy="26" r="12" />
        <circle cx="50" cy="56" r="36" />
      </g>
    ),
    eyeY: 54,
    eyeGap: 22,
    top: 20,
    side: 36,
    neck: [80, 27],
  },
  egg: {
    draw: (fill) => (
      <path d="M50 8C70 8 84 38 84 60C84 80 69 93 50 93C31 93 16 80 16 60C16 38 30 8 50 8Z" fill={fill} />
    ),
    eyeY: 58,
    eyeGap: 20,
    top: 8,
    side: 33,
    neck: [82, 28],
  },
  bean: {
    draw: (fill) => (
      <path
        d="M30 14C44 8 54 20 64 20C78 20 90 30 90 52C90 76 72 92 50 92C26 92 10 76 10 52C10 32 18 19 30 14Z"
        fill={fill}
      />
    ),
    eyeY: 52,
    eyeGap: 22,
    top: 17,
    side: 40,
    neck: [80, 32],
  },
  drop: {
    draw: (fill) => (
      <path d="M50 6C56 20 84 44 84 64C84 82 69 94 50 94C31 94 16 82 16 64C16 44 44 20 50 6Z" fill={fill} />
    ),
    eyeY: 64,
    eyeGap: 20,
    top: 8,
    side: 33,
    neck: [84, 28],
  },
  mushroom: {
    draw: (fill) => (
      <g>
        <rect x="29" y="48" width="42" height="46" rx="16" fill={fill} />
        <path
          d="M8 50C8 26 28 10 50 10C72 10 92 26 92 50C92 56 88 58 82 58H18C12 58 8 56 8 50Z"
          fill={fill}
        />
        <g style={{ fill: SHINE, stroke: 'none' }} opacity="0.55">
          <circle cx="32" cy="32" r="6" />
          <circle cx="58" cy="22" r="4.5" />
          <circle cx="72" cy="40" r="5" />
        </g>
      </g>
    ),
    eyeY: 72,
    eyeGap: 18,
    top: 10,
    side: 21,
    mouthY: 83,
  },
  jelly: {
    draw: (fill) => (
      <g>
        <path
          d="M30 66q-5 10 0 20M50 66q5 10 0 22M70 66q-5 10 0 20"
          fill="none"
          stroke={fill}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M12 58C12 32 30 14 50 14C70 14 88 32 88 58C88 64 84 68 78 68H22C16 68 12 64 12 58Z"
          fill={fill}
        />
      </g>
    ),
    eyeY: 44,
    eyeGap: 22,
    top: 14,
    side: 38,
    mouthY: 56,
  },
  frog: {
    draw: (fill) => (
      <g fill={fill}>
        <circle cx="30" cy="36" r="15" />
        <circle cx="70" cy="36" r="15" />
        <ellipse cx="50" cy="63" rx="41" ry="29" />
      </g>
    ),
    eyeY: 35,
    eyeGap: 40,
    top: 36,
    side: 40,
    mouthY: 64,
    neck: [86, 26],
  },
  owl: {
    draw: (fill) => (
      <path
        d="M20 30L16 10L36 22C40 20 45 19 50 19C55 19 60 20 64 22L84 10L80 30C86 38 88 48 88 58C88 80 71 94 50 94C29 94 12 80 12 58C12 48 14 38 20 30Z"
        fill={fill}
      />
    ),
    eyeY: 50,
    eyeGap: 26,
    top: 20,
    side: 38,
    neck: [84, 28],
  },
  star: {
    draw: (fill) => (
      <polygon points={STAR_POINTS} fill={fill} stroke={fill} strokeWidth="12" strokeLinejoin="round" />
    ),
    eyeY: 56,
    eyeGap: 16,
    top: 12,
    side: 22,
  },
  blob: {
    draw: (fill) => (
      <path
        d="M52 12C70 10 88 22 88 44C88 58 94 70 86 82C78 94 60 92 48 92C30 92 12 86 12 64C12 50 20 46 22 34C24 20 36 13 52 12Z"
        fill={fill}
      />
    ),
    eyeY: 50,
    eyeGap: 20,
    top: 12,
    side: 36,
    neck: [80, 34],
  },
  dumpling: {
    draw: (fill) => (
      <g fill={fill}>
        <path d="M40 34Q44 18 50 18Q56 18 60 34Z" />
        <path d="M10 66C10 46 28 30 50 30C72 30 90 46 90 66C90 82 76 90 50 90C24 90 10 82 10 66Z" />
      </g>
    ),
    eyeY: 60,
    eyeGap: 22,
    top: 30,
    side: 39,
    mouthY: 72,
  },
}

const shadeOf = (fill: string, ink = 38) => `color-mix(in srgb, ${fill} ${100 - ink}%, ${INK})`

type Look = readonly [number, number]

/** The eyes, by the persona's kind: open ones look about and blink; moods turn them into simple expressions. */
function Eyes(props: { body: Body; persona: Persona; mood: Mood; blink: boolean; look: Look }) {
  const { body, mood, persona } = props
  const kind = persona.eyes
  const xs = kind === 'cyclops' ? [50] : [50 - body.eyeGap / 2, 50 + body.eyeGap / 2]
  const y = body.eyeY
  const stroke = { stroke: INK, strokeWidth: 4, strokeLinecap: 'round', fill: 'none' } as const
  if (kind === 'shades') return <Shades body={body} />
  if (mood === 'happy' || mood === 'love') {
    return (
      <g style={stroke}>
        {xs.map((x) => (
          <path key={x} d={`M${x - 5} ${y + 2}Q${x} ${y - 5} ${x + 5} ${y + 2}`} />
        ))}
      </g>
    )
  }
  if (mood === 'error') {
    // Soft eyes squeeze shut (> <); the rest go to crosses.
    const squint = kind === 'sleepy' || kind === 'worried' || kind === 'dot'
    return (
      <g style={stroke}>
        {xs.map((x, i) => (
          <path
            key={x}
            d={
              squint
                ? i === 0
                  ? `M${x - 4} ${y - 4}L${x + 3} ${y}L${x - 4} ${y + 4}`
                  : `M${x + 4} ${y - 4}L${x - 3} ${y}L${x + 4} ${y + 4}`
                : `M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`
            }
          />
        ))}
        {kind === 'worried' && <Brows xs={xs} y={y} worried />}
      </g>
    )
  }
  if (mood === 'sleep') {
    return (
      <g style={stroke}>
        {xs.map((x) => (
          <path key={x} d={`M${x - 4.5} ${y + 1}H${x + 4.5}`} />
        ))}
      </g>
    )
  }
  const size: Record<string, readonly [number, number]> = {
    capsule: [7, 12],
    brows: [7, 12],
    worried: [7, 12],
    lashes: [7, 12],
    dot: [8, 8],
    tall: [6, 16],
    wide: [10, 9],
    sleepy: [8, 6],
    big: [10, 13],
    ring: [4.5, 4.5],
    cyclops: [12, 14],
  }
  const [w, full] = size[kind] ?? [7, 12]
  const h = props.blink ? 2 : mood === 'waiting' ? Math.max(3, full / 2) : full
  // Sleepy eyes sit low under heavy lids.
  const dy = kind === 'sleepy' ? 2 : 0
  const [lx, ly] = props.look
  return (
    <g>
      {kind === 'ring' &&
        xs.map((x) => (
          <circle key={`r${x}`} cx={x} cy={y} r="6" style={{ fill: SHINE, stroke: INK, strokeWidth: 3 }} />
        ))}
      <g style={{ fill: INK }}>
        {xs.map((x) => (
          <motion.rect
            key={x}
            width={w}
            rx={Math.min(w, h) / 2}
            initial={false}
            animate={{
              x: x - w / 2 + lx * (kind === 'ring' ? 0.5 : 1),
              y: y + dy - h / 2 + ly * (kind === 'ring' ? 0.5 : 1),
              height: h,
            }}
            transition={lookSpring}
          />
        ))}
      </g>
      {(kind === 'big' || kind === 'cyclops') && !props.blink && (
        <g style={{ fill: SHINE }}>
          {xs.map((x) => (
            <circle
              key={`g${x}`}
              cx={x + w * 0.22 + lx}
              cy={y - full * 0.22 + ly}
              r={kind === 'cyclops' ? 2.4 : 1.8}
            />
          ))}
        </g>
      )}
      {kind === 'brows' && <Brows xs={xs} y={y} />}
      {kind === 'worried' && <Brows xs={xs} y={y} worried />}
      {kind === 'lashes' && (
        <g style={{ stroke: INK, strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' }}>
          {xs.map((x, i) => {
            const out = i === 0 ? -1 : 1
            return <path key={x} d={`M${x + out * 3} ${y - 5}L${x + out * 7} ${y - 8}`} />
          })}
        </g>
      )}
    </g>
  )
}

/** Determined brows lean in toward the nose; worried ones rise toward it. */
function Brows(props: { xs: number[]; y: number; worried?: boolean }) {
  return (
    <g style={{ stroke: INK, strokeWidth: 3, strokeLinecap: 'round', fill: 'none' }}>
      {props.xs.map((x, i) => {
        const inner = i === 0 ? 1 : -1
        const [a, b] = props.worried ? [-8, -11.5] : [-11.5, -8]
        return <path key={x} d={`M${x - inner * 5} ${props.y + a}L${x + inner * 4} ${props.y + b}`} />
      })}
    </g>
  )
}

function Shades(props: { body: Body }) {
  const { body } = props
  const half = body.eyeGap / 2 + 8
  return (
    <g>
      <rect x={50 - half} y={body.eyeY - 6} width={half * 2} height="12" rx="6" style={{ fill: INK }} />
      <path
        d={`M${50 - half + 5} ${body.eyeY - 2}H${50 - half + 11}`}
        style={{ stroke: SHINE, strokeWidth: 2, strokeLinecap: 'round' }}
        opacity="0.7"
      />
    </g>
  )
}

/** The mouth the persona rests with, changed by mood: a grin when done, a wobble when something broke. */
function Mouth(props: { body: Body; persona: Persona; mood: Mood }) {
  const { body, persona, mood } = props
  const rest = persona.mouth
  const kind =
    mood === 'happy' || mood === 'love'
      ? rest === 'none' || rest === 'flat' || rest === 'o'
        ? 'smile'
        : 'grin'
      : mood === 'error'
        ? rest === 'none'
          ? 'none'
          : 'wavy'
        : mood === 'thinking'
          ? rest === 'none'
            ? 'none'
            : 'hmm'
          : rest
  if (kind === 'none' || persona.accessories.includes('mustache')) return null
  const x = 50
  const y = body.mouthY ?? body.eyeY + 13
  const line = {
    stroke: INK,
    strokeWidth: 3.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  } as const
  switch (kind) {
    case 'smile':
      return <path d={`M${x - 4.5} ${y}Q${x} ${y + 4.5} ${x + 4.5} ${y}`} style={line} />
    case 'grin':
      return <path d={`M${x - 6} ${y - 1}Q${x} ${y + 9} ${x + 6} ${y - 1}Z`} style={{ fill: INK }} />
    case 'o':
      return <ellipse cx={x} cy={y + 1} rx="2.6" ry="3.2" style={{ fill: INK }} />
    case 'cat':
      return <path d={`M${x - 6} ${y}q3 3.5 6 0q3 3.5 6 0`} style={line} />
    case 'fang':
      return (
        <g>
          <path d={`M${x - 5} ${y}Q${x} ${y + 4.5} ${x + 5} ${y}`} style={line} />
          <path d={`M${x + 0.5} ${y + 2.6}l1.8 3.4l1.8 -3.8Z`} style={{ fill: SHINE }} />
        </g>
      )
    case 'flat':
      return <path d={`M${x - 4} ${y + 1}H${x + 4}`} style={line} />
    case 'wavy':
      return <path d={`M${x - 6} ${y + 1}q1.5 -2.5 3 0t3 0t3 0t3 0`} style={line} />
    case 'hmm':
      return <path d={`M${x - 1} ${y + 1}H${x + 5}`} style={line} />
    default:
      return null
  }
}

/** The persona's extras, in the same flat style as the body. */
function Extra(props: { body: Body; kind: Accessory; fill: string }) {
  const { body, fill } = props
  const top = body.top
  const xs = [50 - body.eyeGap / 2, 50 + body.eyeGap / 2] as const
  const y = body.eyeY
  const shade = shadeOf(fill)
  const ink = { stroke: INK, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  switch (props.kind) {
    case 'sprout':
      return (
        <g>
          <path d={`M50 ${top + 2}V${top - 9}`} style={{ ...ink, stroke: LEAF, strokeWidth: 3 }} />
          <ellipse
            cx="44"
            cy={top - 9}
            rx="6"
            ry="3"
            transform={`rotate(-28 44 ${top - 9})`}
            style={{ fill: LEAF }}
          />
          <ellipse
            cx="56"
            cy={top - 12}
            rx="6"
            ry="3"
            transform={`rotate(28 56 ${top - 12})`}
            style={{ fill: LEAF }}
          />
        </g>
      )
    case 'antenna':
      return (
        <g>
          <path d={`M50 ${top + 2}V${top - 11}`} style={{ ...ink, strokeWidth: 2.6 }} />
          <circle cx="50" cy={top - 14} r="4.2" style={{ fill: GOLD }} />
        </g>
      )
    case 'bow': {
      const bx = 50 + body.side * 0.55
      const by = top + 8
      return (
        <g style={{ fill: BOW }}>
          <path d={`M${bx} ${by}l-10 -7v14Z`} strokeLinejoin="round" />
          <path d={`M${bx} ${by}l10 -7v14Z`} strokeLinejoin="round" />
          <circle cx={bx} cy={by} r="3" style={{ fill: shadeOf('var(--character-bow)', 25) }} />
        </g>
      )
    }
    case 'beanie': {
      const w = Math.min(body.side, 30)
      return (
        <g>
          <path
            d={`M${50 - w} ${top + 13}Q${50 - w} ${top - 7} 50 ${top - 7}Q${50 + w} ${top - 7} ${50 + w} ${top + 13}Z`}
            style={{ fill: shade }}
          />
          <rect
            x={50 - w - 2}
            y={top + 8}
            width={w * 2 + 4}
            height="7"
            rx="3.5"
            style={{ fill: shadeOf(fill, 22) }}
          />
          <circle cx="50" cy={top - 9} r="4.5" style={{ fill: shadeOf(fill, 22) }} />
        </g>
      )
    }
    case 'horns':
      return (
        <g style={{ fill: shade }}>
          {xs.map((x, i) => {
            const out = i === 0 ? -1 : 1
            const hx = x + out * 3
            const hy = y - 23
            return (
              <path
                key={x}
                d={`M${hx - 4} ${hy + 3}Q${hx + out * 2} ${hy - 12} ${hx + out * 7} ${hy - 13}Q${hx + out * 3} ${hy - 5} ${hx + 4} ${hy + 3}Z`}
              />
            )
          })}
        </g>
      )
    case 'halo':
      return (
        <ellipse
          cx="50"
          cy={top - 9}
          rx="15"
          ry="4.2"
          style={{ fill: 'none', stroke: GOLD, strokeWidth: 3 }}
        />
      )
    case 'glasses':
      return (
        <g style={{ ...ink, strokeWidth: 2.4 }}>
          {xs.map((x) => (
            <circle key={x} cx={x} cy={y} r="8.5" />
          ))}
          <path d={`M${xs[0] + 8.5} ${y - 1}Q50 ${y - 4} ${xs[1] - 8.5} ${y - 1}`} />
        </g>
      )
    case 'headphones': {
      const s = body.side
      return (
        <g>
          <path
            d={`M${50 - s + 3} ${y - 4}C${50 - s} ${top - 12} ${50 + s} ${top - 12} ${50 + s - 3} ${y - 4}`}
            style={{ ...ink, strokeWidth: 4 }}
          />
          <rect x={50 - s - 5} y={y - 10} width="10" height="18" rx="5" style={{ fill: INK }} />
          <rect x={50 + s - 5} y={y - 10} width="10" height="18" rx="5" style={{ fill: INK }} />
        </g>
      )
    }
    case 'crown':
      return (
        <path
          d={`M38 ${top + 4}L36 ${top - 10}L44 ${top - 3}L50 ${top - 14}L56 ${top - 3}L64 ${top - 10}L62 ${top + 4}Z`}
          style={{ fill: GOLD, stroke: GOLD, strokeWidth: 2, strokeLinejoin: 'round' }}
        />
      )
    case 'blush':
      return (
        <g style={{ fill: BLUSH }} opacity="0.55">
          <ellipse cx={xs[0] - 5} cy={y + 9} rx="5" ry="3" />
          <ellipse cx={xs[1] + 5} cy={y + 9} rx="5" ry="3" />
        </g>
      )
    case 'freckles':
      return (
        <g style={{ fill: shade }}>
          {[xs[0] - 6, xs[1] + 6].flatMap((cx) =>
            [
              [-2.5, 8],
              [2, 7],
              [0, 11],
            ].map(([dx, dy]) => (
              <circle key={`${cx}${dx}${dy}`} cx={cx + (dx ?? 0)} cy={y + (dy ?? 0)} r="1.3" />
            )),
          )}
        </g>
      )
    case 'mustache': {
      const my = (body.mouthY ?? y + 13) - 1
      return (
        <path
          d={`M50 ${my}C47 ${my - 4} 40 ${my - 4} 37 ${my + 1}C41 ${my} 45 ${my + 2} 50 ${my}C55 ${my + 2} 59 ${my} 63 ${my + 1}C60 ${my - 4} 53 ${my - 4} 50 ${my}Z`}
          style={{ fill: INK }}
        />
      )
    }
    case 'scarf': {
      const [ny, half] = body.neck ?? [y + 24, body.side * 0.7]
      return (
        <g>
          <rect x={50 - half} y={ny - 4} width={half * 2} height="8" rx="4" style={{ fill: BOW }} />
          <rect
            x={50 + half * 0.35}
            y={ny}
            width="7"
            height="13"
            rx="3"
            transform={`rotate(-14 ${50 + half * 0.35} ${ny})`}
            style={{ fill: shadeOf('var(--character-bow)', 22) }}
          />
        </g>
      )
    }
    case 'monocle':
      return (
        <g style={{ fill: 'none', stroke: GOLD, strokeLinecap: 'round' }}>
          <circle cx={xs[1]} cy={y} r="8.5" strokeWidth="2.6" />
          <path
            d={`M${xs[1] + 6} ${y + 6}Q${xs[1] + 12} ${y + 14} ${xs[1] + 8} ${y + 24}`}
            strokeWidth="1.4"
          />
        </g>
      )
    case 'flower': {
      const fx = 50 - body.side * 0.62
      const fy = top + 9
      return (
        <g>
          <g style={{ fill: BOW }}>
            {[0, 72, 144, 216, 288].map((a) => (
              <circle
                key={a}
                cx={fx + 4.2 * Math.cos((a * Math.PI) / 180)}
                cy={fy + 4.2 * Math.sin((a * Math.PI) / 180)}
                r="3.4"
              />
            ))}
          </g>
          <circle cx={fx} cy={fy} r="2.6" style={{ fill: GOLD }} />
        </g>
      )
    }
    case 'tuft':
      return (
        <g style={{ ...ink, stroke: shade, strokeWidth: 3 }}>
          <path d={`M50 ${top + 3}q-2 -8 -9 -10`} />
          <path d={`M50 ${top + 3}q0 -8 1 -13`} />
          <path d={`M50 ${top + 3}q3 -7 9 -9`} />
        </g>
      )
    case 'party':
      return (
        <g>
          <path
            d={`M41 ${top + 4}L53 ${top - 18}L60 ${top + 2}Z`}
            style={{ fill: BOW, stroke: BOW, strokeWidth: 2, strokeLinejoin: 'round' }}
          />
          <path
            d={`M45 ${top - 3}L57 ${top - 6}`}
            style={{ stroke: GOLD, strokeWidth: 2.4, strokeLinecap: 'round' }}
          />
          <circle cx="53" cy={top - 19} r="3.4" style={{ fill: GOLD }} />
        </g>
      )
    case 'bandage': {
      const bx = 50 + body.side * 0.42
      const by = Math.max(top + 10, y - 16)
      return (
        <g transform={`rotate(-28 ${bx} ${by})`}>
          <rect
            x={bx - 8}
            y={by - 3.5}
            width="16"
            height="7"
            rx="3.5"
            style={{ fill: `color-mix(in srgb, ${GOLD} 45%, ${SHINE})` }}
          />
          <g style={{ fill: shadeOf(`color-mix(in srgb, ${GOLD} 45%, ${SHINE})`, 30) }}>
            <circle cx={bx - 1.6} cy={by} r="0.9" />
            <circle cx={bx + 1.6} cy={by} r="0.9" />
          </g>
        </g>
      )
    }
    case 'star': {
      const sx = 50 + body.side * 0.6
      const sy = top + 5
      const pts = Array.from({ length: 10 }, (_, i) => {
        const r = i % 2 === 0 ? 6.5 : 3
        const a = ((-90 + i * 36) * Math.PI) / 180
        return `${(sx + r * Math.cos(a)).toFixed(1)},${(sy + r * Math.sin(a)).toFixed(1)}`
      }).join(' ')
      return (
        <polygon
          points={pts}
          style={{ fill: GOLD, stroke: GOLD, strokeWidth: 1.6, strokeLinejoin: 'round' }}
        />
      )
    }
    default:
      return null
  }
}

function useBlink(active: boolean): boolean {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(
        () => {
          setClosed(true)
          timer = setTimeout(() => {
            setClosed(false)
            schedule()
          }, 120)
        },
        2200 + Math.random() * 3800,
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }, [active])
  return closed
}

const L = AVATARS.look

/** Where the eyes go for each mood, by the persona's habits: the spots to step through, and whether in order. */
function lookSpots(persona: Persona, mood: Mood): { spots: Look[]; ordered: boolean; ms: number } {
  const pace = AVATARS.tempo[persona.tempo]
  if (mood === 'working') {
    if (persona.workLook === 'focus')
      return {
        spots: [
          [-L.focus * 0.6, L.focus],
          [L.focus * 0.6, L.focus],
        ],
        ordered: true,
        ms: AVATARS.scanMs * 1.6 * pace,
      }
    if (persona.workLook === 'dart')
      return {
        spots: [
          [-L.scan, 0],
          [L.scan, -1],
          [L.scan * 0.6, 2.5],
          [-L.scan * 0.8, 2],
          [0, -1.5],
        ],
        ordered: false,
        ms: AVATARS.scanMs * 0.75 * pace,
      }
    return {
      spots: [
        [-L.scan, 0],
        [L.scan, 0],
        [L.scan * 0.85, 2.5],
        [-L.scan * 0.85, 2.5],
      ],
      ordered: true,
      ms: AVATARS.scanMs * pace,
    }
  }
  if (mood === 'thinking') {
    if (persona.thinkLook === 'side')
      return {
        spots: [
          [L.scan, -1.5],
          [L.scan, -2],
        ],
        ordered: true,
        ms: AVATARS.glanceMs * pace,
      }
    if (persona.thinkLook === 'roll')
      return {
        spots: [
          [-L.up, -1],
          [0, -L.up],
          [L.up, -1],
        ],
        ordered: true,
        ms: AVATARS.scanMs * 1.4 * pace,
      }
    return {
      spots: [
        [-1, -L.up],
        [1, -L.up],
      ],
      ordered: true,
      ms: AVATARS.glanceMs * 0.8 * pace,
    }
  }
  const g = L.glance
  return {
    spots: [
      [0, 0],
      [0, 0],
      [-g, -1],
      [g, -1],
      [0, 2],
    ],
    ordered: false,
    ms: AVATARS.glanceMs * pace,
  }
}

/** The whole character's motion for a mood, as a CSS animation (keyframes in styles.css); none with less motion. */
export function motionFor(persona: Persona, mood: Mood): string | undefined {
  const pace = AVATARS.tempo[persona.tempo]
  const c = AVATARS.cycle
  const loop = (name: string, s: number) => `avatar-${name} ${(s * pace).toFixed(2)}s ease-in-out infinite`
  switch (mood) {
    case 'working':
      return persona.work === 'steady' ? undefined : loop(persona.work, c.work)
    case 'thinking':
      return loop('tilt', c.idle)
    case 'happy':
    case 'love':
      return `avatar-${persona.done} ${(c.done * pace).toFixed(2)}s ease-in-out 2`
    case 'error':
      return persona.error === 'droop'
        ? `avatar-droop ${(c.error * 2 * pace).toFixed(2)}s ease-out 1 forwards`
        : `avatar-${persona.error} ${(c.error * pace).toFixed(2)}s ease-in-out ${persona.error === 'tremble' ? 4 : 2}`
    case 'sleep':
      return loop('breathe', c.idle * 1.4)
    default:
      return persona.idle === 'still' ? undefined : loop(persona.idle, c.idle)
  }
}

/** Which of a persona's lines and emotes a mood shows. */
export function lineFor(mood: Mood): 'idle' | 'working' | 'thinking' | 'done' | 'error' {
  if (mood === 'working') return 'working'
  if (mood === 'thinking') return 'thinking'
  if (mood === 'happy' || mood === 'love') return 'done'
  if (mood === 'error') return 'error'
  return 'idle'
}

/** The persona's words: copy.avatars.personas[id]. */
export const personaCopy = (id: string) =>
  copy.avatars.personas[id as keyof typeof copy.avatars.personas] ?? copy.avatars.personas.pip

/** The persona a crewmate wears in the surrounding crew, with its words. */
export function useCharacter(name: string, override?: string) {
  const persona = usePersona(name, override)
  return { persona, words: personaCopy(persona.id) }
}

/** An emote popping up beside the character for a moment when its state changes: a glyph from the persona's set. */
function useEmote(persona: Persona, mood: Mood, enabled: boolean): string | undefined {
  const [emote, setEmote] = useState<string>()
  const last = useRef(mood)
  useEffect(() => {
    if (last.current === mood) return
    last.current = mood
    const key = lineFor(mood)
    if (!enabled || key === 'idle' || key === 'working') {
      setEmote(undefined)
      return
    }
    setEmote(personaCopy(persona.id).emotes[key])
    const t = setTimeout(() => setEmote(undefined), AVATARS.emoteMs)
    return () => clearTimeout(t)
  }, [mood, persona.id, enabled])
  return emote
}

/**
 * A crewmate's character: its colour (from its call sign), the persona it wears in its crew, and eyes that look
 * around while it works, blink, smile when done, and close when it rests; the persona decides how it moves meanwhile.
 */
export function AgentCharacter(props: {
  name: string
  status: string
  size?: number
  className?: string
  awake?: boolean
  /** Wear this persona rather than the one drawn for the crew. */
  persona?: string
}) {
  const size = props.size ?? 32
  const reduce = useReducedMotionConfig()
  const { color } = identityOf(props.name)
  const { persona, words } = useCharacter(props.name, props.persona)
  const body = BODIES[persona.body]
  const mood = useAgentMood(props.status, props.awake)
  const blink = useBlink(!reduce && !['happy', 'error', 'sleep', 'love'].includes(mood))
  const [look, setLook] = useState<Look>([0, 0])
  const moving = mood === 'working' || mood === 'thinking' || mood === 'idle' || mood === 'waiting'
  useEffect(() => {
    setLook([0, 0])
    if (reduce || !moving) return
    const { spots, ordered, ms } = lookSpots(persona, mood)
    let i = 0
    if (mood === 'thinking') setLook(spots[0] ?? [0, 0])
    const t = setInterval(
      () => setLook(spots[ordered ? ++i % spots.length : Math.floor(Math.random() * spots.length)] ?? [0, 0]),
      ms,
    )
    return () => clearInterval(t)
  }, [reduce, moving, mood, persona])
  const emote = useEmote(persona, mood, size >= AVATARS.emoteMinSize)
  const animation = reduce ? undefined : motionFor(persona, mood)

  return (
    <span
      className={props.className}
      style={{ width: size, height: size, display: 'inline-block', flexShrink: 0, position: 'relative' }}
      title={copy.avatars.tooltip(props.name, words.name, words.temperament, words.lines[lineFor(mood)])}
      data-persona={persona.id}
      aria-hidden
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        overflow="visible"
        aria-hidden
        data-avatar-motion={animation ? (animation.split(' ')[0] ?? '') : undefined}
        style={animation ? { animation, transformOrigin: '50% 92%', transformBox: 'view-box' } : undefined}
      >
        <g style={{ stroke: 'var(--character-edge)', strokeWidth: 1.5 }}>{body.draw(color)}</g>
        {persona.accessories
          .filter((a) => a !== 'glasses' && a !== 'monocle')
          .map((a) => (
            <Extra key={a} body={body} kind={a} fill={color} />
          ))}
        <Eyes body={body} persona={persona} mood={mood} blink={blink} look={look} />
        <Mouth body={body} persona={persona} mood={mood} />
        {persona.accessories
          .filter((a) => a === 'glasses' || a === 'monocle')
          .map((a) => (
            <Extra key={a} body={body} kind={a} fill={color} />
          ))}
      </svg>
      {mood === 'sleep' && size >= 28 && <Snore size={size} />}
      {emote && (
        <motion.span
          key={emote}
          data-emote={emote}
          className="pointer-events-none absolute grid select-none place-items-center rounded-full border border-line bg-surface font-semibold leading-none text-fg shadow-sm after:content-[attr(data-emote)]"
          style={{
            right: -size * 0.12,
            top: -size * 0.12,
            minWidth: Math.max(14, size * 0.36),
            height: Math.max(14, size * 0.36),
            fontSize: Math.max(8, size * 0.2),
            padding: '0 3px',
          }}
          initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.5, y: 3 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 520, damping: 22 }}
          aria-hidden
        />
      )}
    </span>
  )
}

/** The character a crewmate wears, in words: who it is, its temperament, its catchphrase and its line for now. */
export function CharacterNote(props: { name: string; status: string; className?: string }) {
  const { words } = useCharacter(props.name)
  return (
    <div className={props.className} data-character-note>
      <div className="text-footnote font-medium text-fg-2">
        {copy.avatars.character(words.name, words.temperament)}
      </div>
      <div className="text-footnote text-muted">
        {copy.avatars.quote(words.catchphrase)} {words.lines[lineFor(moodFor(props.status))]}
      </div>
    </div>
  )
}
