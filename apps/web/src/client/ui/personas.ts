/*
 * The worker characters' cast: each persona is a plain rounded body and how it moves in each state. Their names, temperaments, emotes and status lines live in copy.ts (copy.avatars.personas);
 * crew.tsx draws them and avatar-bag.ts hands them out. Personality is shown only: no agent's prompt or behaviour
 * depends on which persona it wears.
 */

export const BODY_SHAPES = [
  'gumdrop',
  'ball',
  'cloud',
  'heart',
  'squircle',
  'pill',
  'bunny',
  'flower',
  'bear',
  'egg',
  'bean',
  'drop',
  'blob',
] as const
export type BodyShape = (typeof BODY_SHAPES)[number]

/** How the whole character moves while it rests, works, finishes and fails (CSS keyframes in styles.css). */
export type IdleMotion = 'still' | 'breathe' | 'bob' | 'sway' | 'bounce' | 'tilt' | 'wiggle' | 'float'
export type WorkMotion = 'steady' | 'nod' | 'bob' | 'lean' | 'jitter'
export type DoneMotion = 'nod' | 'hop' | 'spin' | 'wiggle' | 'grow'
export type ErrorMotion = 'shake' | 'droop' | 'flinch' | 'tremble'
/** How fast its moves and glances run (AVATARS.tempo in ui-config.ts). */
export type Tempo = 'slow' | 'steady' | 'brisk'
/** Where its eyes go while it works (side to side, down at the work, darting about) and while it thinks. */
export type WorkLook = 'scan' | 'focus' | 'dart'
export type ThinkLook = 'up' | 'side' | 'roll'

export interface Persona {
  readonly id: string
  readonly body: BodyShape
  readonly idle: IdleMotion
  readonly work: WorkMotion
  readonly done: DoneMotion
  readonly error: ErrorMotion
  readonly tempo: Tempo
  readonly workLook: WorkLook
  readonly thinkLook: ThinkLook
}

type Row = [
  id: string,
  body: BodyShape,
  idle: IdleMotion,
  work: WorkMotion,
  done: DoneMotion,
  error: ErrorMotion,
  tempo: Tempo,
  workLook: WorkLook,
  thinkLook: ThinkLook,
]

// Tempo and motion follow the temperament copy.ts gives each one: careful ones nod slowly, jumpy ones bounce.
const ROWS: Row[] = [
  ['pip', 'gumdrop', 'breathe', 'nod', 'hop', 'droop', 'steady', 'scan', 'up'],
  ['biscuit', 'ball', 'bob', 'bob', 'hop', 'flinch', 'brisk', 'dart', 'side'],
  ['mochi', 'squircle', 'breathe', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['rook', 'pill', 'still', 'steady', 'nod', 'shake', 'steady', 'focus', 'side'],
  ['juniper', 'cloud', 'float', 'bob', 'grow', 'droop', 'slow', 'scan', 'up'],
  ['sprocket', 'squircle', 'bounce', 'jitter', 'spin', 'shake', 'brisk', 'dart', 'roll'],
  ['hazel', 'heart', 'sway', 'nod', 'grow', 'droop', 'steady', 'scan', 'up'],
  ['clover', 'bunny', 'bounce', 'bob', 'hop', 'flinch', 'brisk', 'dart', 'side'],
  ['dahlia', 'flower', 'sway', 'nod', 'grow', 'droop', 'slow', 'scan', 'up'],
  ['boo', 'pill', 'float', 'bob', 'wiggle', 'tremble', 'steady', 'dart', 'side'],
  ['whiskers', 'bear', 'tilt', 'lean', 'wiggle', 'shake', 'steady', 'focus', 'side'],
  ['bruno', 'bear', 'breathe', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['humphrey', 'egg', 'still', 'lean', 'nod', 'tremble', 'steady', 'focus', 'up'],
  ['lima', 'bean', 'wiggle', 'jitter', 'hop', 'flinch', 'brisk', 'dart', 'roll'],
  ['dewey', 'drop', 'bob', 'bob', 'grow', 'droop', 'steady', 'scan', 'up'],
  ['morel', 'gumdrop', 'breathe', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['wobble', 'cloud', 'float', 'bob', 'wiggle', 'tremble', 'slow', 'scan', 'roll'],
  ['ribbit', 'bean', 'bounce', 'bob', 'hop', 'flinch', 'brisk', 'dart', 'side'],
  ['hoot', 'egg', 'still', 'lean', 'nod', 'shake', 'slow', 'focus', 'up'],
  ['twinkle', 'flower', 'wiggle', 'jitter', 'spin', 'shake', 'brisk', 'dart', 'up'],
  ['gloop', 'blob', 'wiggle', 'bob', 'wiggle', 'droop', 'steady', 'scan', 'side'],
  ['bao', 'blob', 'breathe', 'bob', 'hop', 'droop', 'slow', 'focus', 'up'],
  ['grit', 'squircle', 'still', 'jitter', 'nod', 'shake', 'brisk', 'focus', 'side'],
  ['percival', 'pill', 'still', 'lean', 'nod', 'flinch', 'slow', 'focus', 'up'],
  ['sunny', 'ball', 'float', 'bob', 'grow', 'droop', 'steady', 'scan', 'up'],
  ['imp', 'gumdrop', 'tilt', 'jitter', 'wiggle', 'shake', 'brisk', 'dart', 'side'],
  ['duke', 'bear', 'still', 'steady', 'nod', 'droop', 'slow', 'scan', 'up'],
  ['remix', 'squircle', 'bob', 'bob', 'wiggle', 'shake', 'steady', 'scan', 'side'],
  ['tinker', 'cloud', 'tilt', 'lean', 'spin', 'tremble', 'steady', 'dart', 'roll'],
  ['blaze', 'drop', 'bounce', 'jitter', 'hop', 'shake', 'brisk', 'dart', 'up'],
  ['pebble', 'egg', 'still', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['fizz', 'bean', 'bounce', 'jitter', 'spin', 'flinch', 'brisk', 'dart', 'roll'],
  ['maple', 'heart', 'breathe', 'nod', 'grow', 'droop', 'slow', 'scan', 'up'],
  ['cosmo', 'ball', 'float', 'lean', 'spin', 'tremble', 'steady', 'scan', 'roll'],
  ['thimble', 'bunny', 'tilt', 'lean', 'nod', 'tremble', 'steady', 'focus', 'side'],
  ['brick', 'squircle', 'still', 'steady', 'nod', 'droop', 'slow', 'focus', 'side'],
  ['pickle', 'pill', 'wiggle', 'jitter', 'hop', 'shake', 'brisk', 'dart', 'side'],
  ['velvet', 'bear', 'sway', 'lean', 'grow', 'droop', 'slow', 'scan', 'up'],
  ['sleuth', 'egg', 'tilt', 'lean', 'nod', 'shake', 'steady', 'scan', 'side'],
  ['marsh', 'blob', 'breathe', 'bob', 'hop', 'droop', 'slow', 'scan', 'up'],
  ['rumble', 'bean', 'still', 'steady', 'nod', 'shake', 'steady', 'focus', 'side'],
  ['wisp', 'pill', 'float', 'steady', 'grow', 'tremble', 'slow', 'scan', 'up'],
  ['zippy', 'flower', 'bounce', 'jitter', 'spin', 'flinch', 'brisk', 'dart', 'roll'],
  ['olive', 'blob', 'sway', 'bob', 'wiggle', 'droop', 'steady', 'focus', 'side'],
  ['blossom', 'flower', 'sway', 'bob', 'hop', 'flinch', 'steady', 'scan', 'up'],
  ['zap', 'cloud', 'bounce', 'jitter', 'spin', 'shake', 'brisk', 'dart', 'roll'],
  ['hopper', 'bunny', 'bounce', 'bob', 'hop', 'flinch', 'brisk', 'scan', 'up'],
  ['nimbus', 'cloud', 'float', 'steady', 'grow', 'droop', 'slow', 'scan', 'up'],
]

export const PERSONAS: readonly Persona[] = ROWS.map(
  ([id, body, idle, work, done, error, tempo, workLook, thinkLook]) => ({
    id,
    body,
    idle,
    work,
    done,
    error,
    tempo,
    workLook,
    thinkLook,
  }),
)

export const PERSONA_IDS: readonly string[] = PERSONAS.map((p) => p.id)

const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]))

export function personaById(id: string): Persona {
  return BY_ID.get(id) ?? (PERSONAS[0] as Persona)
}
