import { BookOpen, Code2, Gamepad2, Search } from 'lucide-react'
import { AnimatePresence, motion, useAnimate, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { type MascotLook, useGreeting, useMascotLook } from '../mascot.ts'
import { CrewCursor, tripMs } from '../ui/cursor.tsx'
import { agentColor, BOW, DotMatrix, FLOWER, LEAD_COLOR, PixelFace, PixelSprite } from '../ui/pixel.tsx'
import {
  HERO_MASCOT_MIN_HEIGHT,
  MASCOT_COLORS,
  MASCOT_DOZE_MS,
  MASCOT_PAT_MS,
  MASCOT_SCREEN_MS,
  MASCOT_USER_FOCUS_MS,
  softSpring,
} from '../ui-config.ts'
import TechText from '../vendor/react-bits/TechText'
import { ambient, EMOTIONS, type Emotion, readDraft } from './emotion.ts'

const SUGGESTIONS = [
  { icon: Search, ...copy.hero.suggestions.research },
  { icon: Gamepad2, ...copy.hero.suggestions.app },
  { icon: Code2, ...copy.hero.suggestions.code },
  { icon: BookOpen, ...copy.hero.suggestions.explain },
]

const POKED: Emotion[] = [EMOTIONS.wink, EMOTIONS.love, EMOTIONS.surprised, EMOTIONS.happy]
const IDLE_TRICKS: Emotion[] = [EMOTIONS.wink, EMOTIONS.happy]

/** The crew that hangs around the mascot. Positions are relative to the face's center. */
const CREW = [
  { name: 'nova', color: agentColor('nova'), x: -340, y: -70 },
  { name: 'kai', color: agentColor('kai'), x: 320, y: 30 },
  { name: 'judge', color: agentColor('judge'), x: -290, y: 130 },
]

/** Where each cursor last was, so coming back to this screen finds them where they left off, not at their start. */
let lastPositions: { x: number; y: number }[] | undefined

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

/** Whether the window is at least `px` tall, kept current as it is resized. */
function useTallerThan(px: number): boolean {
  const query = `(min-height: ${px}px)`
  const [tall, setTall] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setTall(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return tall
}

/** A colour canvas can draw with: a `var(--token)` resolves to the token's value, anything else passes through. */
const resolveColor = (color: string) => {
  const token = /^var\((--[\w-]+)\)$/.exec(color)?.[1]
  return token ? readToken(token) : color
}

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** Pixel offset from the face's center → where the eyes point, in cells. */
const gaze = (dx: number, dy: number): [number, number] => [
  clamp(Math.round(dx / 110), -2, 2),
  clamp(Math.round(dy / 90), -1, 1),
]

/**
 * The readout in the screen's corner, as the person chose: the clock, a hello with their name, how many crews are at
 * work (the clock when none are), all of these in turn, or nothing.
 */
function Readout(props: { mode: MascotLook['screen']; name?: string; working: number }) {
  const [now, setNow] = useState(() => new Date())
  const [turn, setTurn] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (props.mode !== 'rotate') return
    const t = setInterval(() => setTurn((n) => n + 1), MASCOT_SCREEN_MS)
    return () => clearInterval(t)
  }, [props.mode])
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const hello = props.name ? copy.hero.screen.hello(props.name.split(/\s+/)[0]?.slice(0, 8) ?? '') : undefined
  const crew = props.working > 0 ? copy.hero.screen.atWork(props.working) : undefined
  const shown =
    props.mode === 'face'
      ? undefined
      : props.mode === 'name'
        ? (hello ?? clock)
        : props.mode === 'crew'
          ? (crew ?? clock)
          : props.mode === 'clock'
            ? clock
            : (() => {
                const all = [clock, hello, crew].filter((x): x is string => Boolean(x))
                return all[turn % all.length]
              })()
  if (!shown) return null
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={shown === clock ? 'clock' : shown}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
      >
        <DotMatrix text={shown} dot={2.4} ghost className="text-[color:var(--screen-ink)]" />
      </motion.span>
    </AnimatePresence>
  )
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
export function Hero(props: {
  /** What the user is typing; the mascot reads its mood. */
  draft: string
  /** Colonies running across all chats. */
  working: number
  /** The most recent chat's status and when it last changed. */
  latest?: { status: string; updatedAt: string }
  /** What the chats are doing, as a key: when it changes, the greeting is written again. */
  news: string
  onPick(text: string): void
  children: ReactNode
}) {
  const reduce = useReducedMotionConfig()
  const roomy = useTallerThan(HERO_MASCOT_MIN_HEIGHT)
  const mascot = useMascotLook()
  const { greeting, name } = useGreeting(props.news)
  const headline = greeting?.headline ?? copy.hero.headline
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const [reaction, setReaction] = useState<Emotion>()
  const [petted, setPetted] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const patTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const shakes = useRef<{ at: number; dir: number }[]>([])
  const lastMove = useRef({ x: 0, t: 0 })
  const [asleep, setAsleep] = useState(false)
  const [hover, setHover] = useState(false)
  const [look, setLook] = useState<[number, number]>()
  const [crew, setCrew] = useState<CrewState[]>(() =>
    CREW.map((c, i) => ({ ...c, ...lastPositions?.[i], clicking: false })),
  )
  const ink = useToken('--text')
  const lastUser = useRef(Date.now())
  const asleepRef = useRef(false)
  const typing = props.draft.trim().length > 0
  const typingRef = useRef(typing)
  typingRef.current = typing
  const reactionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const busy = useRef(false)
  /** Where each crew cursor is heading, so new targets can keep their distance. */
  const positions = useRef(lastPositions ?? CREW.map((c) => ({ x: c.x, y: c.y })))

  const react = useCallback(
    (r: Emotion) => {
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
  useEffect(
    () => () => {
      clearTimeout(reactionTimer.current)
      clearTimeout(patTimer.current)
    },
    [],
  )
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  // Eyes follow the user's pointer; moving it also wakes a sleeping mascot.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = scope.current
      if (!el) return
      const r = el.getBoundingClientRect()
      lastUser.current = Date.now()
      const g = gaze(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
      setLook((l) => (l && l[0] === g[0] && l[1] === g[1] ? l : g))
      if (asleepRef.current) react(EMOTIONS.surprised)
      // Shaking the pointer back and forth makes it dizzy.
      const dt = e.timeStamp - lastMove.current.t
      const dx = e.clientX - lastMove.current.x
      lastMove.current = { x: e.clientX, t: e.timeStamp }
      if (dt > 0 && Math.abs(dx / dt) > 1.6) {
        const dir = Math.sign(dx)
        const recent = shakes.current.filter((s) => e.timeStamp - s.at < 600)
        if (recent.at(-1)?.dir !== dir) recent.push({ at: e.timeStamp, dir })
        shakes.current = recent
        if (recent.length >= 4 && !busy.current) {
          shakes.current = []
          react(EMOTIONS.dizzy)
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [react, scope])

  // Dozing off, and the occasional trick while nobody is around.
  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => {
      const quiet = Date.now() - lastUser.current
      if (quiet > MASCOT_USER_FOCUS_MS) setLook((l) => (l && !busy.current ? undefined : l))
      if (typingRef.current || busy.current || asleepRef.current) return
      if (quiet > MASCOT_DOZE_MS) {
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
      if (patch.x !== undefined && patch.y !== undefined) {
        positions.current[i] = { x: patch.x, y: patch.y }
        lastPositions = [...positions.current]
      }
      setCrew((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
    }
    const follow = (x: number, y: number) => {
      if (Date.now() - lastUser.current > MASCOT_USER_FOCUS_MS) setLook(gaze(x, y))
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

  const emotion: Emotion =
    reaction ??
    (typing
      ? readDraft(props.draft)
      : asleep
        ? EMOTIONS.sleepy
        : petted
          ? EMOTIONS.happy
          : hover
            ? EMOTIONS.curious
            : ambient({
                working: props.working,
                ...(props.latest
                  ? {
                      latest: {
                        status: props.latest.status,
                        agoMs: now - Date.parse(props.latest.updatedAt),
                      },
                    }
                  : {}),
                hour: new Date(now).getHours(),
              }))
  const label = emotion.label
  // The colour the person chose is the mascot's own; its moods still bring theirs.
  const eyes = useMemo(
    () => (emotion.color === LEAD_COLOR ? MASCOT_COLORS[mascot.color] : resolveColor(emotion.color)),
    [emotion.color, mascot.color],
  )

  return (
    <div className="dot-field flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="m-auto flex w-full max-w-[760px] flex-col items-center px-6 py-8">
        {roomy && (
          <div className="relative">
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={softSpring}
              className="relative"
            >
              {/* The face is the button; the ticker under it is text on the screen, outside the button, so the
                  button's name is what it does and is all it shows. */}
              <div
                ref={scope}
                onPointerEnter={() => {
                  clearTimeout(patTimer.current)
                  patTimer.current = setTimeout(() => setPetted(true), MASCOT_PAT_MS)
                }}
                onPointerLeave={() => {
                  clearTimeout(patTimer.current)
                  setPetted(false)
                }}
                className="block rounded-5xl bg-screen p-6 pb-4 shadow-[var(--screen-frame)]"
              >
                <button
                  type="button"
                  onClick={() => react(pick(POKED))}
                  aria-label={copy.hero.poke}
                  className="block rounded-xl outline-offset-4"
                >
                  <PixelFace
                    mood={emotion.mood}
                    color={eyes}
                    cols={15}
                    rows={8}
                    cell={20}
                    gap={6}
                    glow
                    eyes={mascot.eyes}
                    {...(look ? { look } : {})}
                    className="h-auto w-[min(400px,calc(100vw-96px))]"
                  />
                </button>
                <div className="mt-5 flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 font-mono text-caption uppercase tracking-[0.2em] text-[color:var(--screen-ink)]">
                    <span
                      className={`size-1 rounded-full ${asleep ? 'bg-[color:var(--screen-ink)]' : 'bg-[color:var(--screen-live)]'}`}
                    />
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
                  <Readout mode={mascot.screen} {...(name ? { name } : {})} working={props.working} />
                </div>
              </div>
              {mascot.look === 'flower' && (
                <PixelSprite
                  sprite={FLOWER}
                  cell={9}
                  className="pointer-events-none absolute -right-5 -top-5"
                />
              )}
              {mascot.look === 'bow' && (
                <PixelSprite
                  sprite={BOW}
                  cell={4.5}
                  className="pointer-events-none absolute left-1/2 top-full -mt-2.5 -translate-x-1/2"
                />
              )}
            </motion.div>

            <motion.div
              className="pointer-events-none absolute left-1/2 top-1/2 z-10 hidden lg:block"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.3 }}
            >
              {crew.map((c) => (
                <CrewCursor
                  key={c.name}
                  name={c.name}
                  color={c.color}
                  x={c.x}
                  y={c.y}
                  clicking={c.clicking}
                />
              ))}
            </motion.div>
          </div>
        )}

        <h1 className="sr-only">{headline}</h1>
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.06 }}
          className="mb-0 mt-3 h-[124px] w-full"
          aria-hidden
        >
          <TechText
            key={headline}
            text={headline}
            fontSize={40}
            fontWeight={600}
            letterSpacing={-0.03}
            color={ink}
            accentColor={eyes}
            reveal="letter"
            dashLength={4}
            dashGap={2}
            specks={0}
            // Its measuring box follows the pointer only; sweeping by itself it looked like a stray selection.
            sweep={false}
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
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface/70 px-3 text-callout font-medium text-fg-2 backdrop-blur transition-all duration-150 hover:border-line-strong hover:bg-surface hover:text-fg"
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
