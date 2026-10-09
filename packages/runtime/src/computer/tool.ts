/**
 * The `computer` tool: an agent sees and controls the person's Mac through Cua Driver, one approved app at a time.
 * One tool serves every model: OpenAI's native computer tool (pi-ai sends it as one when the model supports it), the
 * same tool rewritten into Anthropic's computer toolset (see agent.ts), and a plain function tool for the rest. Each
 * call is gated here: computer use on in Settings, never for a channel member's round, macOS grants present, the app
 * approved for the chat at a tier that allows the action, and consequential steps approved by the person.
 */
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { type ComputerToolCallMetadata, type Model, type } from '@oh-my-pi/pi-ai'
import {
  COMPUTER_ELEMENTS_SHOWN,
  COMPUTER_ELEMENTS_WALKED,
  COMPUTER_OWN_WINDOW_TITLE,
  COMPUTER_SCRIPT_APPS,
  COMPUTER_SCRIPT_KEYS,
  COMPUTER_SCRIPT_LABEL,
  COMPUTER_SENSITIVE_KEYS,
  COMPUTER_SENSITIVE_LABEL,
} from '../config.ts'
import { agentActor, type ColonyHost } from '../host.ts'
import { prompts } from '../prompts.ts'
import { redactSecrets } from '../secrets.ts'
import { spotlight } from '../tools.ts'
import {
  type ComputerProtocol,
  type DesktopAction,
  fromGeneric,
  fromOpenAi,
  imageLimits,
  inside,
  type Point,
  screenshotEdge,
  UnsupportedAction,
} from './actions.ts'
import { type AppTier, allows, appTier, appWarning, canRaise, isOwnApp, sendsOnReturn } from './apps.ts'
import { ComputerStopped, type DriverResult, type Wait } from './driver.ts'

export const COMPUTER_TOOL = 'computer'

const t = prompts.computer

/** The app an agent works in: its process and the window it sees. */
interface Target {
  readonly app: string
  readonly bundleId: string
  readonly pid: number
  windowId: number
  bounds: { width: number; height: number }
  title: string
}

interface Element {
  readonly index: number
  readonly role: string
  readonly label?: string
  readonly value?: string
  /** Screen points, as the accessibility API reports them. */
  readonly frame?: { x: number; y: number; w: number; h: number }
}

/** What one agent has on its desktop: the app it drives and its latest screenshot. */
interface Desk {
  target?: Target
  shot?: {
    readonly snapshot?: string
    readonly width: number
    readonly height: number
    /** The window's frame in screen points when the screenshot was taken, to place pixels on elements. */
    readonly window?: { x: number; y: number; width: number; height: number }
    readonly elements: readonly Element[]
  }
  cursor?: Point
  /** A batch of Anthropic toolset calls in which one failed: the rest are not run. */
  failedBatch?: string
}

const desks = new WeakMap<ColonyHost, Map<string, Desk>>()
/** What computer use waited for that the person was already shown this round. */
const blockedOnce = new WeakMap<ColonyHost, Set<string>>()
function deskOf(host: ColonyHost, agent: string): Desk {
  let byAgent = desks.get(host)
  if (!byAgent) {
    byAgent = new Map()
    desks.set(host, byAgent)
  }
  let desk = byAgent.get(agent)
  if (!desk) {
    desk = {}
    byAgent.set(agent, desk)
  }
  return desk
}

const parameters = type({
  action: type(
    "'screenshot' | 'elements' | 'left_click' | 'right_click' | 'middle_click' | 'double_click' | 'triple_click' | 'click_element' | 'mouse_move' | 'left_click_drag' | 'scroll' | 'type' | 'key' | 'wait' | 'zoom' | 'cursor_position' | 'open_app' | 'list_apps'",
  ).describe(prompts.tools.computer.params.action),
  'coordinate?': type('number').array().describe(prompts.tools.computer.params.coordinate),
  'start_coordinate?': type('number').array().describe(prompts.tools.computer.params.start_coordinate),
  'element?': type('number').describe(prompts.tools.computer.params.element),
  'text?': type('string').describe(prompts.tools.computer.params.text),
  'scroll_direction?': type("'up' | 'down' | 'left' | 'right'").describe(
    prompts.tools.computer.params.scroll_direction,
  ),
  'scroll_amount?': type('number').describe(prompts.tools.computer.params.scroll_amount),
  'repeat?': type('number').describe(prompts.tools.computer.params.repeat),
  'duration?': type('number').describe(prompts.tools.computer.params.duration),
  'region?': type('number').array().describe(prompts.tools.computer.params.region),
  'app?': type('string').describe(prompts.tools.computer.params.app),
  'full_control?': type('boolean').describe(prompts.tools.computer.params.full_control),
  'query?': type('string').describe(prompts.tools.computer.params.query),
  'button?': type("'left' | 'right'").describe(prompts.tools.computer.params.button),
  'count?': type('number').describe(prompts.tools.computer.params.count),
})

/** The context pi-agent-core hands a tool (agent.ts sets it): the call's provider metadata and its batch. */
interface CallContext {
  readonly toolCall?: { readonly batchId?: string; readonly providerMetadata?: unknown }
}

/** A model's computer tool, for one agent. `model` is read per call: the agent may switch models mid-round. */
export function computerTool(agent: string, host: ColonyHost, model: () => Model): AgentTool {
  return {
    name: COMPUTER_TOOL,
    label: COMPUTER_TOOL,
    description: prompts.tools.computer.description,
    parameters,
    // OpenAI's computer-use models get the native tool; every other model this definition as a function tool.
    native: { type: 'computer' },
    intent: 'omit',
    approval: 'write',
    // Desktop actions happen one after another, in the order the model wrote them.
    concurrency: 'exclusive',
    lenientArgValidation: true,
    async execute(
      callId: string,
      params: unknown,
      signal?: AbortSignal,
      _update?: unknown,
      context?: unknown,
    ) {
      const call = (context as CallContext | undefined)?.toolCall
      const meta = call?.providerMetadata as ComputerToolCallMetadata | undefined
      const input = (params ?? {}) as Record<string, unknown>
      if (meta?.type === 'computer')
        return run(host, agent, model, callId, 'openai', () => fromOpenAi(meta.actions), meta, signal)
      return run(
        host,
        agent,
        model,
        callId,
        'generic',
        () => [fromGeneric(String(input.action), input)],
        undefined,
        signal,
      )
    },
  } as AgentTool
}

/**
 * One member of Anthropic's computer toolset (`left_click`, `scroll`…), which arrives as a tool call of its own
 * name. The members of one response run in order; once one fails the rest answer that they did not run.
 */
export function computerMember(name: string, agent: string, host: ColonyHost, model: () => Model): AgentTool {
  return {
    name,
    label: name,
    description: prompts.tools.computer.description,
    parameters: type({}),
    intent: 'omit',
    approval: 'write',
    concurrency: 'exclusive',
    lenientArgValidation: true,
    async execute(
      callId: string,
      params: unknown,
      signal?: AbortSignal,
      _update?: unknown,
      context?: unknown,
    ) {
      const batch = (context as CallContext | undefined)?.toolCall?.batchId
      const desk = deskOf(host, agent)
      if (batch && desk.failedBatch === batch)
        return { content: [{ type: 'text', text: t.halted }], isError: true }
      const result = await run(
        host,
        agent,
        model,
        callId,
        'anthropic',
        () => [fromGeneric(name, (params ?? {}) as Record<string, unknown>)],
        undefined,
        signal,
        name,
      )
      if (result.isError && batch) desk.failedBatch = batch
      return result
    },
  } as AgentTool
}

const runsScripts = (bundleId: string) => COMPUTER_SCRIPT_APPS.some((r) => r.test(bundleId))

/** Whether clicking what bears this label is consequential: it buys, sends, deletes…, or runs a script app's script. */
export function sensitiveLabel(label: string | undefined, bundleId: string): boolean {
  if (!label) return false
  return COMPUTER_SENSITIVE_LABEL.test(label) || (runsScripts(bundleId) && COMPUTER_SCRIPT_LABEL.test(label))
}

/**
 * A key press written one way whatever order the model gave its modifiers in: modifiers in alphabetical order, then
 * the key (`cmd+option+shift+delete`). The sensitive and script key patterns are written against this.
 */
export function computerCombo(keys: readonly string[]): string {
  const key = keys.at(-1) ?? ''
  return [...new Set(keys.slice(0, -1))].sort().concat(key).join('+')
}

/**
 * Whether a key press or typed text sends, deletes or runs something in this app: a sensitive combo, Return (or a
 * newline typed) where Return sends or runs (a launcher like Raycast), a script app's run key.
 */
export function sendsOrRuns(action: DesktopAction, bundleId: string): boolean {
  if (action.kind === 'type')
    return /[\r\n]/.test(action.text) && (sendsOnReturn(bundleId) || runsScripts(bundleId))
  if (action.kind !== 'key') return false
  const combo = computerCombo(action.keys)
  return (
    COMPUTER_SENSITIVE_KEYS.some((r) => r.test(combo)) ||
    (combo === 'return' && sendsOnReturn(bundleId)) ||
    (runsScripts(bundleId) && COMPUTER_SCRIPT_KEYS.some((r) => r.test(combo)))
  )
}

/** A short line for the log and the chat's steps: what the action did. */
function describe(a: DesktopAction): { action: string; label?: string; point?: Point } {
  switch (a.kind) {
    case 'click':
      return {
        action: a.count === 2 ? 'double_click' : a.count === 3 ? 'triple_click' : `${a.button}_click`,
        ...(a.modifiers.length ? { label: a.modifiers.join('+') } : {}),
        ...(a.at ? { point: a.at } : {}),
      }
    case 'click_element':
      return { action: 'click_element', label: `#${a.element}` }
    case 'move':
      return { action: 'mouse_move', point: a.at }
    case 'drag':
      return { action: 'left_click_drag', point: a.to }
    case 'scroll':
      return { action: 'scroll', label: `${a.direction} ${a.amount}`, ...(a.at ? { point: a.at } : {}) }
    case 'type':
      return { action: 'type', label: a.text.slice(0, 60) }
    case 'key':
      return { action: 'key', label: a.keys.join('+') }
    case 'open_app':
      return { action: 'open_app', label: a.app }
    case 'zoom':
      return { action: 'zoom' }
    case 'wait':
      return { action: 'wait', label: `${a.seconds}s` }
    case 'elements':
      return { action: 'elements', ...(a.query ? { label: a.query } : {}) }
    case 'cursor':
      return { action: 'cursor_position' }
    case 'list_apps':
      return { action: 'list_apps' }
    case 'screenshot':
      return { action: 'screenshot' }
  }
}

/** Runs one tool call's actions, records them, and answers the model in its provider's shape. */
async function run(
  host: ColonyHost,
  agent: string,
  model: () => Model,
  callId: string,
  protocol: ComputerProtocol,
  parse: () => DesktopAction[],
  meta: ComputerToolCallMetadata | undefined,
  signal: AbortSignal | undefined,
  member?: string,
): Promise<AgentToolResult> {
  const actor = agentActor(agent)
  const tool = member ?? COMPUTER_TOOL
  let actions: DesktopAction[] = []
  let parseError: string | undefined
  try {
    actions = parse()
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err)
  }
  await host.append({
    type: 'tool/call',
    actor,
    payload: { agent, callId, tool, args: { actions: actions.map((a) => ({ ...a })) } },
  })
  let text: string
  let image: { data: string; mimeType: string } | undefined
  let ok = true
  try {
    if (parseError) throw new UnsupportedAction(parseError)
    const out = await perform(host, agent, model, actions, meta, signal)
    text = out.text
    image = out.image
  } catch (err) {
    ok = false
    text = `ERROR: ${err instanceof Error ? err.message : String(err)}`
  }
  await host.append({
    type: 'tool/result',
    actor,
    payload: { agent, callId, tool, ok, output: text.slice(0, 8_000) },
  })
  // What apps show is outside content, as web pages are.
  const shown = ok
    ? spotlight(host.boundary, `computer:${deskOf(host, agent).target?.app ?? 'desktop'}`, text)
    : text
  if (ok) host.rememberUntrusted(agent, `computer:${deskOf(host, agent).target?.app ?? 'desktop'}`, text)
  const content: AgentToolResult['content'] = [
    { type: 'text', text: shown },
    ...(image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : []),
  ]
  if (protocol === 'openai' && meta && image)
    return {
      content,
      isError: !ok,
      providerMetadata: {
        type: 'computer',
        screenshot: { type: 'computer_screenshot', image_url: `data:${image.mimeType};base64,${image.data}` },
        acknowledgedSafetyChecks: meta.pendingSafetyChecks,
      },
    } as AgentToolResult
  return { content, isError: !ok }
}

/** Every check a call goes through, then its actions one by one, ending on a fresh look at the app. */
async function perform(
  host: ColonyHost,
  agent: string,
  model: () => Model,
  actions: readonly DesktopAction[],
  meta: ComputerToolCallMetadata | undefined,
  signal: AbortSignal | undefined,
): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  if (host.state().status !== 'running') throw new Error('the colony is no longer running')
  if (host.huddling()) throw new Error(prompts.toolResults.huddling)
  const hub = host.computer
  if (!hub) throw new Error(t.notHere)
  if (!hub.enabled) throw new Error(t.off)
  if (hub.stopped(host.id)) throw new Error(t.stopped)
  if (!hub.driver()) {
    await blocked(host, agent, 'install')
    throw new Error(t.missing)
  }
  const grants = hub.grants()
  const missing = [
    ...(grants && !grants.screenRecording ? (['screen-recording'] as const) : []),
    ...(grants && !grants.accessibility ? (['accessibility'] as const) : []),
  ]
  if (missing.length) {
    await blocked(host, agent, 'grants', [...missing])
    throw new Error(
      t.grants(missing.map((m) => (m === 'screen-recording' ? 'Screen Recording' : 'Accessibility'))),
    )
  }
  // Apps are approved one at a time below; the permission model can also ask before every step, or refuse them all.
  const verdict = host.permit(agent, { tool: COMPUTER_TOOL, kind: 'other', readOnly: false })
  if (verdict.decision === 'deny')
    throw new Error(prompts.toolResults.denied('computer use', prompts.permissionSource(verdict.source)))
  if (verdict.decision === 'ask') await approveStep(host, agent, actions, t.review.ruleAsk)
  if (meta?.pendingSafetyChecks.length) await approveSafety(host, agent, meta)
  await hub.ensure()
  const desk = deskOf(host, agent)
  let zoomed: { data: string; mimeType: string } | undefined
  const notes: string[] = []
  for (const action of actions) {
    if (signal?.aborted) throw new Error('the call was stopped')
    const result = await act(host, agent, desk, action, signal)
    if (result?.note) notes.push(result.note)
    if (result?.image) zoomed = result.image
    if (action.kind === 'list_apps' || action.kind === 'cursor' || action.kind === 'elements')
      if (actions.length === 1 && result?.note) return { text: result.note }
  }
  if (!desk.target) return { text: notes.join('\n') || t.noApp }
  const last = actions.at(-1)
  if (zoomed && last?.kind === 'zoom') {
    await keyframe(host, agent, desk, last, zoomed)
    return { text: notes.join('\n'), image: zoomed }
  }
  const look = await screenshot(host, desk, model())
  if (last) await keyframe(host, agent, desk, last, look.image)
  return { text: [...notes, look.text].join('\n'), image: look.image }
}

/** Tells the person, once per round, what computer use is waiting for (the chat shows a card with the way out). */
async function blocked(
  host: ColonyHost,
  agent: string,
  reason: 'install' | 'grants',
  missing?: ('accessibility' | 'screen-recording')[],
) {
  const told = blockedOnce.get(host) ?? new Set<string>()
  blockedOnce.set(host, told)
  if (told.has(reason)) return
  told.add(reason)
  await host.append({
    type: 'computer/blocked',
    actor: agentActor(agent),
    payload: { agent, reason, ...(missing ? { missing } : {}) },
  })
}

/** One desktop action on the agent's app. */
async function act(
  host: ColonyHost,
  agent: string,
  desk: Desk,
  action: DesktopAction,
  signal: AbortSignal | undefined,
): Promise<{ note?: string; image?: { data: string; mimeType: string } } | undefined> {
  const hub = host.computer
  if (!hub) throw new Error(t.notHere)
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await hub.call(tool, args, signal)
    if (r.isError) throw new Error(r.text.replace(/^Error:\s*/, '').slice(0, 600) || `${tool} failed`)
    return r
  }
  if (action.kind === 'list_apps') {
    const r = await call('list_apps', {})
    const apps = appsOf(r).filter((a) => !isOwnApp(a.bundleId))
    return {
      note: t.apps(
        apps
          .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
          .slice(0, 80)
          .map((a) => `- ${a.name} (${a.bundleId})${a.running ? ' · running' : ''}`),
      ),
    }
  }
  if (action.kind === 'open_app') {
    await openApp(host, agent, desk, action.app, action.fullControl, call)
    return undefined
  }
  if (action.kind === 'wait') {
    await Bun.sleep(action.seconds * 1000)
    return { note: t.waited(action.seconds) }
  }
  const target = desk.target
  if (!target) throw new Error(t.noApp)
  const tier = granted(host, target.bundleId)
  if (!allows(tier, action))
    throw new Error(t.tier(target.app, tier, describe(action).action.replace(/_/g, ' ')))
  const at = { pid: target.pid, window_id: target.windowId }
  switch (action.kind) {
    case 'screenshot':
      return undefined
    case 'cursor': {
      const [x, y] = desk.cursor ?? [0, 0]
      return { note: t.cursor(x, y) }
    }
    case 'elements': {
      const r = await call('get_window_state', {
        ...at,
        include_screenshot: false,
        max_elements: COMPUTER_ELEMENTS_WALKED,
        ...(action.query ? { query: action.query } : {}),
        ...(hub.accepts('get_window_state', 'tree_format') ? { tree_format: 'elements' } : {}),
      })
      const elements = elementsOf(r)
      if (desk.shot) desk.shot = { ...desk.shot, elements, snapshot: snapshotOf(r) ?? desk.shot.snapshot }
      return { note: elementLines(elements, r) }
    }
    case 'zoom': {
      const shot = needShot(desk)
      const [x0, y0, x1, y1] = action.region
      if (!inside([x0, y0], shot) || !inside([x1 - 1, y1 - 1], shot) || x1 <= x0 || y1 <= y0)
        throw new Error(t.outside(x1, y1, shot.width, shot.height))
      const r = await call('zoom', { ...at, x1: x0, y1: y0, x2: x1, y2: y1 })
      const image = r.images[0]
      if (!image) throw new Error('zoom returned no image')
      return { image }
    }
    case 'click': {
      const point = action.at ?? desk.cursor
      if (!point) throw new Error(t.noScreenshot)
      const shot = needShot(desk)
      if (!inside(point, shot)) throw new Error(t.outside(point[0], point[1], shot.width, shot.height))
      const label = labelAt(desk, point)
      if (sensitiveLabel(label, target.bundleId))
        await approveStep(host, agent, [action], t.review.sensitive, label)
      const args = {
        ...at,
        x: point[0],
        y: point[1],
        button: action.button,
        ...(action.count > 1 ? { count: action.count } : {}),
        ...(action.modifiers.length ? { modifier: action.modifiers, delivery_mode: 'foreground' } : {}),
      }
      // Modified clicks must bring the window forward, so macOS sees the keys held: one agent at a time.
      if (action.modifiers.length)
        await hub.inForeground({ colonyId: host.id, agent }, target.app, () => call('click', args))
      else await call('click', args)
      desk.cursor = point
      return undefined
    }
    case 'click_element': {
      const shot = needShot(desk)
      const el = shot.elements.find((e) => e.index === action.element)
      if (shot.elements.length && !el) throw new Error(t.noElement(action.element))
      const label = el?.label ?? el?.value
      if (sensitiveLabel(label, target.bundleId))
        await approveStep(host, agent, [action], t.review.sensitive, label)
      const ref = {
        ...at,
        element_index: action.element,
        ...(shot.snapshot ? { snapshot_id: shot.snapshot } : {}),
      }
      if (action.count === 2) await call('double_click', ref)
      else await call(action.button === 'right' ? 'right_click' : 'click', ref)
      return undefined
    }
    case 'move': {
      const shot = needShot(desk)
      if (!inside(action.at, shot))
        throw new Error(t.outside(action.at[0], action.at[1], shot.width, shot.height))
      await call('move_cursor', { ...at, x: action.at[0], y: action.at[1] })
      desk.cursor = action.at
      return undefined
    }
    case 'drag': {
      const shot = needShot(desk)
      for (const p of [action.from, action.to])
        if (!inside(p, shot)) throw new Error(t.outside(p[0], p[1], shot.width, shot.height))
      await call('drag', {
        ...at,
        from_x: action.from[0],
        from_y: action.from[1],
        to_x: action.to[0],
        to_y: action.to[1],
      })
      desk.cursor = action.to
      return undefined
    }
    case 'scroll': {
      const shot = needShot(desk)
      if (action.at && !inside(action.at, shot))
        throw new Error(t.outside(action.at[0], action.at[1], shot.width, shot.height))
      await call('scroll', {
        ...at,
        direction: action.direction,
        amount: action.amount,
        ...(action.at ? { x: action.at[0], y: action.at[1] } : {}),
        ...(action.element !== undefined
          ? { element_index: action.element, ...(shot.snapshot ? { snapshot_id: shot.snapshot } : {}) }
          : {}),
      })
      return undefined
    }
    case 'type': {
      if (redactSecrets(action.text) !== action.text) throw new Error(t.secret)
      if (sendsOrRuns(action, target.bundleId)) await approveStep(host, agent, [action], t.review.sensitive)
      const shot = desk.shot
      await call('type_text', {
        ...at,
        text: action.text,
        ...(action.element !== undefined
          ? { element_index: action.element, ...(shot?.snapshot ? { snapshot_id: shot.snapshot } : {}) }
          : {}),
      })
      return undefined
    }
    case 'key': {
      const key = action.keys.at(-1) ?? ''
      if (sendsOrRuns(action, target.bundleId)) await approveStep(host, agent, [action], t.review.sensitive)
      const modifiers = action.keys.slice(0, -1)
      for (let i = 0; i < action.repeat; i++)
        if (modifiers.length) await call('hotkey', { ...at, keys: [...action.keys] })
        else await call('press_key', { ...at, key })
      return undefined
    }
  }
}

/** The tier the person granted an app in this chat (view if they have not approved it at all). */
function granted(host: ColonyHost, bundleId: string): AppTier {
  return host.state().computerApps?.find((a) => a.bundleId === bundleId)?.tier ?? 'view'
}

function needShot(desk: Desk) {
  if (!desk.shot) throw new Error(t.noScreenshot)
  return desk.shot
}

/** Opens (or switches to) an app: the person approves it first, then the agent holds it until it lets go. */
async function openApp(
  host: ColonyHost,
  agent: string,
  desk: Desk,
  wanted: string,
  fullControl: boolean,
  call: (tool: string, args: Record<string, unknown>) => Promise<DriverResult>,
) {
  const hub = host.computer
  if (!hub) throw new Error(t.notHere)
  const apps = appsOf(await call('list_apps', {}))
  const key = wanted.toLowerCase()
  const app =
    apps.find((a) => a.bundleId.toLowerCase() === key) ??
    apps.find((a) => a.name.toLowerCase() === key) ??
    apps.find((a) => a.name.toLowerCase().replace(/\.app$/, '') === key.replace(/\.app$/, ''))
  if (!app)
    throw new Error(
      t.unknownApp(
        wanted,
        apps
          .filter((a) => a.name.toLowerCase().includes(key))
          .slice(0, 5)
          .map((a) => a.name),
      ),
    )
  if (isOwnApp(app.bundleId)) throw new Error(t.ownApp)
  if (fullControl && !canRaise(app.bundleId) && appTier(app.bundleId) !== 'full')
    throw new Error(t.noRaise(app.name))
  const approved = host.state().computerApps?.find((a) => a.bundleId === app.bundleId)
  const want: AppTier = fullControl && canRaise(app.bundleId) ? 'full' : appTier(app.bundleId)
  // On the card and while another agent has the app, the round is about to drive the desktop: Stop reaches it.
  try {
    await hub.beforeControl(host.id, async (wait) => {
      if (!approved || (want === 'full' && approved.tier !== 'full'))
        await approveApp(host, agent, app, want, !!approved, wait)
      await hub.take({ name: app.name, bundleId: app.bundleId }, { colonyId: host.id, agent })
    })
  } catch (err) {
    if (err instanceof ComputerStopped) throw new Error(t.stopped)
    throw err
  }
  const launched = await call('launch_app', { bundle_id: app.bundleId })
  const pid = Number((launched.structured as { pid?: unknown } | undefined)?.pid ?? app.pid)
  const windows = windowsOf(launched)
  const listed = windows.length ? windows : windowsOf(await call('list_windows', { pid }))
  const window = frontWindow(listed)
  if (!window || !pid) throw new Error(t.noWindow(app.name))
  const changed = desk.target?.bundleId !== app.bundleId
  desk.target = {
    app: app.name,
    bundleId: app.bundleId,
    pid,
    windowId: window.id,
    bounds: window.bounds,
    title: window.title,
  }
  desk.shot = undefined
  if (changed)
    await host.append({
      type: 'computer/control',
      actor: agentActor(agent),
      payload: { agent, app: app.name, active: true },
    })
}

/** The approval card for using an app (or for full control of a click-only one), recorded for the rest of the chat. */
async function approveApp(
  host: ColonyHost,
  agent: string,
  app: { name: string; bundleId: string },
  tier: AppTier,
  raising: boolean,
  wait: Wait,
) {
  const warning = appWarning(app.bundleId)
  const r = t.review
  const decision = await host.reviewChange(
    agent,
    COMPUTER_TOOL,
    `${raising ? r.fullTitle(app.name) : r.appTitle(app.name)}`,
    {
      review: {
        kind: 'call',
        title: raising ? r.fullTitle(app.name) : r.appTitle(app.name),
        fields: [
          {
            key: 'app',
            label: r.app,
            value: `${app.name} (${app.bundleId})`,
            format: 'text',
            editable: false,
          },
          {
            key: 'access',
            label: r.access,
            value: `${r.tiers[tier]}. ${r.session}`,
            format: 'text',
            editable: false,
          },
          ...(warning
            ? [
                {
                  key: 'warning',
                  label: r.warning,
                  value: r.warnings[warning],
                  format: 'text' as const,
                  editable: false,
                },
              ]
            : []),
        ],
      },
    },
  )
  if (!decision.approved) throw new Error(t.denied(app.name, decision.note))
  if (wait.ended) throw new Error(t.stopped)
  const others = (host.state().computerApps ?? []).filter((a) => a.bundleId !== app.bundleId)
  await host.append({
    type: 'computer/apps',
    actor: { kind: 'user', id: 'user' },
    payload: { apps: [...others, { bundleId: app.bundleId, name: app.name, tier }] },
  })
}

/** The approval card for one step: consequential-looking, or every step when the person set computer to ask. */
async function approveStep(
  host: ColonyHost,
  agent: string,
  actions: readonly DesktopAction[],
  why: string,
  label?: string,
) {
  const app = host.computer ? (deskOf(host, agent).target?.app ?? '') : ''
  const r = t.review
  const steps = actions.map((a) => {
    const d = describe(a)
    return `${d.action.replace(/_/g, ' ')}${d.label ? ` ${d.label}` : ''}${d.point ? ` at (${d.point[0]}, ${d.point[1]})` : ''}`
  })
  const decision = await host.reviewChange(agent, COMPUTER_TOOL, `${r.stepTitle(app)}: ${steps.join(', ')}`, {
    review: {
      kind: 'call',
      title: r.stepTitle(app),
      fields: [
        { key: 'step', label: r.step, value: steps.join('\n'), format: 'text', editable: false },
        ...(label
          ? [{ key: 'target', label: r.target, value: label, format: 'text' as const, editable: false }]
          : []),
        { key: 'why', label: r.why, value: why, format: 'text', editable: false },
      ],
    },
  })
  if (!decision.approved) throw new Error(t.declined(steps.join(', '), decision.note))
}

/** OpenAI's safety checks (a suspected injection, a sensitive domain): the person acknowledges them, or it stops. */
async function approveSafety(host: ColonyHost, agent: string, meta: ComputerToolCallMetadata) {
  const r = t.review
  const lines = meta.pendingSafetyChecks.map((c) => c.message ?? c.code ?? c.id)
  const decision = await host.reviewChange(agent, COMPUTER_TOOL, `${r.safety}: ${lines.join('; ')}`, {
    review: {
      kind: 'call',
      title: r.stepTitle(deskOf(host, agent).target?.app ?? ''),
      fields: [{ key: 'safety', label: r.safety, value: lines.join('\n'), format: 'text', editable: false }],
    },
  })
  if (!decision.approved) throw new Error(t.safetyChecks)
}

/** A fresh screenshot of the agent's window, sized for its model, with the window's numbered elements. */
async function screenshot(host: ColonyHost, desk: Desk, model: Model) {
  const hub = host.computer
  const target = desk.target
  if (!hub || !target) throw new Error(t.noApp)
  const limits = imageLimits(model)
  const args = {
    pid: target.pid,
    window_id: target.windowId,
    max_dimension: screenshotEdge(target.bounds, limits),
    max_elements: COMPUTER_ELEMENTS_WALKED,
    ...(hub.accepts('get_window_state', 'tree_format') ? { tree_format: 'elements' } : {}),
  }
  let r = await hub.call('get_window_state', args)
  if (r.isError && /window_id_not_found|window_owner_pid_mismatch/.test(r.text)) {
    // The window closed or changed (a dialog, a new document): look at the app's front window instead.
    const window = frontWindow(windowsOf(await hub.call('list_windows', { pid: target.pid })))
    if (!window) throw new Error(t.noWindow(target.app))
    target.windowId = window.id
    target.bounds = window.bounds
    target.title = window.title
    r = await hub.call('get_window_state', {
      ...args,
      window_id: window.id,
      max_dimension: screenshotEdge(window.bounds, limits),
    })
  }
  if (r.isError) throw new Error(r.text.replace(/^Error:\s*/, '').slice(0, 600))
  const s = (r.structured ?? {}) as Record<string, unknown>
  const title = typeof s.window_title === 'string' ? s.window_title : target.title
  target.title = title
  if (COMPUTER_OWN_WINDOW_TITLE.test(title)) throw new Error(t.ownWindow(target.app))
  const image = r.images[0]
  if (!image) throw new Error(String(s.degraded_reason ?? 'the driver returned no screenshot of this window'))
  const width = Number(s.screenshot_width) || target.bounds.width
  const height = Number(s.screenshot_height) || target.bounds.height
  const bounds = s.window_bounds as { x?: number; y?: number; width?: number; height?: number } | undefined
  const elements = elementsOf(r)
  desk.shot = {
    width,
    height,
    elements,
    ...(snapshotOf(r) ? { snapshot: snapshotOf(r) } : {}),
    ...(bounds && typeof bounds.width === 'number' && typeof bounds.height === 'number'
      ? { window: { x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width, height: bounds.height } }
      : {}),
  }
  return { image, text: `${t.shot(target.app, title, width, height)}\n${elementLines(elements, r)}` }
}

async function keyframe(
  host: ColonyHost,
  agent: string,
  desk: Desk,
  action: DesktopAction,
  image: { data: string; mimeType: string },
) {
  try {
    const { hash } = await host.blobs.put(new Uint8Array(Buffer.from(image.data, 'base64')))
    const d = describe(action)
    await host.append({
      type: 'computer/keyframe',
      actor: agentActor(agent),
      payload: {
        agent,
        blob: hash,
        app: desk.target?.app ?? '',
        title: desk.target?.title ?? '',
        action: d.action,
        ...(d.label ? { label: action.kind === 'type' ? redactSecrets(d.label) : d.label } : {}),
        ...(d.point ? { point: { x: d.point[0], y: d.point[1] } } : {}),
        width: desk.shot?.width ?? 0,
        height: desk.shot?.height ?? 0,
      },
    })
  } catch (err) {
    // The chat's picture of the step is a convenience; a failed capture must not fail the agent's action.
    console.error(`[${agent}] computer keyframe failed:`, err instanceof Error ? err.message : err)
  }
}

/** The label of the element under a screenshot pixel: pixels map onto the window's frame in screen points. */
export function labelAt(desk: Pick<Desk, 'shot'>, at: Point): string | undefined {
  const shot = desk.shot
  if (!shot?.window || !shot.width || !shot.height) return undefined
  const x = shot.window.x + (at[0] * shot.window.width) / shot.width
  const y = shot.window.y + (at[1] * shot.window.height) / shot.height
  let best: Element | undefined
  for (const e of shot.elements) {
    const f = e.frame
    if (!f || !(e.label || e.value) || x < f.x || y < f.y || x > f.x + f.w || y > f.y + f.h) continue
    if (!best?.frame || f.w * f.h < best.frame.w * best.frame.h) best = e
  }
  return best ? (best.label ?? best.value) : undefined
}

function elementsOf(r: DriverResult): Element[] {
  const raw = (r.structured?.elements ?? []) as Record<string, unknown>[]
  return raw.flatMap((e): Element[] => {
    if (typeof e.element_index !== 'number') return []
    const f = e.frame as Record<string, unknown> | undefined
    return [
      {
        index: e.element_index,
        role: String(e.role ?? ''),
        ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
        ...(typeof e.value === 'string' && e.value ? { value: e.value } : {}),
        ...(f &&
        typeof f.x === 'number' &&
        typeof f.y === 'number' &&
        typeof f.w === 'number' &&
        typeof f.h === 'number'
          ? { frame: { x: f.x, y: f.y, w: f.w, h: f.h } }
          : {}),
      },
    ]
  })
}

const snapshotOf = (r: DriverResult) =>
  typeof r.structured?.snapshot_id === 'string' ? (r.structured.snapshot_id as string) : undefined

/** The elements as numbered lines for the model; a driver that sent only its markdown tree has that shown instead. */
function elementLines(elements: readonly Element[], r: DriverResult): string {
  if (!elements.length) {
    const markdown =
      typeof r.structured?.tree_markdown === 'string' ? (r.structured.tree_markdown as string) : ''
    return markdown.trim() ? markdown.slice(0, 12_000) : t.elements([], 0)
  }
  const lines = elements
    .slice(0, COMPUTER_ELEMENTS_SHOWN)
    .map(
      (e) =>
        `[${e.index}] ${e.role.replace(/^AX/, '')}${e.label ? ` "${e.label.slice(0, 80)}"` : ''}${e.value && e.value !== e.label ? ` = ${e.value.slice(0, 80)}` : ''}`,
    )
  return t.elements(lines, elements.length - lines.length)
}

interface AppInfo {
  readonly name: string
  readonly bundleId: string
  readonly running: boolean
  readonly pid: number
}

function appsOf(r: DriverResult): AppInfo[] {
  const s = r.structured as { apps?: unknown } | undefined
  const raw = (Array.isArray(s?.apps) ? s.apps : Array.isArray(r.structured) ? r.structured : []) as Record<
    string,
    unknown
  >[]
  return raw.flatMap((a) =>
    typeof a.bundle_id === 'string' && typeof a.name === 'string'
      ? [{ name: a.name, bundleId: a.bundle_id, running: a.running === true, pid: Number(a.pid ?? 0) }]
      : [],
  )
}

interface WindowInfo {
  readonly id: number
  readonly title: string
  readonly bounds: { width: number; height: number }
  readonly onScreen: boolean
  readonly z: number
}

function windowsOf(r: DriverResult): WindowInfo[] {
  const raw = ((r.structured as { windows?: unknown } | undefined)?.windows ?? []) as Record<
    string,
    unknown
  >[]
  return raw.flatMap((w) => {
    const b = w.bounds as { width?: unknown; height?: unknown } | undefined
    if (typeof w.window_id !== 'number' || typeof b?.width !== 'number' || typeof b.height !== 'number')
      return []
    return [
      {
        id: w.window_id,
        title: typeof w.title === 'string' ? w.title : '',
        bounds: { width: b.width, height: b.height },
        onScreen: w.is_on_screen !== false,
        z: typeof w.z_index === 'number' ? w.z_index : -1,
      },
    ]
  })
}

/** The window an agent sees first: on screen, big enough to be a real window, frontmost. */
function frontWindow(windows: readonly WindowInfo[]): WindowInfo | undefined {
  return windows
    .filter((w) => w.bounds.width >= 80 && w.bounds.height >= 80)
    .sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || b.z - a.z)[0]
}
