import { EMOTIONS, type Emotion } from '../chat/emotion.ts'
import { copy } from '../copy.ts'
import { SETUP_MASCOT } from '../ui-config.ts'
import type { SetupScreen } from './state.ts'

/**
 * What the setup mascot does, as data: where it sits on each screen, what its eyes follow, the face it rests in and
 * what it plays as the screen opens, and how each reaction looks. The components only carry this out.
 */

/** Big and centred above the words, or beside the content. */
export type Place = 'center' | 'side'

/** `pointer`: the eyes follow the pointer; `controls`: they look at the control in focus or under the pointer. */
export type Gaze = 'pointer' | 'controls'

export type Reaction =
  | 'wink'
  | 'love'
  | 'hop'
  | 'worried'
  | 'nod'
  | 'curious'
  | 'ping'
  | 'shrug'
  | 'poked'
  | 'celebrate'

/** The setup's own faces, beside the moods the mascot has everywhere. */
export const SETUP_EMOTIONS = {
  yawn: { mood: 'surprised', color: 'var(--mood-sleepy)', label: copy.setup.mascot.yawn },
  thinking: { mood: 'thinking', color: 'var(--mood-curious)', label: copy.setup.mascot.thinking },
  worried: { mood: 'waiting', color: 'var(--mood-concerned)', label: copy.setup.mascot.worried },
  shrug: { mood: 'waiting', color: 'var(--mood-sleepy)', label: copy.setup.mascot.shrug },
  nod: { mood: 'happy', color: 'var(--mood-happy)', label: copy.setup.mascot.nod },
  ping: { mood: 'surprised', color: 'var(--mood-happy)', label: copy.setup.mascot.ping },
  celebrate: { mood: 'love', color: 'var(--mood-love)', label: copy.setup.mascot.celebrate },
} as const satisfies Record<string, Emotion>

export interface Choreography {
  place: Place
  gaze: Gaze
  /** The face it settles back to on this screen. */
  rest: Emotion
  /** Played as the screen opens. */
  enter?: Reaction
}

export const CHOREOGRAPHY: Record<SetupScreen, Choreography> = {
  // Wakes up in the middle, looks around, then at the person (WAKE_UP), and types its greeting.
  welcome: { place: 'center', gaze: 'pointer', rest: EMOTIONS.ready },
  // Watches the name field as it is typed in; reacts to each look it is given.
  you: { place: 'side', gaze: 'controls', rest: EMOTIONS.listening, enter: 'wink' },
  // Looks at providers as they are pointed at; thinks during the test; hops or worries at the answer.
  models: { place: 'side', gaze: 'controls', rest: EMOTIONS.curious },
  // Crewmates' cursors fly in to poke it as they are added.
  crew: { place: 'side', gaze: 'controls', rest: EMOTIONS.ready, enter: 'wink' },
  // Looks at the folder picker; nods at Ask first, curious at Read-only.
  project: { place: 'side', gaze: 'controls', rest: EMOTIONS.curious },
  // Its eyes pulse with the microphone; its screen counts the download.
  voice: { place: 'side', gaze: 'controls', rest: EMOTIONS.listening },
  // Glances at apps as they are pointed at; pings when one connects.
  channels: { place: 'side', gaze: 'controls', rest: EMOTIONS.ready },
  // Sends itself a test notification and reacts to it.
  alerts: { place: 'side', gaze: 'controls', rest: EMOTIONS.ready },
  // Watches the Install button; nods once the command is in.
  command: { place: 'side', gaze: 'controls', rest: EMOTIONS.curious },
  // Celebrates, then settles where the home screen keeps it.
  ready: { place: 'center', gaze: 'pointer', rest: EMOTIONS.happy, enter: 'celebrate' },
}

/** Keyframes for one reaction; each list starts and ends at rest. */
export type Keyframes = Partial<Record<'x' | 'y' | 'scale' | 'rotate', number[]>>

export const REACTIONS: Record<Reaction, { emotion: Emotion; motion: Keyframes }> = {
  wink: { emotion: EMOTIONS.wink, motion: { rotate: [0, -4, 0] } },
  love: { emotion: EMOTIONS.love, motion: { scale: [1, 1.07, 0.98, 1] } },
  hop: { emotion: EMOTIONS.happy, motion: { y: [0, -24, 0, -9, 0] } },
  worried: { emotion: SETUP_EMOTIONS.worried, motion: { x: [0, -5, 5, -3, 0] } },
  nod: { emotion: SETUP_EMOTIONS.nod, motion: { y: [0, 7, 0, 7, 0] } },
  curious: { emotion: EMOTIONS.curious, motion: { rotate: [0, 7, 0] } },
  ping: { emotion: SETUP_EMOTIONS.ping, motion: { scale: [1, 1.12, 1] } },
  shrug: { emotion: SETUP_EMOTIONS.shrug, motion: { y: [0, -6, 0], rotate: [0, -5, 5, 0] } },
  poked: { emotion: EMOTIONS.surprised, motion: { scale: [1, 0.965, 1.012, 1] } },
  celebrate: { emotion: SETUP_EMOTIONS.celebrate, motion: { y: [0, -30, 0, -12, 0], rotate: [0, -4, 4, 0] } },
}

/**
 * Waking up on Welcome, beat by beat: asleep, a yawn, eyes open looking one way and the other, then at the person
 * with a wink. `look` is where the eyes point, in cells.
 */
export const WAKE_UP: readonly { emotion: Emotion; look?: readonly [number, number] }[] = [
  { emotion: EMOTIONS.sleepy },
  { emotion: SETUP_EMOTIONS.yawn },
  { emotion: EMOTIONS.ready, look: [-2, 0] },
  { emotion: EMOTIONS.ready, look: [2, -1] },
  { emotion: EMOTIONS.wink, look: [0, 0] },
]

/** A reaction's motion, or none with less motion: the face still changes, in place. */
export function reactionMotion(reaction: Reaction, reduce: boolean): Keyframes | undefined {
  return reduce ? undefined : REACTIONS[reaction].motion
}

/** Where the mascot and the screen's content sit on the stage right of the step list. */
export interface StageLayout {
  /** The mascot's scale, and how far its centre is from the stage's centre line, in px. */
  scale: number
  x: number
  /** The mascot's top, in px from the stage's top. */
  top: number
  /** The content column: its width, its left edge, and the room it keeps above it and on its right (the mascot's). */
  content: { width: number; left: number; paddingTop: number; paddingRight: number }
}

/**
 * Lays the stage out. On Welcome and Ready the mascot sits above the content and the two are centred as one stack,
 * across and down. Elsewhere it sits beside the content, level with its top, and the pair is centred across but starts
 * at the same height (`sideTop`) on every step, so stepping through them does not move the heading and buttons up and
 * down; longer content scrolls. On a stage too narrow for the pair, it sits small above the content instead.
 */
export function stageLayout(input: {
  place: Place
  width: number
  height: number
  /** The mascot's height at full size, and the content's own height. */
  frameHeight: number
  contentHeight: number
}): StageLayout {
  const { edge, gap, contentMax, width: sizes, narrowBelow } = SETUP_MASCOT
  const room = Math.max(0, input.width - edge * 2)
  if (input.place === 'center') {
    const width = Math.min(contentMax, room)
    // A short window keeps it smaller, so the words under it still show.
    const scale = input.height > 0 && input.height < SETUP_MASCOT.shortBelow ? SETUP_MASCOT.shortScale : 1
    const frame = input.frameHeight * scale
    const top = Math.max(edge, (input.height - (frame + gap + input.contentHeight)) / 2)
    return {
      scale,
      x: 0,
      top,
      content: {
        width,
        left: (input.width - width) / 2,
        paddingTop: top + frame + gap,
        paddingRight: 0,
      },
    }
  }
  if (input.width < SETUP_MASCOT.stackBelow) {
    // Too narrow to sit beside the content: smaller, above it, with the content as wide as the stage allows.
    const scale = sizes.stacked / sizes.center
    const side = SETUP_MASCOT.stackEdge
    const width = Math.min(contentMax, Math.max(0, input.width - side * 2))
    const top = side
    return {
      scale,
      x: 0,
      top,
      content: {
        width,
        left: (input.width - width) / 2,
        paddingTop: top + input.frameHeight * scale + side,
        paddingRight: 0,
      },
    }
  }
  const mascot = input.width < narrowBelow ? sizes.narrowSide : sizes.side
  const scale = mascot / sizes.center
  const column = Math.max(0, Math.min(contentMax, room - gap - mascot))
  const pair = column + gap + mascot
  const left = Math.max(edge, (input.width - pair) / 2)
  const top = SETUP_MASCOT.sideTop
  return {
    scale,
    x: left + column + gap + mascot / 2 - input.width / 2,
    top,
    content: { width: pair, left, paddingTop: top, paddingRight: gap + mascot },
  }
}

/**
 * How the mascot gets to its place on a new screen: it travels there on a spring, or with less motion it is simply
 * there (set as its style, not animated: reduced motion skips transform animations, so an animated place would never
 * be reached). `instant` puts it in place without travelling, for where it first appears.
 */
export function placement<T extends Record<string, number>>(
  target: T,
  reduce: boolean,
  instant = false,
): { style: T } | { animate: T; transition: typeof SETUP_MASCOT.travel | { duration: 0 } } {
  if (reduce) return { style: target }
  return { animate: target, transition: instant ? { duration: 0 } : SETUP_MASCOT.travel }
}

/** How a screen comes in: sliding a little and fading, or with less motion only fading. */
export function screenMotion(reduce: boolean) {
  return reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, x: 16 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -12 } }
}
