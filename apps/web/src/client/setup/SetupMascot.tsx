import { AnimatePresence, motion, useAnimate, useReducedMotionConfig } from 'motion/react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Emotion } from '../chat/emotion.ts'
import { gaze, resolveColor } from '../chat/Hero.tsx'
import { copy } from '../copy.ts'
import { MASCOT_LAYOUT_ID, type MascotLook } from '../mascot.ts'
import { CrewCursor, tripMs } from '../ui/cursor.tsx'
import { agentColor, BOW, DotMatrix, FLOWER, LEAD_COLOR, PixelFace, PixelSprite } from '../ui/pixel.tsx'
import { MASCOT_COLORS, SETUP_MASCOT } from '../ui-config.ts'
import {
  CHOREOGRAPHY,
  placement,
  REACTIONS,
  type Reaction,
  reactionMotion,
  stageLayout,
  WAKE_UP,
} from './choreography.ts'
import type { SetupScreen } from './state.ts'

/** What a screen can ask of the mascot. */
export interface MascotControl {
  /** Plays a reaction: a face for a moment, and its motion unless motion is reduced. */
  react(reaction: Reaction): void
  /** Holds a face until it is let go with `undefined` (thinking while a model is tested). */
  hold(emotion: Emotion | undefined): void
  /** What its dot screen spells; `undefined` clears it. */
  screen(text: string | undefined): void
  /** A line under it, like speech; `undefined` clears it. */
  say(text: string | undefined): void
  /** How loud the microphone is, 0 to 1: its eyes pulse with it. */
  level(value: number): void
  /** The crewmates around it: a cursor flies in for each one added and pokes it, and off for each one removed. */
  crew(names: readonly string[]): void
}

const noop = () => {}
const MascotContext = createContext<MascotControl>({
  react: noop,
  hold: noop,
  screen: noop,
  say: noop,
  level: noop,
  crew: noop,
})

export const useSetupMascot = () => useContext(MascotContext)

const POKES: Reaction[] = ['poked', 'wink', 'love']
const TRICKS: Reaction[] = ['wink', 'curious']
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T

/** Controls the mascot's eyes go to: whatever can be pressed, typed in or chosen. */
const CONTROL = 'button, a[href], input, select, textarea, [role="switch"], [role="radio"], [data-gaze]'

/** A crewmate's cursor around the mascot, relative to its face's centre. */
interface Cursor {
  key: string
  name: string
  color: string
  x: number
  y: number
  clicking: boolean
  leaving: boolean
}

/**
 * The setup assistant's stage: one mascot for every screen, and the screen's content beside or under it. The mascot
 * never re-mounts between screens; it travels to each screen's place (CHOREOGRAPHY), follows the pointer or the
 * control in focus, and plays what the screens ask of it through `useSetupMascot`.
 */
export function MascotStage(props: {
  screen: SetupScreen
  look: MascotLook
  /** The person's first name, for its greeting. */
  name?: string
  children: ReactNode
}) {
  const reduce = !!useReducedMotionConfig()
  const choreo = CHOREOGRAPHY[props.screen]
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0, frameHeight: 0, contentHeight: 0 })
  const [reaction, setReaction] = useState<Reaction>()
  const reactionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastReaction = useRef(0)
  const [held, setHeld] = useState<Emotion>()
  const [text, setText] = useState<string>()
  const [speech, setSpeech] = useState<string>()
  const [level, setLevel] = useState(0)
  const [look, setLook] = useState<[number, number]>()
  const [cursors, setCursors] = useState<Cursor[]>([])
  const crewTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Waking up plays once, the first time Welcome shows.
  const [wake, setWake] = useState<number | undefined>(props.screen === 'welcome' ? 0 : undefined)
  const [typed, setTyped] = useState(0)
  const [placed, setPlaced] = useState(false)

  // A new screen starts clean: what the last one put on the screen and speech line goes with it. Done while
  // rendering, before the new screen's own effects ask for anything.
  const [shown, setShown] = useState(props.screen)
  if (shown !== props.screen) {
    setShown(props.screen)
    setText(undefined)
    setSpeech(undefined)
    setHeld(undefined)
    setLevel(0)
  }

  const react = useCallback(
    (r: Reaction) => {
      lastReaction.current = Date.now()
      setReaction(r)
      const motionKeys = reactionMotion(r, reduce)
      if (motionKeys && scope.current)
        void animate(scope.current, motionKeys, { duration: 0.6, ease: 'easeOut' })
      clearTimeout(reactionTimer.current)
      reactionTimer.current = setTimeout(() => setReaction(undefined), SETUP_MASCOT.reactionMs)
    },
    [animate, reduce, scope],
  )
  useEffect(
    () => () => {
      clearTimeout(reactionTimer.current)
      for (const t of crewTimers.current) clearTimeout(t)
    },
    [],
  )

  // Each screen's opening move, and each screen starts at its top, not where a long one before it was scrolled to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per screen
  useEffect(() => {
    if (choreo.enter) react(choreo.enter)
    content.current?.scrollTo?.({ top: 0 })
  }, [props.screen])

  // Waking up, beat by beat; then the greeting types out on its screen.
  useEffect(() => {
    if (wake === undefined) return
    const t = setTimeout(
      () => setWake(wake + 1 < WAKE_UP.length ? wake + 1 : undefined),
      SETUP_MASCOT.wakeBeatMs,
    )
    return () => clearTimeout(t)
  }, [wake])
  const greeting = props.name ? copy.setup.screen.hello(props.name) : copy.setup.screen.hi
  useEffect(() => {
    if (props.screen !== 'welcome' || wake !== undefined || typed >= greeting.length) return
    const t = setTimeout(() => setTyped((n) => n + 1), SETUP_MASCOT.typeMs)
    return () => clearTimeout(t)
  }, [props.screen, wake, typed, greeting.length])

  // Never asleep during setup, but not still either: a trick now and then while nothing else is going on.
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - lastReaction.current < SETUP_MASCOT.trickEveryMs) return
      if (Math.random() < SETUP_MASCOT.trickChance) react(pick(TRICKS))
    }, SETUP_MASCOT.trickEveryMs)
    return () => clearInterval(t)
  }, [react])

  // The stage's width and the mascot's height decide where it sits and how far the content keeps from it.
  useLayoutEffect(() => {
    const measure = () =>
      setSize({
        width: stage.current?.clientWidth ?? 0,
        height: stage.current?.clientHeight ?? 0,
        frameHeight: frame.current?.offsetHeight ?? 0,
        contentHeight: inner.current?.offsetHeight ?? 0,
      })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    for (const el of [stage.current, frame.current, inner.current]) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (size.width > 0) setPlaced(true)
  }, [size.width])

  // The eyes: on the control in focus or under the pointer where the screen says so, else on the pointer.
  useEffect(() => {
    const lookAt = (x: number, y: number) => {
      const r = scope.current?.getBoundingClientRect()
      if (!r) return
      const g = gaze(x - (r.left + r.width / 2), y - (r.top + r.height / 2))
      setLook((l) => (l && l[0] === g[0] && l[1] === g[1] ? l : g))
    }
    const lookAtControl = (el: Element) => {
      const r = el.getBoundingClientRect()
      lookAt(r.left + r.width / 2, r.top + r.height / 2)
    }
    const control = (target: EventTarget | null) => {
      if (choreo.gaze !== 'controls' || !(target instanceof Element)) return undefined
      const el = target.closest(CONTROL)
      return el && content.current?.contains(el) ? el : undefined
    }
    const onMove = (e: PointerEvent) => {
      const el = control(e.target)
      if (el) lookAtControl(el)
      else lookAt(e.clientX, e.clientY)
    }
    // Typing keeps the eyes on the field being typed in.
    const onFocus = (e: Event) => {
      const el = control(e.target)
      if (el) lookAtControl(el)
    }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('input', onFocus)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('input', onFocus)
    }
  }, [choreo.gaze, scope])

  const crew = useCallback(
    (names: readonly string[]) => {
      const wait = (ms: number, run: () => void) => {
        crewTimers.current.push(setTimeout(run, ms))
      }
      const setCursor = (key: string, patch: Partial<Cursor>) =>
        setCursors((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)))
      // Two crewmates may share a role; each gets its own cursor.
      const seen = new Map<string, number>()
      const keys = names.map((name) => {
        const n = (seen.get(name) ?? 0) + 1
        seen.set(name, n)
        return { key: `${name}#${n}`, name }
      })
      setCursors((current) => {
        const wanted = new Set(keys.map((k) => k.key))
        const off = SETUP_MASCOT.crewOffstage
        // One no longer wanted flies off, and is gone once it is out of sight.
        const next = current.map((c) =>
          wanted.has(c.key) || c.leaving ? c : { ...c, leaving: true, x: off.x, y: off.y + 120 },
        )
        for (const c of next)
          if (c.leaving && !current.find((x) => x.key === c.key)?.leaving)
            wait(tripMs(Math.hypot(off.x, off.y)), () =>
              setCursors((cs) => cs.filter((x) => x.key !== c.key || !x.leaving)),
            )
        const added = keys.filter((k) => !current.some((c) => c.key === k.key && !c.leaving))
        const trip = tripMs(Math.hypot(off.x, off.y))
        added.forEach((k, i) => {
          const spot = SETUP_MASCOT.crewSpots[(current.length + i) % SETUP_MASCOT.crewSpots.length] ?? {
            x: 0,
            y: 0,
          }
          const poke = { x: (Math.random() * 2 - 1) * 60, y: (Math.random() * 2 - 1) * 30 }
          // In from off-stage, a poke at the face, then off to wait at its spot.
          const start = 40 + i * 500
          wait(start, () => setCursor(k.key, poke))
          wait(start + trip + 260, () => {
            setCursor(k.key, { clicking: true })
            react('poked')
          })
          wait(start + trip + 500, () => setCursor(k.key, { clicking: false }))
          wait(start + trip + 1150, () => setCursor(k.key, spot))
        })
        return [
          ...next.filter((c) => !added.some((k) => k.key === c.key)),
          ...added.map((k) => ({
            ...k,
            color: agentColor(k.name),
            x: off.x,
            y: off.y,
            clicking: false,
            leaving: false,
          })),
        ]
      })
    },
    [react],
  )

  const control = useMemo<MascotControl>(
    () => ({
      react,
      hold: setHeld,
      screen: setText,
      say: setSpeech,
      level: (v) => setLevel((l) => (Math.abs(l - v) < 0.02 ? l : v)),
      crew,
    }),
    [react, crew],
  )

  const beat = wake === undefined ? undefined : WAKE_UP[wake]
  const eyesOn = beat?.look ?? look
  const emotion: Emotion =
    (reaction ? REACTIONS[reaction].emotion : undefined) ?? held ?? beat?.emotion ?? choreo.rest
  // The colour the person chose is the mascot's own; its moods still bring theirs.
  const eyes = emotion.color === LEAD_COLOR ? MASCOT_COLORS[props.look.color] : resolveColor(emotion.color)
  const place = choreo.place
  const width = SETUP_MASCOT.width.center
  const frameHeight = size.frameHeight || 250
  // Centred, across and down. In the centre place it is untransformed, so the home screen's mascot takes over from
  // the right spot; its height on the stage is its `top`, which moves with the layout rather than as a transform.
  const layout = stageLayout({
    place,
    width: size.width,
    height: size.height,
    frameHeight,
    contentHeight: size.contentHeight,
  })
  const { scale, x, top } = layout
  const shownText =
    props.screen === 'welcome' && text === undefined
      ? wake === undefined
        ? greeting.slice(0, typed)
        : undefined
      : text?.slice(0, SETUP_MASCOT.screenChars)
  // It starts in its place, not travelling there: at once until the stage has been measured and drawn once.
  const framePlace = placement({ x, scale }, reduce, !placed)

  return (
    <MascotContext.Provider value={control}>
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={content} className="absolute inset-0 overflow-y-auto overscroll-contain" data-setup-content>
          <div
            style={{
              width: layout.content.width || undefined,
              marginLeft: layout.content.left,
              paddingTop: layout.content.paddingTop,
              paddingRight: layout.content.paddingRight,
              paddingBottom: SETUP_MASCOT.edge,
            }}
          >
            <div ref={inner}>{props.children}</div>
          </div>
        </div>
        <motion.div
          layoutId={MASCOT_LAYOUT_ID}
          initial={false}
          className="pointer-events-none absolute inset-x-0 z-10 mx-auto"
          {...framePlace}
          style={{ top, width, originX: 0.5, originY: 0, ...('style' in framePlace ? framePlace.style : {}) }}
          data-place={place}
        >
          <div ref={scope} className="relative">
            <motion.div
              ref={frame}
              className="rounded-5xl bg-screen p-5 pb-3 shadow-[var(--screen-frame)]"
              animate={{ scale: reduce ? 1 : 1 + level * 0.06 }}
              transition={{ duration: 0.08 }}
            >
              <button
                type="button"
                onClick={() => react(pick(POKES))}
                aria-label={copy.hero.poke}
                tabIndex={-1}
                className="pointer-events-auto block w-full rounded-xl outline-offset-4"
              >
                <PixelFace
                  mood={emotion.mood}
                  color={eyes}
                  cols={15}
                  rows={8}
                  cell={20}
                  gap={6}
                  glow
                  eyes={props.look.eyes}
                  {...(eyesOn ? { look: eyesOn } : {})}
                  className="h-auto w-full"
                />
              </button>
              <div className="mt-3 flex h-5 items-center justify-between gap-2 px-1" aria-hidden>
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-caption uppercase tracking-[0.2em] text-[color:var(--screen-ink)]">
                  <span className="size-1 shrink-0 rounded-full bg-[color:var(--screen-live)]" />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={emotion.label}
                      className="truncate"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.14 }}
                    >
                      {emotion.label}
                    </motion.span>
                  </AnimatePresence>
                </span>
                {shownText && (
                  <DotMatrix
                    text={shownText}
                    dot={SETUP_MASCOT.dot}
                    ghost
                    className="shrink-0 text-[color:var(--screen-ink)]"
                  />
                )}
              </div>
            </motion.div>
            {props.look.look === 'flower' && (
              <PixelSprite sprite={FLOWER} cell={8} className="absolute -right-5 -top-5" />
            )}
            {props.look.look === 'bow' && (
              <PixelSprite
                sprite={BOW}
                cell={4}
                className="absolute left-1/2 top-full -mt-2.5 -translate-x-1/2"
              />
            )}
          </div>
        </motion.div>
        {/* At the face's centre, unscaled, so crewmates' cursors and the speech line keep their size wherever it sits. */}
        <motion.div
          className="pointer-events-none absolute left-1/2 z-20"
          style={{ top: top + (frameHeight * scale) / 2 }}
          {...placement({ x }, reduce, !placed)}
          aria-hidden
        >
          {cursors.map((c) => (
            <CrewCursor key={c.key} name={c.name} color={c.color} x={c.x} y={c.y} clicking={c.clicking} />
          ))}
          <AnimatePresence>
            {speech && (
              <motion.p
                key={speech}
                initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute left-0 line-clamp-3 w-max -translate-x-1/2 rounded-2xl border border-line bg-surface px-4 py-2 text-center text-reading text-fg shadow-pop"
                style={{ top: (frameHeight * scale) / 2 + 14, maxWidth: Math.max(width * scale, 220) }}
              >
                {speech}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </MascotContext.Provider>
  )
}
