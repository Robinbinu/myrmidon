import { type Form, identityOf } from '@myrmidon/protocol'
import { motion, useReducedMotion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import { type Mood, moodFor } from './pixel.tsx'

/*
 * Worker characters: a plain rounded shape in the worker's colour with two ink eyes, drawn in a 100×100
 * box. Each body declares where its eyes sit.
 */
interface Body {
  draw: (fill: string) => ReactNode
  eyeY: number
  eyeGap: number
}

const BODIES: Record<Form, Body> = {
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
}

const INK = '#16161a'

/** Plain ink eyes: rounded capsules that blink and look about, or a simple expression. */
function Eyes(props: { body: Body; mood: Mood; blink: boolean; look: [number, number] }) {
  const { body, mood } = props
  const xs = [50 - body.eyeGap / 2, 50 + body.eyeGap / 2]
  const y = body.eyeY
  if (mood === 'happy' || mood === 'love') {
    return (
      <g fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round">
        {xs.map((x) => (
          <path key={x} d={`M${x - 5} ${y + 2}Q${x} ${y - 5} ${x + 5} ${y + 2}`} />
        ))}
      </g>
    )
  }
  if (mood === 'error') {
    return (
      <g stroke={INK} strokeWidth="4" strokeLinecap="round">
        {xs.map((x) => (
          <path key={x} d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`} />
        ))}
      </g>
    )
  }
  if (mood === 'sleep') {
    return (
      <g stroke={INK} strokeWidth="4" strokeLinecap="round">
        {xs.map((x) => (
          <path key={x} d={`M${x - 4.5} ${y + 1}H${x + 4.5}`} />
        ))}
      </g>
    )
  }
  const h = props.blink ? 2 : mood === 'waiting' ? 6 : 12
  return (
    <g fill={INK}>
      {xs.map((x) => (
        <motion.rect
          key={x}
          width="7"
          rx="3.5"
          initial={false}
          animate={{ x: x - 3.5 + props.look[0], y: y - h / 2 + props.look[1], height: h }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
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

/**
 * A worker's character: its own shape and colour (both derived from its call sign) with eyes that look
 * around while it works, blink, smile when done, and close when it rests.
 */
export function AgentCharacter(props: { name: string; status: string; size?: number; className?: string }) {
  const size = props.size ?? 32
  const reduce = useReducedMotion()
  const { color, form } = identityOf(props.name)
  const body = BODIES[form]
  const mood = moodFor(props.status)
  const working = mood === 'working' || mood === 'thinking'
  const blink = useBlink(!reduce && !['happy', 'error', 'sleep', 'love'].includes(mood))
  const [look, setLook] = useState<[number, number]>([0, 0])
  useEffect(() => {
    if (reduce) return
    const spots: [number, number][] = working
      ? [
          [-3.5, 0],
          [3.5, 0],
          [3, 2.5],
          [-3, 2.5],
        ]
      : [
          [0, 0],
          [0, 0],
          [-2.5, -1],
          [2.5, -1],
          [0, 2],
        ]
    let i = 0
    const t = setInterval(
      () => setLook(spots[working ? i++ % spots.length : Math.floor(Math.random() * spots.length)] ?? [0, 0]),
      working ? 480 : 2600,
    )
    return () => clearInterval(t)
  }, [reduce, working])

  return (
    <span
      className={props.className}
      style={{ width: size, height: size, display: 'inline-block', flexShrink: 0 }}
      title={`${props.name} · ${props.status}`}
      aria-hidden
    >
      <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible" aria-hidden>
        {body.draw(color)}
        <Eyes body={body} mood={mood} blink={blink} look={look} />
      </svg>
    </span>
  )
}
