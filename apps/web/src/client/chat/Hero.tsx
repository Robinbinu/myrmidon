import { BookOpen, Code2, Gamepad2, Search } from 'lucide-react'
import { AnimatePresence, motion, useAnimate, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { type MascotLook, useGreeting, useMascotLook } from '../mascot.ts'
import { ago } from '../ui/hooks.ts'
import { BOW, DotMatrix, FLOWER, LEAD_COLOR, PixelFace, PixelSprite } from '../ui/pixel.tsx'
import { cn, Dot } from '../ui/primitives.tsx'
import {
  HERO_MASCOT_MIN_HEIGHT,
  HERO_RECENT_CHATS,
  MASCOT_COLORS,
  MASCOT_DOZE_MS,
  MASCOT_PAT_MS,
  MASCOT_SCREEN_MS,
  MASCOT_USER_FOCUS_MS,
  softSpring,
} from '../ui-config.ts'
import { ambient, EMOTIONS, type Emotion, readDraft } from './emotion.ts'

const SUGGESTIONS = [
  { icon: Search, ...copy.hero.suggestions.research },
  { icon: Gamepad2, ...copy.hero.suggestions.app },
  { icon: Code2, ...copy.hero.suggestions.code },
  { icon: BookOpen, ...copy.hero.suggestions.explain },
]

const POKED: Emotion[] = [EMOTIONS.wink, EMOTIONS.love, EMOTIONS.surprised, EMOTIONS.happy]
const IDLE_TRICKS: Emotion[] = [EMOTIONS.wink, EMOTIONS.happy]

const readToken = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#ffffff'

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

/**
 * The new-chat view, calm rather than a landing page: the mascot on its screen at a modest size, a one-line greeting,
 * the message box, a few starters and the latest chats. The mascot follows the pointer with its eyes, reacts when
 * clicked, plays small tricks when left alone, and dozes off after a while.
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
  /** The latest chats, newest first, to pick one up again. */
  recent: readonly { chatId: string; title: string; status: string; updatedAt: string }[]
  onOpenChat(chatId: string): void
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
  const lastUser = useRef(Date.now())
  const asleepRef = useRef(false)
  const typing = props.draft.trim().length > 0
  const typingRef = useRef(typing)
  typingRef.current = typing
  const reactionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const busy = useRef(false)

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
    <div className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain">
      <div className="m-auto flex w-full max-w-[720px] flex-col items-center px-6 py-8">
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
                className="block rounded-4xl bg-screen p-4 pb-3 shadow-[var(--screen-frame)]"
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
                    className="h-auto w-[220px]"
                  />
                </button>
                <div className="mt-3 flex items-center justify-between px-0.5">
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
          </div>
        )}

        <motion.h1
          key={headline}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...softSpring, delay: 0.06 }}
          className={cn(
            'mb-5 text-center text-page-title font-semibold tracking-tight text-fg',
            roomy ? 'mt-7' : 'mt-0',
          )}
        >
          {headline}
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
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong/70 bg-control px-2.5 text-body text-fg-2 shadow-control transition-colors duration-100 hover:bg-control-hover hover:text-fg"
            >
              <s.icon className="size-3.5" />
              {s.label}
            </motion.button>
          ))}
        </div>

        {props.recent.length > 0 && (
          <motion.section
            aria-labelledby="hero-recent"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.25, duration: 0.2 }}
            className="mt-8 w-full max-w-[520px]"
          >
            <h2 id="hero-recent" className="mb-1 px-2 text-caption font-semibold text-muted">
              {copy.hero.recent}
            </h2>
            <ul>
              {props.recent.slice(0, HERO_RECENT_CHATS).map((c) => (
                <li key={c.chatId}>
                  <button
                    type="button"
                    onClick={() => props.onOpenChat(c.chatId)}
                    className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-body text-fg-2 transition-colors hover:bg-fill hover:text-fg"
                  >
                    <Dot status={c.status} pulse={false} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-small tabular-nums text-muted">{ago(c.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.section>
        )}
      </div>
    </div>
  )
}
