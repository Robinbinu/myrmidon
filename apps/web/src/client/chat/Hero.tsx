import { BookOpen, Code2, Gamepad2, Search } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import { CursorPill, DotMatrix, LEAD_COLOR, type Mood, PixelFace, USER_COLOR } from '../ui/pixel.tsx'
import { softSpring } from '../ui/primitives.tsx'

const SUGGESTIONS = [
  {
    icon: Search,
    label: 'Research',
    text: 'Compare the three most popular Rust web frameworks this year and write a report with a source for every claim.',
  },
  {
    icon: Gamepad2,
    label: 'Build an app',
    text: 'Build a single-file HTML snake game with keyboard and touch controls, levels, and a saved high score.',
  },
  {
    icon: Code2,
    label: 'Tested code',
    text: 'Write a Python CLI that converts CSV files to Parquet, with type hints, error handling, and pytest tests.',
  },
  {
    icon: BookOpen,
    label: 'Explain',
    text: 'Explain how transformers handle long context today, with a short glossary and further reading.',
  },
]

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return <DotMatrix text={hhmm} dot={1.8} ghost className="text-white/60" />
}

/** A collaborator cursor that wanders slowly around its anchor. */
function Wanderer(props: { children: ReactNode; className: string; delay: number; path: number[][] }) {
  const reduce = useReducedMotion()
  const xs = props.path.map((p) => p[0] ?? 0)
  const ys = props.path.map((p) => p[1] ?? 0)
  return (
    <motion.div
      className={`pointer-events-none absolute ${props.className}`}
      initial={{ opacity: 0, scale: 0.5 }}
      animate={reduce ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 1, x: xs, y: ys }}
      transition={{
        opacity: { delay: props.delay, duration: 0.3 },
        scale: { delay: props.delay, ...softSpring },
        x: { delay: props.delay, duration: 14, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' },
        y: { delay: props.delay, duration: 14, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' },
      }}
    >
      {props.children}
    </motion.div>
  )
}

/**
 * The empty state, kept to the essentials: the colony's face, one line, the message box, and a few
 * starters. The face lowers its eyes while the user types and glances around while idle.
 */
export function Hero(props: { typing: boolean; onPick(text: string): void; children: ReactNode }) {
  const [hover, setHover] = useState(false)
  const mood: Mood = props.typing ? 'listening' : hover ? 'thinking' : 'idle'
  return (
    <div className="dot-field flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="m-auto flex w-full max-w-[760px] flex-col items-center px-4 py-10 sm:px-6">
        <div className="relative">
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={softSpring}
            className="rounded-[26px] bg-screen p-4 pb-3 shadow-pop ring-1 ring-white/[0.06]"
          >
            <PixelFace mood={mood} color={LEAD_COLOR} cols={15} rows={9} cell={9} gap={3} glow />
            <div className="mt-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.2em] text-white/35">
                <span className="size-1 rounded-full bg-[#3ddc84]" />
                {props.typing ? 'listening' : 'ready'}
              </span>
              <Clock />
            </div>
          </motion.div>
          <Wanderer
            className="-left-24 top-2 hidden md:block"
            delay={0.4}
            path={[
              [0, 0],
              [10, 14],
              [-6, 22],
              [0, 0],
            ]}
          >
            <CursorPill name="lead" color={LEAD_COLOR} />
          </Wanderer>
          <Wanderer
            className="-right-24 top-16 hidden md:block"
            delay={0.7}
            path={[
              [0, 0],
              [-12, -10],
              [6, -18],
              [0, 0],
            ]}
          >
            <CursorPill name="nova" color="#ff7eb6" />
          </Wanderer>
          <Wanderer
            className="-bottom-6 -right-14 hidden md:block"
            delay={1}
            path={[
              [0, 0],
              [8, 6],
              [-4, 12],
              [0, 0],
            ]}
          >
            <CursorPill name="You" color={USER_COLOR} size="md" />
          </Wanderer>
        </div>

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.06 }}
          className="display mb-7 mt-10 text-center text-[32px] sm:text-[40px]"
        >
          What should the colony build?
        </motion.h1>

        <div className="w-full">{props.children}</div>

        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.label}
              type="button"
              title={s.text}
              onClick={() => props.onPick(s.text)}
              onMouseEnter={() => setHover(true)}
              onMouseLeave={() => setHover(false)}
              onFocus={() => setHover(true)}
              onBlur={() => setHover(false)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...softSpring, delay: 0.15 + i * 0.04 }}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface/70 px-3 text-[12.5px] font-medium text-fg-2 backdrop-blur transition-all duration-150 hover:border-line-strong hover:bg-surface hover:text-fg"
            >
              <s.icon className="size-3.5" />
              {s.label}
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  )
}
