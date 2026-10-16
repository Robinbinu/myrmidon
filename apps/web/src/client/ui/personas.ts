/*
 * The worker characters' cast: each persona is a body, a pair of eyes, a mouth, a small accessory or two, and how it
 * moves in each state. Their names, temperaments, emotes and status lines live in copy.ts (copy.avatars.personas);
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
  'ghost',
  'cat',
  'bear',
  'egg',
  'bean',
  'drop',
  'mushroom',
  'jelly',
  'frog',
  'owl',
  'star',
  'blob',
  'dumpling',
] as const
export type BodyShape = (typeof BODY_SHAPES)[number]

export type EyeKind =
  | 'capsule'
  | 'dot'
  | 'tall'
  | 'wide'
  | 'sleepy'
  | 'big'
  | 'ring'
  | 'cyclops'
  | 'shades'
  | 'brows'
  | 'worried'
  | 'lashes'
export type MouthKind = 'none' | 'smile' | 'grin' | 'o' | 'cat' | 'fang' | 'flat'
export type Accessory =
  | 'sprout'
  | 'antenna'
  | 'bow'
  | 'beanie'
  | 'horns'
  | 'halo'
  | 'glasses'
  | 'headphones'
  | 'crown'
  | 'blush'
  | 'freckles'
  | 'mustache'
  | 'scarf'
  | 'monocle'
  | 'flower'
  | 'tuft'
  | 'party'
  | 'bandage'
  | 'star'

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
  readonly eyes: EyeKind
  readonly mouth: MouthKind
  readonly accessories: readonly Accessory[]
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
  eyes: EyeKind,
  mouth: MouthKind,
  accessories: Accessory[],
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
  ['pip', 'gumdrop', 'capsule', 'none', ['sprout'], 'breathe', 'nod', 'hop', 'droop', 'steady', 'scan', 'up'],
  ['biscuit', 'ball', 'dot', 'smile', ['blush'], 'bob', 'bob', 'hop', 'flinch', 'brisk', 'dart', 'side'],
  ['mochi', 'squircle', 'sleepy', 'none', [], 'breathe', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['rook', 'pill', 'brows', 'flat', [], 'still', 'steady', 'nod', 'shake', 'steady', 'focus', 'side'],
  ['juniper', 'cloud', 'lashes', 'smile', ['flower'], 'float', 'bob', 'grow', 'droop', 'slow', 'scan', 'up'],
  [
    'sprocket',
    'squircle',
    'wide',
    'grin',
    ['antenna'],
    'bounce',
    'jitter',
    'spin',
    'shake',
    'brisk',
    'dart',
    'roll',
  ],
  ['hazel', 'heart', 'capsule', 'smile', ['bow'], 'sway', 'nod', 'grow', 'droop', 'steady', 'scan', 'up'],
  ['clover', 'bunny', 'dot', 'cat', [], 'bounce', 'bob', 'hop', 'flinch', 'brisk', 'dart', 'side'],
  ['dahlia', 'flower', 'big', 'smile', [], 'sway', 'nod', 'grow', 'droop', 'slow', 'scan', 'up'],
  ['boo', 'ghost', 'big', 'o', [], 'float', 'bob', 'wiggle', 'tremble', 'steady', 'dart', 'side'],
  ['whiskers', 'cat', 'tall', 'cat', [], 'tilt', 'lean', 'wiggle', 'shake', 'steady', 'focus', 'side'],
  ['bruno', 'bear', 'dot', 'smile', ['scarf'], 'breathe', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  [
    'humphrey',
    'egg',
    'capsule',
    'o',
    ['glasses'],
    'still',
    'lean',
    'nod',
    'tremble',
    'steady',
    'focus',
    'up',
  ],
  ['lima', 'bean', 'wide', 'grin', ['tuft'], 'wiggle', 'jitter', 'hop', 'flinch', 'brisk', 'dart', 'roll'],
  ['dewey', 'drop', 'big', 'none', [], 'bob', 'bob', 'grow', 'droop', 'steady', 'scan', 'up'],
  ['morel', 'mushroom', 'sleepy', 'smile', [], 'breathe', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['wobble', 'jelly', 'dot', 'o', [], 'float', 'bob', 'wiggle', 'tremble', 'slow', 'scan', 'roll'],
  ['ribbit', 'frog', 'wide', 'grin', [], 'bounce', 'bob', 'hop', 'flinch', 'brisk', 'dart', 'side'],
  ['hoot', 'owl', 'ring', 'none', [], 'still', 'lean', 'nod', 'shake', 'slow', 'focus', 'up'],
  ['twinkle', 'star', 'capsule', 'grin', [], 'wiggle', 'jitter', 'spin', 'shake', 'brisk', 'dart', 'up'],
  ['gloop', 'blob', 'dot', 'smile', [], 'wiggle', 'bob', 'wiggle', 'droop', 'steady', 'scan', 'side'],
  ['bao', 'dumpling', 'sleepy', 'cat', ['blush'], 'breathe', 'bob', 'hop', 'droop', 'slow', 'focus', 'up'],
  [
    'grit',
    'squircle',
    'brows',
    'flat',
    ['bandage'],
    'still',
    'jitter',
    'nod',
    'shake',
    'brisk',
    'focus',
    'side',
  ],
  [
    'percival',
    'pill',
    'capsule',
    'none',
    ['monocle', 'mustache'],
    'still',
    'lean',
    'nod',
    'flinch',
    'slow',
    'focus',
    'up',
  ],
  ['sunny', 'ball', 'big', 'grin', ['halo'], 'float', 'bob', 'grow', 'droop', 'steady', 'scan', 'up'],
  [
    'imp',
    'gumdrop',
    'brows',
    'fang',
    ['horns'],
    'tilt',
    'jitter',
    'wiggle',
    'shake',
    'brisk',
    'dart',
    'side',
  ],
  ['duke', 'bear', 'capsule', 'smile', ['crown'], 'still', 'steady', 'nod', 'droop', 'slow', 'scan', 'up'],
  [
    'remix',
    'squircle',
    'shades',
    'smile',
    ['headphones'],
    'bob',
    'bob',
    'wiggle',
    'shake',
    'steady',
    'scan',
    'side',
  ],
  ['tinker', 'cloud', 'ring', 'o', ['antenna'], 'tilt', 'lean', 'spin', 'tremble', 'steady', 'dart', 'roll'],
  ['blaze', 'drop', 'brows', 'grin', [], 'bounce', 'jitter', 'hop', 'shake', 'brisk', 'dart', 'up'],
  ['pebble', 'egg', 'dot', 'none', ['freckles'], 'still', 'steady', 'nod', 'droop', 'slow', 'focus', 'up'],
  ['fizz', 'bean', 'big', 'o', ['party'], 'bounce', 'jitter', 'spin', 'flinch', 'brisk', 'dart', 'roll'],
  ['maple', 'heart', 'sleepy', 'smile', ['star'], 'breathe', 'nod', 'grow', 'droop', 'slow', 'scan', 'up'],
  [
    'cosmo',
    'ball',
    'cyclops',
    'none',
    ['antenna'],
    'float',
    'lean',
    'spin',
    'tremble',
    'steady',
    'scan',
    'roll',
  ],
  ['thimble', 'bunny', 'worried', 'o', [], 'tilt', 'lean', 'nod', 'tremble', 'steady', 'focus', 'side'],
  [
    'brick',
    'squircle',
    'dot',
    'flat',
    ['beanie'],
    'still',
    'steady',
    'nod',
    'droop',
    'slow',
    'focus',
    'side',
  ],
  [
    'pickle',
    'pill',
    'wide',
    'fang',
    ['freckles'],
    'wiggle',
    'jitter',
    'hop',
    'shake',
    'brisk',
    'dart',
    'side',
  ],
  ['velvet', 'cat', 'lashes', 'smile', ['bow'], 'sway', 'lean', 'grow', 'droop', 'slow', 'scan', 'up'],
  ['sleuth', 'owl', 'capsule', 'flat', ['monocle'], 'tilt', 'lean', 'nod', 'shake', 'steady', 'scan', 'side'],
  ['marsh', 'dumpling', 'dot', 'smile', ['beanie'], 'breathe', 'bob', 'hop', 'droop', 'slow', 'scan', 'up'],
  [
    'rumble',
    'frog',
    'brows',
    'flat',
    ['bandage'],
    'still',
    'steady',
    'nod',
    'shake',
    'steady',
    'focus',
    'side',
  ],
  ['wisp', 'ghost', 'sleepy', 'none', ['star'], 'float', 'steady', 'grow', 'tremble', 'slow', 'scan', 'up'],
  ['zippy', 'star', 'wide', 'o', ['tuft'], 'bounce', 'jitter', 'spin', 'flinch', 'brisk', 'dart', 'roll'],
  [
    'olive',
    'blob',
    'capsule',
    'smile',
    ['headphones'],
    'sway',
    'bob',
    'wiggle',
    'droop',
    'steady',
    'focus',
    'side',
  ],
  ['blossom', 'flower', 'dot', 'cat', ['blush'], 'sway', 'bob', 'hop', 'flinch', 'steady', 'scan', 'up'],
  ['zap', 'jelly', 'brows', 'grin', [], 'bounce', 'jitter', 'spin', 'shake', 'brisk', 'dart', 'roll'],
  ['hopper', 'bunny', 'big', 'smile', ['scarf'], 'bounce', 'bob', 'hop', 'flinch', 'brisk', 'scan', 'up'],
  ['nimbus', 'cloud', 'sleepy', 'o', ['halo'], 'float', 'steady', 'grow', 'droop', 'slow', 'scan', 'up'],
]

export const PERSONAS: readonly Persona[] = ROWS.map(
  ([id, body, eyes, mouth, accessories, idle, work, done, error, tempo, workLook, thinkLook]) => ({
    id,
    body,
    eyes,
    mouth,
    accessories,
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
