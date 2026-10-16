import { identityOf } from '@myrmidon/protocol'
import { motion, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { AVATARS, lookSpring } from '../ui-config.ts'
import { usePersona } from './avatar-bag.ts'
import type { BodyShape, Persona } from './personas.ts'
import { type Mood, moodFor, Snore, useAgentMood } from './pixel.tsx'

/*
 * Crewmate characters: a plain rounded shape in the agent's colour with two ink eyes, drawn in a 100×100 box, each
 * wearing one of the personas in personas.ts (its shape and the way it moves). Each body declares where its eyes sit.
 */
interface Body {
  draw: (fill: string) => ReactNode
  eyeY: number
  eyeGap: number
}

const INK = 'var(--character-ink)'

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
  },
  ball: {
    draw: (fill) => <circle cx="50" cy="54" r="40" fill={fill} />,
    eyeY: 50,
    eyeGap: 20,
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
  },
  squircle: {
    draw: (fill) => <rect x="12" y="16" width="76" height="76" rx="30" fill={fill} />,
    eyeY: 52,
    eyeGap: 20,
  },
  pill: {
    draw: (fill) => <rect x="24" y="8" width="52" height="86" rx="26" fill={fill} />,
    eyeY: 40,
    eyeGap: 18,
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
  },
  egg: {
    draw: (fill) => (
      <path d="M50 8C70 8 84 38 84 60C84 80 69 93 50 93C31 93 16 80 16 60C16 38 30 8 50 8Z" fill={fill} />
    ),
    eyeY: 58,
    eyeGap: 20,
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
  },
  drop: {
    draw: (fill) => (
      <path d="M50 6C56 20 84 44 84 64C84 82 69 94 50 94C31 94 16 82 16 64C16 44 44 20 50 6Z" fill={fill} />
    ),
    eyeY: 64,
    eyeGap: 20,
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
  },
}

type Look = readonly [number, number]

/** Plain ink eyes: rounded capsules that blink and look about, or a simple expression. */
function Eyes(props: { body: Body; mood: Mood; blink: boolean; look: Look }) {
  const { body, mood } = props
  const xs = [50 - body.eyeGap / 2, 50 + body.eyeGap / 2]
  const y = body.eyeY
  const stroke = { stroke: INK, strokeWidth: 4, strokeLinecap: 'round', fill: 'none' } as const
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
    return (
      <g style={stroke}>
        {xs.map((x) => (
          <path key={x} d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`} />
        ))}
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
  const h = props.blink ? 2 : mood === 'waiting' ? 6 : 12
  return (
    <g style={{ fill: INK }}>
      {xs.map((x) => (
        <motion.rect
          key={x}
          width="7"
          rx="3.5"
          initial={false}
          animate={{ x: x - 3.5 + props.look[0], y: y - h / 2 + props.look[1], height: h }}
          transition={lookSpring}
        />
      ))}
    </g>
  )
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
        {body.draw(color)}
        <Eyes body={body} mood={mood} blink={blink} look={look} />
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
