import { BookOpen, Code2, Gamepad2, Search } from 'lucide-react'
import { AnimatePresence, motion, useAnimate, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { MASCOT_LAYOUT_ID, type MascotLook, useGreeting, useMascotLook } from '../mascot.ts'
import { useSpecialists } from '../specialists.ts'
import {
  BANG,
  type Clip,
  chain,
  fire,
  IDLE_CLIPS,
  SNEEZE_CLIP,
  SWEAT,
  spiralEyes,
  starEyes,
  tears,
  ZZZ,
} from '../ui/clips.ts'
import { ago } from '../ui/hooks.ts'
import { BOW, DotMatrix, eyeCells, FLOWER, LEAD_COLOR, moodFor, PixelSprite } from '../ui/pixel.tsx'
import { cn, Dot } from '../ui/primitives.tsx'
import { boot, charge, confetti, equaliser, life, pacman, pop, ripple } from '../ui/shows.ts'
import { useMascotSounds } from '../ui/sounds.ts'
import {
  HERO_MASCOT_MIN_HEIGHT,
  HERO_RECENT_CHATS,
  MASCOT_COLORS,
  MASCOT_DOZE_MS,
  MASCOT_GRID,
  MASCOT_IDLE,
  MASCOT_PAT_MS,
  MASCOT_REACTIONS,
  MASCOT_SCREEN_MS,
  MASCOT_SHOWS,
  MASCOT_TOUCH,
  MASCOT_TYPING,
  MASCOT_USER_FOCUS_MS,
  softSpring,
} from '../ui-config.ts'
import { micLevel } from '../voice/CallBar.tsx'
import type { CallState } from '../voice/call-client.ts'
import { ambient, EMOTIONS, type Emotion, readDraft } from './emotion.ts'
import { HeroCrew } from './HeroCrew.tsx'
import type { CrewSignal } from './hero-crew.ts'
import { lookAt, MascotScreen } from './MascotScreen.tsx'

const SUGGESTIONS = [
  { icon: Search, ...copy.hero.suggestions.research },
  { icon: Gamepad2, ...copy.hero.suggestions.app },
  { icon: Code2, ...copy.hero.suggestions.code },
  { icon: BookOpen, ...copy.hero.suggestions.explain },
]

const POKED: Emotion[] = [EMOTIONS.wink, EMOTIONS.love, EMOTIONS.surprised, EMOTIONS.happy]
/** Reactions that sound let down rather than pleased. */
const DOWNCAST: ReadonlySet<Emotion> = new Set([
  EMOTIONS.sad,
  EMOTIONS.dizzy,
  EMOTIONS.confused,
  EMOTIONS.concerned,
])
const CALM_CLIPS = IDLE_CLIPS.filter((c) => (MASCOT_IDLE.calmClips as readonly string[]).includes(c.name))

/** The names the crew cursors wear first, as the person chose: none (Minions), their specialists', or their own. */
function useCrewNames(crew: MascotLook['crew']): readonly string[] {
  const specialists = useSpecialists()
  return useMemo(
    () =>
      crew.names === 'custom'
        ? crew.custom
        : crew.names === 'specialists'
          ? (specialists ?? []).map((s) => s.name)
          : [],
    [crew.names, crew.custom, specialists],
  )
}
/** Call states in which someone can be heard, so the screen shows the equaliser. */
const CALL_LIVE: ReadonlySet<CallState> = new Set(['listening', 'hearing', 'thinking', 'speaking', 'muted'])

/** A clip playing on the mascot's screen, and the emotion (status line and colour) it shows meanwhile. */
interface Act {
  clip: Clip
  id: number
  emotion?: Emotion
  /** What follows once it has played to the end. */
  after?: () => void
}

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
export const resolveColor = (color: string) => {
  const token = /^var\((--[\w-]+)\)$/.exec(color)?.[1]
  return token ? readToken(token) : color
}

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** Pixel offset from the face's center → where the eyes point, in cells. */
export const gaze = (dx: number, dy: number): [number, number] => [
  clamp(Math.round(dx / 110), -2, 2),
  clamp(Math.round(dy / 90), -1, 1),
]

/**
 * What the mascot's screen spells out of the message box: the draft from the moment the person
 * types, until they stop for `idleMs` or clear the box, when its eyes come back. A draft already there when the
 * screen opens is not typing, so it does not show. The screen follows the box at most every `throttleMs`.
 */
export function useTypedText(
  draft: string,
  idleMs: number = MASCOT_TYPING.idleMs,
  throttleMs: number = MASCOT_TYPING.throttleMs,
): string | undefined {
  const [shown, setShown] = useState<string>()
  const before = useRef(draft)
  const lastShown = useRef(0)
  const trailing = useRef<ReturnType<typeof setTimeout>>(undefined)
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (draft === before.current) return
    before.current = draft
    clearTimeout(idle.current)
    clearTimeout(trailing.current)
    if (!draft.trim()) return setShown(undefined)
    const show = () => {
      lastShown.current = Date.now()
      setShown(draft)
    }
    const wait = throttleMs - (Date.now() - lastShown.current)
    if (wait <= 0) show()
    else trailing.current = setTimeout(show, wait)
    idle.current = setTimeout(() => {
      clearTimeout(trailing.current)
      setShown(undefined)
    }, idleMs)
  }, [draft, idleMs, throttleMs])
  useEffect(
    () => () => {
      clearTimeout(idle.current)
      clearTimeout(trailing.current)
    },
    [],
  )
  return shown
}

/**
 * The colour the typed letters take: `base` (the eyes' colour) to begin with, then another of the mascot's colours
 * after every few words, a random count in MASCOT_TYPING.colorEveryWords. Clearing the box starts again from `base`.
 */
export function useTypingColor(
  draft: string,
  base: string,
  palette: readonly string[] = Object.values(MASCOT_COLORS),
  random: () => number = Math.random,
): string {
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0
  const [min, max] = MASCOT_TYPING.colorEveryWords
  const gap = () => min + Math.floor(random() * (max - min + 1))
  const state = useRef<{ color?: string; next: number }>({ next: gap() })
  if (words === 0) state.current = { next: gap() }
  else if (words > state.current.next) {
    const current = state.current.color ?? base
    const others = palette.filter((c) => c !== current)
    const color = others[Math.floor(random() * others.length)] ?? current
    state.current = { color, next: words + gap() - 1 }
  }
  return state.current.color ?? base
}

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
 * The new-chat view: the mascot on its screen, a one-line greeting, the message box, a few starters and the latest
 * chats. The mascot follows the pointer with its eyes, reacts when clicked or poked by its crew, plays small tricks
 * when left alone, and dozes off after a while.
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
  /** The setup assistant just closed: its mascot settles into this one's place, so this one does not pop in too. */
  fromSetup?: boolean
  /** A voice call from this window, by its state: while someone can be heard, the screen shows an equaliser. */
  call?: CallState
  children: ReactNode
}) {
  const reduce = useReducedMotionConfig()
  const roomy = useTallerThan(HERO_MASCOT_MIN_HEIGHT)
  const mascot = useMascotLook()
  const mascotRef = useRef(mascot)
  mascotRef.current = mascot
  const calm = mascot.temper === 'calm'
  const sounds = useMascotSounds(mascot.sounds)
  const crewNames = useCrewNames(mascot.crew)
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
  // Asleep long enough, its screen turns into the Game of Life.
  const [dreaming, setDreaming] = useState(false)
  // The screen switches on with a scanline, unless setup's mascot is settling into its place.
  const [act, setAct] = useState<Act | undefined>(() =>
    reduce || props.fromSetup || !mascot.shows.boot ? undefined : { clip: boot(), id: 0 },
  )
  const actRef = useRef(act)
  actRef.current = act
  const acts = useRef(0)
  const clicks = useRef<number[]>([])
  const [hover, setHover] = useState(false)
  const [look, setLook] = useState<[number, number]>()
  // Each knock (five quick clicks) sends the whole crew tumbling down.
  const [knocked, setKnocked] = useState(0)
  const canvas = useRef<HTMLDivElement>(null)
  const lastUser = useRef(Date.now())
  const asleepRef = useRef(false)
  const typing = props.draft.trim().length > 0
  const typed = useTypedText(props.draft)
  const typingRef = useRef(typing)
  typingRef.current = typing
  const reactionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const busy = useRef(act !== undefined)
  const callLive = props.call !== undefined && CALL_LIVE.has(props.call)
  const callRef = useRef(props.call)
  callRef.current = props.call
  const moodRef = useRef<Emotion['mood']>('idle')

  const wake = useCallback(() => {
    asleepRef.current = false
    setAsleep(false)
    setDreaming(false)
  }, [])
  const bounce = useCallback(() => {
    if (!reduce && !calm && scope.current)
      void animate(scope.current, { scale: [1, 0.965, 1.012, 1] }, { duration: 0.45, ease: 'easeOut' })
  }, [animate, reduce, calm, scope])
  const react = useCallback(
    (r: Emotion) => {
      wake()
      setAct(undefined)
      setReaction(r)
      busy.current = true
      bounce()
      sounds.react(DOWNCAST.has(r) ? 'down' : 'up')
      clearTimeout(reactionTimer.current)
      reactionTimer.current = setTimeout(() => {
        setReaction(undefined)
        busy.current = false
      }, MASCOT_REACTIONS.ms)
    },
    [bounce, wake, sounds],
  )
  /** Plays a clip on the screen with an emotion; with reduced motion only the emotion shows, as a plain reaction. */
  const perform = useCallback(
    (a: Omit<Act, 'id'>) => {
      if (reduce) {
        if (a.emotion) react(a.emotion)
        return
      }
      wake()
      clearTimeout(reactionTimer.current)
      busy.current = true
      setReaction(a.emotion)
      acts.current += 1
      setAct({ ...a, id: acts.current })
      if (a.emotion) {
        bounce()
        sounds.react(DOWNCAST.has(a.emotion) ? 'down' : 'up')
      }
    },
    [bounce, react, reduce, wake, sounds],
  )
  const endAct = useCallback(() => {
    const ended = actRef.current
    setAct(undefined)
    setReaction(undefined)
    busy.current = false
    ended?.after?.()
  }, [])
  /** A reaction, drawn: startled eyes jump with "!!", dizzy ones spiral; the rest show as their mood. */
  const reactTo = useCallback(
    (e: Emotion) => {
      if (e === EMOTIONS.surprised) perform({ clip: BANG, emotion: e })
      else if (e === EMOTIONS.dizzy) perform({ clip: spiralEyes(MASCOT_REACTIONS.ms), emotion: e })
      else react(e)
    },
    [perform, react],
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
      if (asleepRef.current) reactTo(EMOTIONS.surprised)
      // Shaking the pointer back and forth makes a playful mascot dizzy.
      if (mascotRef.current.temper === 'calm') return
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
          reactTo(EMOTIONS.dizzy)
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [reactTo, scope])

  // Dozing off, and the occasional trick while nobody is around: something its eyes do, now and then a show.
  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => {
      const quiet = Date.now() - lastUser.current
      if (quiet > MASCOT_USER_FOCUS_MS) setLook((l) => (l && !busy.current ? undefined : l))
      if (typingRef.current || busy.current || asleepRef.current) return
      if (callRef.current && CALL_LIVE.has(callRef.current)) return
      if (quiet > MASCOT_DOZE_MS) {
        asleepRef.current = true
        setAsleep(true)
      } else if (moodRef.current === 'idle' && Math.random() < MASCOT_IDLE.chance[mascotRef.current.idle]) {
        const m = mascotRef.current
        const playful = m.temper === 'playful'
        const show = playful && m.shows.pacman && Math.random() < MASCOT_IDLE.showShare
        perform({ clip: show ? pacman() : pick(playful ? IDLE_CLIPS : CALM_CLIPS) })
      }
    }, MASCOT_IDLE.everyMs)
    return () => clearInterval(t)
  }, [perform, reduce])

  useEffect(() => {
    if (!asleep || reduce || !mascot.shows.life) return
    const t = setTimeout(() => setDreaming(true), MASCOT_SHOWS.life.afterMs)
    return () => clearTimeout(t)
  }, [asleep, reduce, mascot.shows.life])

  // A run that finishes while the screen is open gets confetti and star eyes; one that fails, tears.
  const news = props.latest ? `${props.latest.status}@${props.latest.updatedAt}` : ''
  const seenNews = useRef(news)
  useEffect(() => {
    if (news === seenNews.current) return
    seenNews.current = news
    const status = props.latest?.status
    if (!status) return
    const mood = moodFor(status)
    if (mood === 'happy')
      perform({
        clip: mascotRef.current.shows.confetti ? chain('celebrate', confetti(), starEyes()) : starEyes(),
        emotion: EMOTIONS.proud,
      })
    else if (mood === 'error') perform({ clip: tears(), emotion: EMOTIONS.sad })
  }, [news, perform, props.latest?.status])

  const tap = (cell: readonly [number, number]) => {
    lastUser.current = Date.now()
    const now = Date.now()
    if (actRef.current?.clip.name === 'confused') return
    clicks.current = [...clicks.current.filter((t) => now - t < MASCOT_TOUCH.confusedWindowMs), now]
    if (clicks.current.length >= MASCOT_TOUCH.confusedClicks) {
      clicks.current = []
      perform({
        clip: { ...spiralEyes(MASCOT_TOUCH.confusedMs), name: 'confused' },
        emotion: EMOTIONS.confused,
      })
      if (!reduce && !calm) setKnocked((n) => n + 1)
      return
    }
    perform({ clip: ripple(cell[0], cell[1], lookAt(cell[0], cell[1])) })
  }

  const emotion: Emotion =
    reaction ??
    (typing
      ? readDraft(props.draft)
      : callLive
        ? EMOTIONS.onCall
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
  // The colour the person chose is the mascot's own, or the theme's accent if they tied it to the theme (a token, so it
  // follows a theme change by itself); its moods still bring theirs.
  const own = mascot.display.eyeColor === 'theme' ? 'var(--accent)' : MASCOT_COLORS[mascot.color]
  const eyes = useMemo(
    () => (emotion.color === LEAD_COLOR ? own : resolveColor(emotion.color)),
    [emotion.color, own],
  )
  const typedColor = useTypingColor(props.draft, eyes)
  // A soft tick as each change to the draft shows on the screen, when sounds are on.
  const typedSeen = useRef(typed)
  useEffect(() => {
    if (typed === typedSeen.current) return
    typedSeen.current = typed
    if (typed !== undefined) sounds.type()
  }, [typed, sounds])
  moodRef.current = emotion.mood

  // What plays on the screen while nothing else does: the equaliser on a call, z's or the Game of Life while it
  // sleeps, a sweat drop while it is worried, flames while several crews work at once.
  const concerned = emotion === EMOTIONS.concerned || emotion === EMOTIONS.sad
  const backdrop = reduce
    ? undefined
    : callLive
      ? 'equaliser'
      : asleep
        ? dreaming
          ? 'life'
          : 'zzz'
        : typed !== undefined
          ? undefined
          : concerned
            ? 'sweat'
            : props.working >= MASCOT_REACTIONS.fireAt && emotion.mood === 'working'
              ? 'fire'
              : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: a backdrop is made once each time it starts showing
  const backdropClip = useMemo((): Clip | undefined => {
    if (backdrop === 'equaliser')
      return equaliser(() =>
        // The mic's level while the person can be heard; while the voice speaks or thinks, a lively stand-in.
        callRef.current === 'speaking'
          ? 0.35 + Math.random() * 0.5
          : callRef.current === 'thinking'
            ? 0.12
            : micLevel() * MASCOT_SHOWS.equaliser.gain,
      )
    if (backdrop === 'life')
      return life(eyeCells('idle', MASCOT_GRID.cols, MASCOT_GRID.rows, 0, false, [0, 0], mascot.eyes))
    if (backdrop === 'zzz') return ZZZ
    if (backdrop === 'sweat') return SWEAT
    if (backdrop === 'fire') return fire()
    return undefined
  }, [backdrop])
  const shown = act?.clip ?? backdropClip
  // The crew takes its cue from the mascot: startled, they scatter; happy, they come close; asleep, they creep up.
  const signal: CrewSignal = asleep
    ? 'sneak'
    : reaction === EMOTIONS.surprised || reaction === EMOTIONS.popped
      ? 'scatter'
      : emotion.mood === 'happy' || emotion.mood === 'love'
        ? 'gather'
        : 'roam'
  // A question being typed: one eye turns into a "?" once the screen is back from spelling it out.
  const asking = typing && typed === undefined && emotion === EMOTIONS.curious

  return (
    <div ref={canvas} className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain">
      <div className="m-auto flex w-full max-w-[720px] flex-col items-center px-6 py-8">
        {roomy && (
          <div className="relative">
            {/* Shares its layout id with the setup assistant's mascot, which shrinks into this place as setup ends. */}
            <motion.div
              layoutId={MASCOT_LAYOUT_ID}
              initial={props.fromSetup ? false : { opacity: 0, y: 12, scale: 0.94 }}
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
                <MascotScreen
                  label={copy.hero.poke}
                  mood={emotion.mood}
                  color={typed !== undefined ? typedColor : eyes}
                  eyes={mascot.eyes}
                  display={mascot.display}
                  {...(look ? { look } : {})}
                  {...(typed !== undefined ? { text: typed } : {})}
                  {...(asking ? { tweak: { mood: 'idle', shape: ['open', 'ask'], look: [-1, -1] } } : {})}
                  {...(shown ? { clip: shown, playId: act ? act.id : shown.name } : {})}
                  onClipEnd={endAct}
                  onTap={tap}
                  onPress={() => reactTo(pick(POKED))}
                  onDoubleTap={() => {
                    if (actRef.current?.clip.name !== 'confused')
                      perform({ clip: SNEEZE_CLIP, emotion: EMOTIONS.sneeze })
                  }}
                  onHold={() =>
                    perform({
                      clip: charge(),
                      emotion: EMOTIONS.charging,
                      after: () => perform({ clip: pop(), emotion: EMOTIONS.popped }),
                    })
                  }
                  onRelease={() => {
                    // Let go before it is full, the charge fizzles out.
                    if (actRef.current?.clip.name === 'charge') {
                      setAct(undefined)
                      setReaction(undefined)
                      busy.current = false
                    }
                  }}
                />
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

            {mascot.crew.show && (
              <motion.div
                className="pointer-events-none absolute left-1/2 top-1/2 z-10 hidden lg:block"
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.3 }}
              >
                <HeroCrew
                  key={JSON.stringify([mascot.crew.count, crewNames, mascot.crew.boldness])}
                  count={mascot.crew.count}
                  names={crewNames}
                  boldness={mascot.crew.boldness}
                  signal={signal}
                  {...(look ? { look } : {})}
                  typing={typing}
                  knocked={knocked}
                  face={scope}
                  canvas={canvas}
                  onPoke={() => reactTo(pick(POKED))}
                  onWatch={(x, y) => {
                    if (Date.now() - lastUser.current > MASCOT_USER_FOCUS_MS) setLook(gaze(x, y))
                  }}
                />
              </motion.div>
            )}
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
