/**
 * Computer use's one action set, and the adapters that turn each provider's computer tool into it: OpenAI's native
 * `computer` tool (pi-ai hands its batched actions over as the call's metadata), Anthropic's computer toolset (one
 * tool call per member: `left_click`, `scroll`…), and the generic `computer` function tool every other model gets.
 * Also the one place screenshots are sized for a model: the driver downscales to the size asked for and maps
 * coordinates back itself (Retina included), so a model's coordinates are always in the screenshot it was shown.
 */
import type { ComputerAction as OpenAiAction } from '@oh-my-pi/pi-ai'
import {
  ANTHROPIC_COMPUTER_TOOLSET,
  ANTHROPIC_LARGE_IMAGE_MODELS,
  ANTHROPIC_TOOLSET_MODELS,
  COMPUTER_IMAGE_LIMITS,
  COMPUTER_MAX_WAIT_S,
} from '../config.ts'

export type MouseButton = 'left' | 'right' | 'middle'
export type Direction = 'up' | 'down' | 'left' | 'right'
export type Point = readonly [number, number]

/** What an agent can do on the desktop, whichever model asked for it. */
export type DesktopAction =
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'elements'; readonly query?: string }
  | {
      readonly kind: 'click'
      readonly at?: Point
      readonly button: MouseButton
      readonly count: 1 | 2 | 3
      readonly modifiers: readonly string[]
    }
  | {
      readonly kind: 'click_element'
      readonly element: number
      readonly button: MouseButton
      readonly count: 1 | 2
    }
  | { readonly kind: 'move'; readonly at: Point }
  | { readonly kind: 'drag'; readonly from: Point; readonly to: Point }
  | {
      readonly kind: 'scroll'
      readonly at?: Point
      readonly element?: number
      readonly direction: Direction
      readonly amount: number
    }
  | { readonly kind: 'type'; readonly text: string; readonly element?: number }
  | { readonly kind: 'key'; readonly keys: readonly string[]; readonly repeat: number }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'zoom'; readonly region: readonly [number, number, number, number] }
  | { readonly kind: 'cursor' }
  | { readonly kind: 'open_app'; readonly app: string; readonly fullControl: boolean }
  | { readonly kind: 'list_apps' }

/** An action no adapter can turn into a desktop one; the model is told why. */
export class UnsupportedAction extends Error {}

const MODIFIERS: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  super: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'option',
  option: 'option',
  opt: 'option',
  shift: 'shift',
  fn: 'fn',
}

const KEYS: Record<string, string> = {
  return: 'return',
  enter: 'return',
  kp_enter: 'return',
  backspace: 'delete',
  delete: 'delete',
  del: 'delete',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  space: 'space',
  ' ': 'space',
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  page_up: 'pageup',
  prior: 'pageup',
  pagedown: 'pagedown',
  page_down: 'pagedown',
  next: 'pagedown',
}

/** One key or modifier as the driver names it: xdotool names (Claude), DOM names, OpenAI's upper case. */
export function keyName(raw: string): string {
  const k = raw.trim().toLowerCase()
  if (MODIFIERS[k]) return MODIFIERS[k]
  if (KEYS[k]) return KEYS[k]
  if (/^f([1-9]|1[0-2])$/.test(k)) return k
  if (k.length === 1) return k
  throw new UnsupportedAction(`unknown key "${raw}"`)
}

export const isModifier = (key: string) => Object.values(MODIFIERS).includes(key)

/** A combo written as "cmd+shift+s" (or "ctrl+s", "Return") as driver key names, modifiers first. */
export function parseCombo(combo: string): string[] {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) throw new UnsupportedAction('no key given')
  return orderKeys(parts.map(keyName))
}

function orderKeys(keys: readonly string[]): string[] {
  const mods = keys.filter(isModifier)
  const rest = keys.filter((k) => !isModifier(k))
  if (rest.length !== 1)
    throw new UnsupportedAction(`a key press is one key with optional modifiers, not "${keys.join('+')}"`)
  return [...new Set(mods), ...rest]
}

const modifiersOf = (text: unknown): string[] =>
  typeof text === 'string' && text.trim() ? text.split('+').map(keyName).filter(isModifier) : []

function point(value: unknown, name: string): Point {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    return [Math.round(value[0] as number), Math.round(value[1] as number)]
  throw new UnsupportedAction(`${name} must be [x, y] in screenshot pixels`)
}

const optionalPoint = (value: unknown, name: string): Point | undefined =>
  value === undefined || value === null ? undefined : point(value, name)

function direction(value: unknown): Direction {
  if (value === 'up' || value === 'down' || value === 'left' || value === 'right') return value
  throw new UnsupportedAction('scroll_direction must be up, down, left or right')
}

const amount = (value: unknown, fallback: number, max: number) =>
  Math.max(
    1,
    Math.min(max, Math.round(typeof value === 'number' && Number.isFinite(value) ? value : fallback)),
  )

const seconds = (value: unknown) =>
  Math.max(0, Math.min(COMPUTER_MAX_WAIT_S, typeof value === 'number' && Number.isFinite(value) ? value : 1))

function element(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw new UnsupportedAction('element must be the number of an element from the latest screenshot')
}

/** Names of the generic tool's actions, which follow Claude's computer tool so models trained on it feel at home. */
export const GENERIC_ACTIONS = [
  'screenshot',
  'elements',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'click_element',
  'mouse_move',
  'left_click_drag',
  'scroll',
  'type',
  'key',
  'wait',
  'zoom',
  'cursor_position',
] as const

const CLICKS: Record<string, { button: MouseButton; count: 1 | 2 | 3 }> = {
  left_click: { button: 'left', count: 1 },
  right_click: { button: 'right', count: 1 },
  middle_click: { button: 'middle', count: 1 },
  double_click: { button: 'left', count: 2 },
  triple_click: { button: 'left', count: 3 },
}

/**
 * The generic `computer` tool's call (and an Anthropic toolset member, or the `open_app` and `list_apps` tools, which
 * are the same input without `action`) as a desktop action. `text` carries modifier keys on clicks and scrolls, the
 * text to type, or the combo to press.
 */
export function fromGeneric(action: string, input: Record<string, unknown>): DesktopAction {
  const click = CLICKS[action]
  if (click) {
    const at = optionalPoint(input.coordinate, 'coordinate')
    return { kind: 'click', ...(at ? { at } : {}), ...click, modifiers: modifiersOf(input.text) }
  }
  switch (action) {
    case 'screenshot':
      return { kind: 'screenshot' }
    case 'elements':
      return {
        kind: 'elements',
        ...(typeof input.query === 'string' && input.query ? { query: input.query } : {}),
      }
    case 'click_element':
      return {
        kind: 'click_element',
        element: element(input.element),
        button: input.button === 'right' ? 'right' : 'left',
        count: input.count === 2 ? 2 : 1,
      }
    case 'mouse_move':
      return { kind: 'move', at: point(input.coordinate, 'coordinate') }
    case 'left_click_drag':
      return {
        kind: 'drag',
        from: point(input.start_coordinate, 'start_coordinate'),
        to: point(input.coordinate, 'coordinate'),
      }
    case 'scroll': {
      const at = optionalPoint(input.coordinate, 'coordinate')
      return {
        kind: 'scroll',
        ...(at ? { at } : {}),
        ...(input.element !== undefined ? { element: element(input.element) } : {}),
        direction: direction(input.scroll_direction),
        amount: amount(input.scroll_amount, 3, 50),
      }
    }
    case 'type':
      if (typeof input.text !== 'string' || !input.text) throw new UnsupportedAction('type needs text')
      return {
        kind: 'type',
        text: input.text,
        ...(input.element !== undefined ? { element: element(input.element) } : {}),
      }
    case 'key':
      if (typeof input.text !== 'string')
        throw new UnsupportedAction('key needs text, e.g. "cmd+s" or "Return"')
      return { kind: 'key', keys: parseCombo(input.text), repeat: amount(input.repeat, 1, 100) }
    case 'wait':
      return { kind: 'wait', seconds: seconds(input.duration) }
    case 'zoom': {
      const r = input.region
      if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number'))
        throw new UnsupportedAction('zoom needs region [x0, y0, x1, y1] in screenshot pixels')
      const [x0, y0, x1, y1] = r as number[]
      return { kind: 'zoom', region: [x0 ?? 0, y0 ?? 0, x1 ?? 0, y1 ?? 0] }
    }
    case 'cursor_position':
      return { kind: 'cursor' }
    case 'open_app':
      if (typeof input.app !== 'string' || !input.app.trim())
        throw new UnsupportedAction('open_app needs app: its name or bundle id')
      return { kind: 'open_app', app: input.app.trim(), fullControl: input.full_control === true }
    case 'list_apps':
      return { kind: 'list_apps' }
    case 'left_mouse_down':
    case 'left_mouse_up':
      throw new UnsupportedAction(`${action} is not supported here: use left_click_drag to drag`)
    case 'hold_key':
      throw new UnsupportedAction('hold_key is not supported here: use key with a combo, e.g. "shift+tab"')
    default:
      throw new UnsupportedAction(`unknown action "${action}"`)
  }
}

/** Pixels of an OpenAI scroll that make one wheel notch. */
const SCROLL_NOTCH_PX = 100

/** OpenAI's native computer actions (one call can batch several) as desktop actions. */
export function fromOpenAi(actions: readonly OpenAiAction[]): DesktopAction[] {
  return actions.map((a): DesktopAction => {
    switch (a.type) {
      case 'click': {
        if (a.button === 'back' || a.button === 'forward')
          throw new UnsupportedAction(
            `the ${a.button} mouse button is not supported here: use key cmd+[ or cmd+]`,
          )
        return {
          kind: 'click',
          at: [Math.round(a.x), Math.round(a.y)],
          button: a.button === 'wheel' ? 'middle' : a.button,
          count: 1,
          modifiers: (a.keys ?? []).map(keyName).filter(isModifier),
        }
      }
      case 'double_click':
        return {
          kind: 'click',
          at: [Math.round(a.x), Math.round(a.y)],
          button: 'left',
          count: 2,
          modifiers: (a.keys ?? []).map(keyName).filter(isModifier),
        }
      case 'drag': {
        const from = a.path[0]
        const to = a.path.at(-1)
        if (!from || !to || a.path.length < 2)
          throw new UnsupportedAction('drag needs a path of at least two points')
        return {
          kind: 'drag',
          from: [Math.round(from.x), Math.round(from.y)],
          to: [Math.round(to.x), Math.round(to.y)],
        }
      }
      case 'keypress':
        return { kind: 'key', keys: orderKeys(a.keys.map(keyName)), repeat: 1 }
      case 'move':
        return { kind: 'move', at: [Math.round(a.x), Math.round(a.y)] }
      case 'screenshot':
        return { kind: 'screenshot' }
      case 'scroll': {
        const vertical = Math.abs(a.scroll_y) >= Math.abs(a.scroll_x)
        const delta = vertical ? a.scroll_y : a.scroll_x
        return {
          kind: 'scroll',
          at: [Math.round(a.x), Math.round(a.y)],
          direction: vertical ? (delta < 0 ? 'up' : 'down') : delta < 0 ? 'left' : 'right',
          amount: amount(Math.abs(delta) / SCROLL_NOTCH_PX, 1, 50),
        }
      }
      case 'type':
        return { kind: 'type', text: a.text }
      case 'wait':
        return { kind: 'wait', seconds: 2 }
      default:
        throw new UnsupportedAction(`unknown action "${(a as { type: string }).type}"`)
    }
  })
}

/** Members of Anthropic's computer toolset, which arrive as tool calls of their own name. */
export const ANTHROPIC_MEMBERS = new Set([
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
])

/** How a model's computer tool reaches it: OpenAI's native tool, Anthropic's toolset, or the generic function tool. */
export type ComputerProtocol = 'openai' | 'anthropic' | 'generic'

interface ModelInfo {
  readonly id: string
  readonly api: string
  readonly provider: string
  readonly supportsComputerUse?: boolean
  readonly compat?: unknown
}

export function computerProtocol(model: ModelInfo): ComputerProtocol {
  if (model.supportsComputerUse === true) return 'openai'
  // The toolset is generally available on the Claude API and Google Cloud only; Bedrock has the beta versions.
  if (
    model.api === 'anthropic-messages' &&
    !(model.compat as { bedrockMessagesApi?: boolean } | undefined)?.bedrockMessagesApi &&
    !/bedrock/.test(model.provider) &&
    ANTHROPIC_TOOLSET_MODELS.test(model.id)
  )
    return 'anthropic'
  return 'generic'
}

export interface ImageLimits {
  readonly longEdge: number
  readonly megapixels: number
}

export function imageLimits(model: Pick<ModelInfo, 'id' | 'api'>): ImageLimits {
  const claude = model.api === 'anthropic-messages' || /claude/.test(model.id)
  if (!claude) return COMPUTER_IMAGE_LIMITS.default
  return ANTHROPIC_LARGE_IMAGE_MODELS.test(model.id)
    ? COMPUTER_IMAGE_LIMITS.claudeLarge
    : COMPUTER_IMAGE_LIMITS.claude
}

/**
 * The long edge to ask the driver for, so a window's screenshot fits the model's limits on both edge and area. The
 * window's size in points gives its shape; the driver captures at the display's backing scale (2x on Retina) and
 * downscales to this, then maps the model's coordinates back to the window itself.
 */
export function screenshotEdge(window: { width: number; height: number }, limits: ImageLimits): number {
  const long = Math.max(1, window.width, window.height)
  const short = Math.max(1, Math.min(window.width, window.height))
  const byArea = Math.sqrt(limits.megapixels * 1_000_000 * (long / short))
  return Math.max(1, Math.floor(Math.min(limits.longEdge, byArea)))
}

/** Whether a point lies inside a screenshot of this size. */
export const inside = (at: Point, size: { width: number; height: number }) =>
  at[0] >= 0 && at[1] >= 0 && at[0] < size.width && at[1] < size.height

/**
 * Anthropic's toolset in a request in place of the generic `computer` function tool, and `toolset_name` on the
 * history's member calls and their results, as the toolset requires. pi-ai knows only plain tools, so this rewrites
 * the request body it built (its `onPayload` hook); undefined when the request has no computer tool.
 */
export function anthropicToolsetPayload(params: unknown): unknown {
  const body = params as {
    tools?: { name?: string; cache_control?: unknown }[]
    messages?: { role: string; content: unknown }[]
  }
  const at = body.tools?.findIndex((t) => t.name === 'computer') ?? -1
  if (!body.tools || at < 0) return undefined
  const old = body.tools[at]
  const tools = [...body.tools]
  tools[at] = {
    type: ANTHROPIC_COMPUTER_TOOLSET,
    ...(old?.cache_control ? { cache_control: old.cache_control } : {}),
  } as never
  const members = new Set<string>()
  const messages = (body.messages ?? []).map((m) => {
    if (!Array.isArray(m.content)) return m
    const content = (m.content as Record<string, unknown>[]).map((block) => {
      if (block.type === 'tool_use' && typeof block.name === 'string' && ANTHROPIC_MEMBERS.has(block.name)) {
        members.add(String(block.id))
        return { ...block, toolset_name: 'computer' }
      }
      if (block.type === 'tool_result' && members.has(String(block.tool_use_id)))
        return { ...block, toolset_name: 'computer' }
      return block
    })
    return { ...m, content }
  })
  return { ...body, tools, messages }
}
