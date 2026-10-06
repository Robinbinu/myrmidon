import { BookOpen, Code2, Gamepad2, Search } from 'lucide-react'
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { CrewCursor, tripMs } from '../ui/cursor.tsx'
import { agentColor, DotMatrix, LEAD_COLOR, type Mood, PixelFace } from '../ui/pixel.tsx'
import { softSpring } from '../ui/primitives.tsx'
import TechText from '../vendor/react-bits/TechText'

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

interface Reaction {
  mood: Mood
  label: string
}

const POKED: Reaction[] = [
  { mood: 'wink', label: 'wink' },
  { mood: 'love', label: 'love' },
  { mood: 'surprised', label: 'oh!' },
  { mood: 'happy', label: 'hehe' },
]
const IDLE_TRICKS: Reaction[] = [
  { mood: 'wink', label: 'wink' },
  { mood: 'happy', label: 'hehe' },
]

/** The crew that hangs around the mascot. Positions are relative to the face's center. */
const CREW = [
  { name: 'nova', color: agentColor('nova'), x: -340, y: -70 },
  { name: 'kai', color: agentColor('kai'), x: 320, y: 30 },
  { name: 'judge', color: agentColor('judge'), x: -290, y: 130 },
]

const readToken = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#ffffff'

/** The current value of a CSS color token, kept in sync with the theme (canvas text can't use var()). */
function useToken(name: string): string {
  const [value, setValue] = useState(() => readToken(name))
  useEffect(() => {
    const update = () => setValue(readToken(name))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [name])
  return value
}

/** Sleeps after this long without the pointer moving. */
const DOZE_MS = 45_000
/** The user's own pointer outranks the crew's for this long after it moves. */
const USER_FOCUS_MS = 2500

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** Pixel offset from the face's center → where the eyes point, in cells. */
const gaze = (dx: number, dy: number): [number, number] => [
  clamp(Math.round(dx / 110), -2, 2),
  clamp(Math.round(dy / 90), -1, 1),
]

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return <DotMatrix text={hhmm} dot={2.4} ghost className="text-white/60" />
}

interface CrewState {
  name: string
  color: string
  x: number
  y: number
  clicking: boolean
}

/**
 * The empty state: the colony's mascot on its screen, one line, the message box, and a few starters.
 * The mascot follows the pointer with its eyes, reacts when clicked or poked by its crew, plays small
 * tricks when left alone, and dozes off after a while.
 */
export function Hero(props: { typing: boolean; onPick(text: string): void; children: ReactNode }) {
  const reduce = useReducedMotion()
  const [scope, animate] = useAnimate<HTMLButtonElement>()
  const [reaction, setReaction] = useState<Reaction>()
  const [asleep, setAsleep] = useState(false)
  const [hover, setHover] = useState(false)
  const [look, setLook] = useState<[number, number]>()
  const [crew, setCrew] = useState<CrewState[]>(() => CREW.map((c) => ({ ...c, clicking: false })))
  const ink = useToken('--text')
  const lastUser = useRef(Date.now())
  const asleepRef = useRef(false)
  const typingRef = useRef(props.typing)
  typingRef.current = props.typing
  const reactionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const busy = useRef(false)
  /** Where each crew cursor is heading, so new targets can keep their distance. */
  const positions = useRef(CREW.map((c) => ({ x: c.x, y: c.y })))

  const react = useCallback(
    (r: Reaction) => {
      asleepRef.current = false
      setAsleep(false)
      setReaction(r)
      busy.current = true
      if (!reduce && scope.current)
        void animate(scope.current, { scale: [1, 0.965, 1.012, 1] }, { duration: 0.45, ease: 'easeOut' })
      clearTimeout(reactionTimer.current)
      reactionTimer.current = setTimeout(() => {
        setReaction(undefined)
        busy.current = false
      }, 1600)
    },
    [animate, reduce, scope],
  )
  useEffect(() => () => clearTimeout(reactionTimer.current), [])

  // Eyes follow the user's pointer; moving it also wakes a sleeping mascot.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = scope.current
      if (!el) return
      const r = el.getBoundingClientRect()
      lastUser.current = Date.now()
      const g = gaze(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
      setLook((l) => (l && l[0] === g[0] && l[1] === g[1] ? l : g))
      if (asleepRef.current) react({ mood: 'surprised', label: 'oh!' })
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [react, scope])

  // Dozing off, and the occasional trick while nobody is around.
  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => {
      const quiet = Date.now() - lastUser.current
      if (quiet > USER_FOCUS_MS) setLook((l) => (l && !busy.current ? undefined : l))
      if (typingRef.current || busy.current || asleepRef.current) return
      if (quiet > DOZE_MS) {
        asleepRef.current = true
        setAsleep(true)
      } else if (Math.random() < 0.12) {
        react(pick(IDLE_TRICKS))
      }
    }, 1000)
    return () => clearInterval(t)
  }, [react, reduce])

  // The crew wanders the canvas and now and then flies over to poke the mascot.
  useEffect(() => {
    if (reduce) return
    let alive = true
    let poking = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const wait = (ms: number) =>
      new Promise<void>((done) => {
        timers.push(setTimeout(done, ms))
      })
    const update = (i: number, patch: Partial<CrewState>) => {
      if (patch.x !== undefined && patch.y !== undefined) positions.current[i] = { x: patch.x, y: patch.y }
      setCrew((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
    }
    const follow = (x: number, y: number) => {
      if (Date.now() - lastUser.current > USER_FOCUS_MS) setLook(gaze(x, y))
    }
    const size = () => {
      const r = scope.current?.getBoundingClientRect()
      return { hw: (r?.width ?? 450) / 2, hh: (r?.height ?? 320) / 2 }
    }
    // Somewhere around the screen, away from the headline below it and from the other cursors.
    const roam = (i: number) => {
      const { hw, hh } = size()
      const others = positions.current.filter((_, j) => j !== i)
      let best = { x: 0, y: 0 }
      let bestGap = -1
      for (let k = 0; k < 6; k++) {
        const side = Math.random() < 0.5 ? -1 : 1
        const c = { x: side * (hw + 50 + Math.random() * 170), y: -hh * 0.9 + Math.random() * hh * 1.6 }
        const gap = Math.min(...others.map((o) => Math.hypot(o.x - c.x, o.y - c.y)), Number.POSITIVE_INFINITY)
        if (gap > bestGap) {
          best = c
          bestGap = gap
        }
      }
      return best
    }
    const run = async (i: number) => {
      await wait(1200 + i * 1100)
      while (alive) {
        if (!poking && !typingRef.current && Math.random() < 0.4) {
          poking = true
          const { hw, hh } = size()
          const x = (Math.random() * 2 - 1) * hw * 0.55
          const y = (Math.random() * 2 - 1) * hh * 0.45
          const from = positions.current[i] ?? { x, y }
          update(i, { x, y })
          follow(x, y)
          await wait(tripMs(Math.hypot(x - from.x, y - from.y)) + 260)
          if (!alive) return
          update(i, { clicking: true })
          react(pick(POKED))
          await wait(240)
          update(i, { clicking: false })
          await wait(650)
          poking = false
          update(i, roam(i))
        } else {
          const to = roam(i)
          update(i, to)
          if (Math.random() < 0.5) follow(to.x, to.y)
        }
        await wait(2800 + Math.random() * 4200)
      }
    }
    for (const i of CREW.keys()) void run(i)
    return () => {
      alive = false
      for (const t of timers) clearTimeout(t)
    }
  }, [react, reduce, scope])

  const mood: Mood = props.typing
    ? 'listening'
    : (reaction?.mood ?? (asleep ? 'sleep' : hover ? 'thinking' : 'idle'))
  const label = props.typing ? 'listening' : (reaction?.label ?? (asleep ? 'zzz' : 'ready'))

  return (
    <div className="dot-field flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="m-auto flex w-full max-w-[760px] flex-col items-center px-4 py-8 sm:px-6">
        <div className="relative">
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={softSpring}
          >
            <button
              ref={scope}
              type="button"
              onClick={() => react(pick(POKED))}
              aria-label="Poke the colony"
              className="block cursor-pointer rounded-[36px] bg-screen p-6 pb-4 shadow-pop ring-1 ring-white/[0.06] outline-offset-4"
            >
              <PixelFace
                mood={mood}
                color={LEAD_COLOR}
                cols={15}
                rows={8}
                cell={20}
                gap={6}
                glow
                {...(look ? { look } : {})}
                className="h-auto w-[min(400px,calc(100vw-96px))]"
              />
              <div className="mt-5 flex items-center justify-between px-1">
                <span className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.2em] text-white/35">
                  <span className={`size-1 rounded-full ${asleep ? 'bg-white/30' : 'bg-[#3ddc84]'}`} />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={label}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.14 }}
                    >
                      {label}
                    </motion.span>
                  </AnimatePresence>
                </span>
                <Clock />
              </div>
            </button>
          </motion.div>

          <motion.div
            className="pointer-events-none absolute left-1/2 top-1/2 z-10 hidden lg:block"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.3 }}
          >
            {crew.map((c) => (
              <CrewCursor key={c.name} name={c.name} color={c.color} x={c.x} y={c.y} clicking={c.clicking} />
            ))}
          </motion.div>
        </div>

        <h1 className="sr-only">What should the colony build?</h1>
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.06 }}
          className="mb-0 mt-3 h-[124px] w-full"
          aria-hidden
        >
          <TechText
            text="What should the colony build?"
            fontSize={40}
            fontWeight={600}
            letterSpacing={-0.03}
            color={ink}
            accentColor={LEAD_COLOR}
            reveal="letter"
            dashLength={4}
            dashGap={2}
            specks={12}
            speed={0.6}
          />
        </motion.div>

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
