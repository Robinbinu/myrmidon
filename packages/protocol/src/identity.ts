/**
 * Agent identity: every worker gets a call sign, a colour, and a shape, so a colony reads like a crew.
 * Shared by the runtime (which picks names) and the UI (which draws them), so both agree.
 */

/** Call signs for workers. Each one owns a fixed colour slot: its index in this list modulo the palette. */
export const CALL_SIGNS = [
  'nova',
  'kai',
  'juno',
  'orion',
  'vega',
  'atlas',
  'lyra',
  'echo',
  'sol',
  'iris',
  'rho',
  'zephyr',
  'mira',
  'onyx',
  'pax',
  'quill',
  'rune',
  'sage',
  'tess',
  'ursa',
  'wren',
  'xeno',
  'yuki',
  'zara',
  'ada',
  'bix',
  'cleo',
  'dax',
  'ember',
  'flux',
  'gaia',
  'hex',
  'ion',
  'jett',
  'koda',
  'luma',
] as const

/** Worker colours, chosen to stay distinct from each other and from the lead's amber and the judge's lime. */
export const WORKER_PALETTE = [
  '#ff7eb6',
  '#4d7cff',
  '#a374ff',
  '#19c3e6',
  '#ff6a3d',
  '#2ed3a0',
  '#dcdce4',
  '#f25c8a',
] as const

export const LEAD_COLOR = '#ffb31a'
export const JUDGE_COLOR = '#d4ff3a'
export const USER_COLOR = '#e8e8ec'

function hash(text: string): number {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

/** The worker palette slot a name owns: by its call-sign position, or by hash for other names. */
export function colorSlot(name: string): number {
  // `nova-2` shares nova's slot; any other name (e.g. `worker-3` from older runs) hashes whole.
  const index = (CALL_SIGNS as readonly string[]).indexOf(name.replace(/-\d+$/, ''))
  return (index >= 0 ? index : hash(name)) % WORKER_PALETTE.length
}

/** Body shapes for worker characters; one per colour slot, so crewmates differ in both. */
export const FORMS = ['gumdrop', 'ball', 'cloud', 'heart', 'squircle', 'pill', 'bunny', 'flower'] as const
export type Form = (typeof FORMS)[number]

export interface Identity {
  readonly color: string
  readonly form: Form
}

/** Stable look for an agent: colour and body shape from its slot. */
export function identityOf(name: string): Identity {
  const color =
    name === 'lead'
      ? LEAD_COLOR
      : name === 'judge' || name.startsWith('verifier')
        ? JUDGE_COLOR
        : name === 'user' || name === 'You'
          ? USER_COLOR
          : (WORKER_PALETTE[colorSlot(name)] as string)
  return { color, form: FORMS[colorSlot(name) % FORMS.length] as Form }
}
