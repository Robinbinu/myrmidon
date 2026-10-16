/**
 * omp's desktop engine, computer use's second engine (Settings → Computer use → Engine): agents get a `desktop` tool
 * that runs a JavaScript snippet against omp's `desktop` facade (windows, screenshots, native input, AX trees) in
 * omp's computer worker: pi-coding-agent's ComputerSupervisor over pi-natives' desktop addon (both MIT), one worker
 * per agent of a round, so window handles and AX refs carry over between its calls.
 *
 * Unlike Cua Driver, a script is not held to one app the person approved: it sees every window and runs in Myrmidon's
 * own process with its macOS permissions, outside the sandbox. So the person's approval is the boundary, under any
 * sandbox or preset: a script that only looks (`read_only: true`, which omp's facade enforces) asks once per chat;
 * any other asks every time unless they allowed `desktop` for the chat (or wider) on its card. A permission rule that
 * names `desktop` decides instead, as for any tool. A round a channel member started never has the hub, so never this.
 */

import type { PermissionCall, PermissionVerdict } from '@myrmidon/protocol'
import {
  COMPUTER_OWN_APPS,
  DESKTOP_CAPTURE,
  DESKTOP_IMAGES_SHOWN,
  DESKTOP_MAX_TIMEOUT_S,
  DESKTOP_OPEN_MS,
  DESKTOP_OUTPUT_CHARS,
  DESKTOP_TIMEOUT_S,
} from '../config.ts'
import { agentActor, type ColonyHost } from '../host.ts'
import type { AgentTool, AgentToolResult } from '../omp/agent-core.ts'
import { type } from '../omp/ai.ts'
import {
  type ComputerController,
  type ComputerRunOk,
  type ComputerSessionSnapshot,
  loadComputerSupervisor,
} from '../omp/computer.ts'
import { prompts } from '../prompts.ts'
import { redactSecrets } from '../secrets.ts'
import { spotlight } from '../spotlight.ts'
import { DESKTOP_POINT_CALL, desktopPrefix } from './desktop-pointers.ts'
import type { Holder, Pointer } from './driver.ts'
import { needGrants } from './grants.ts'
import { DESKTOP_TOOL } from './names.ts'

/** The chat's record that the person let agents look at their screen, kept with the apps a chat allowed. */
export const DESKTOP_GRANT = 'omp.desktop'

const d = prompts.desktop
const t = prompts.computer

export const desktopParameters = type({
  code: type('string').describe(prompts.tools.desktop.params.code),
  'read_only?': type('boolean').describe(prompts.tools.desktop.params.read_only),
  'timeout?': type('number').describe(prompts.tools.desktop.params.timeout),
})

/** Answers a desktop script's `tool.<name>(args)`, which omp's worker hands back to its host. */
export type DesktopBridge = (name: string, args: unknown) => Promise<unknown>
/** Makes one agent's controller: omp's supervisor and worker, or a stand-in in tests. */
export type DesktopControllerFactory = (
  bridge: DesktopBridge,
) => ComputerController | Promise<ComputerController>

interface Session {
  readonly controller: Promise<ComputerController>
  /** The script running now, which decides what its `tool.open_app` may do. */
  current?: { readonly readOnly: boolean }
}

/** One omp desktop session per agent of a round, made on its first script and closed when the round lets go. */
export class DesktopEngine {
  private readonly _sessions = new Map<string, Session>()
  private readonly _factory: DesktopControllerFactory
  private readonly _launch: (app: string) => Promise<string>

  private readonly _point?: (holder: Holder, x: number, y: number, action: Pointer['action']) => void

  constructor(
    options: {
      factory?: DesktopControllerFactory
      launch?: (app: string) => Promise<string>
      /** Where an agent's script acted on the screen, for the overlay's cursors (`ComputerHub.point`). */
      point?: (holder: Holder, x: number, y: number, action: Pointer['action']) => void
    } = {},
  ) {
    this._factory = options.factory ?? ompController
    this._launch = options.launch ?? launchApp
    if (options.point) this._point = options.point
  }

  /** Runs one script for an agent; `readOnly` scripts may only look (omp's facade refuses input in them). */
  async run(
    holder: Holder,
    code: string,
    options: { timeoutMs: number; readOnly: boolean; cwd: string; signal?: AbortSignal },
  ): Promise<ComputerRunOk> {
    const key = keyOf(holder)
    let session = this._sessions.get(key)
    if (!session) {
      session = { controller: Promise.resolve(this._factory((name, args) => this._bridge(key, name, args))) }
      this._sessions.set(key, session)
    }
    const snapshot: ComputerSessionSnapshot = {
      cwd: options.cwd,
      sessionId: key,
      captureMaxWidth: DESKTOP_CAPTURE.maxWidth,
      captureMaxHeight: DESKTOP_CAPTURE.maxHeight,
      display: 'all',
      readOnly: options.readOnly,
    }
    session.current = { readOnly: options.readOnly }
    try {
      const controller = await session.controller.catch((err) => {
        // A worker that could not start is made afresh next time.
        this._sessions.delete(key)
        throw err
      })
      // Read-only scripts make no input, so there is nothing to place.
      const script = options.readOnly || !this._point ? code : desktopPrefix() + code
      return await controller.run(script, options.timeoutMs, snapshot, options.signal)
    } finally {
      session.current = undefined
    }
  }

  private async _bridge(key: string, name: string, args: unknown): Promise<unknown> {
    if (name === DESKTOP_POINT_CALL) return this._pointed(key, args)
    const current = this._sessions.get(key)?.current
    if (name !== 'open_app' || !current) throw new Error(d.bridgeOnly(name))
    if (current.readOnly) throw new Error(d.readOnlyOpen)
    const app = (args as { app?: unknown } | undefined)?.app
    if (typeof app !== 'string' || !app.trim()) throw new Error(d.badApp)
    return this._launch(app.trim())
  }

  /** A point the script's wrapped `desktop` reported (see desktop-pointers.ts), from the agent the session is for. */
  private _pointed(key: string, args: unknown): undefined {
    const p = args as { x?: unknown; y?: unknown; action?: unknown } | undefined
    const [colonyId = '', agent = ''] = key.split('\0')
    if (typeof p?.x !== 'number' || typeof p.y !== 'number' || !this._point) return undefined
    const action = POINTER_ACTIONS.find((a) => a === p.action) ?? 'click'
    this._point({ colonyId, agent }, p.x, p.y, action)
    return undefined
  }

  /** Ends the sessions of a round (or of one agent in it): their workers stop, running scripts with them. */
  async close(colonyId: string, agent?: string): Promise<void> {
    const ended = [...this._sessions.entries()].filter(([key]) =>
      agent === undefined ? key.startsWith(`${colonyId}\0`) : key === keyOf({ colonyId, agent }),
    )
    for (const [key] of ended) this._sessions.delete(key)
    await Promise.allSettled(ended.map(async ([, s]) => (await s.controller).close()))
  }

  async closeAll(): Promise<void> {
    const all = [...this._sessions.values()]
    this._sessions.clear()
    await Promise.allSettled(all.map(async (s) => (await s.controller).close()))
  }
}

const keyOf = (holder: Holder) => `${holder.colonyId}\0${holder.agent}`
const POINTER_ACTIONS: readonly Pointer['action'][] = ['move', 'click', 'type', 'scroll', 'drag']

/** omp's own supervisor, loaded on first use so Cua Driver users never load it. */
async function ompController(bridge: DesktopBridge): Promise<ComputerController> {
  const { ComputerSupervisor } = await loadComputerSupervisor()
  // omp's tool session only reaches the bridge, which needs none of it; the worker and timeouts are omp's defaults.
  return new ComputerSupervisor({} as never, undefined, undefined, (name, args) => bridge(name, args))
}

/** Launches an app by name or bundle id (macOS `open`), for a script that needs one that is not running. */
export async function launchApp(app: string): Promise<string> {
  if (app.startsWith('-') || /[\0\n]/.test(app) || app.length > 200) throw new Error(d.badApp)
  if (/\bmyrmidon\b/i.test(app) || COMPUTER_OWN_APPS.some((r) => r.test(app))) throw new Error(t.ownApp)
  const byId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(app)
  const proc = Bun.spawn(['open', byId ? '-b' : '-a', app], { stdout: 'ignore', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), DESKTOP_OPEN_MS)
  const code = await proc.exited
  clearTimeout(timer)
  if (code !== 0) {
    const why = (await new Response(proc.stderr).text()).trim().slice(0, 300)
    throw new Error(d.openFailed(app, why || `exit ${code}`))
  }
  return d.opened(app)
}

/** The desktop tool, for one agent. */
export function desktopTool(agent: string, host: ColonyHost): AgentTool {
  return {
    name: DESKTOP_TOOL,
    label: DESKTOP_TOOL,
    description: prompts.tools.desktop.description,
    parameters: desktopParameters,
    intent: 'omit',
    approval: 'write',
    concurrency: 'exclusive',
    async execute(callId: string, params: unknown, signal?: AbortSignal) {
      return runScript(host, agent, callId, (params ?? {}) as Record<string, unknown>, signal)
    },
  } as AgentTool
}

async function runScript(
  host: ColonyHost,
  agent: string,
  callId: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult> {
  const actor = agentActor(agent)
  const code = typeof input.code === 'string' ? input.code.trim() : ''
  const readOnly = input.read_only === true
  const seconds = Math.max(
    1,
    Math.min(
      DESKTOP_MAX_TIMEOUT_S,
      typeof input.timeout === 'number' && Number.isFinite(input.timeout) ? input.timeout : DESKTOP_TIMEOUT_S,
    ),
  )
  await host.append({
    type: 'tool/call',
    actor,
    payload: { agent, callId, tool: DESKTOP_TOOL, args: { code: redactSecrets(code), read_only: readOnly } },
  })
  let text: string
  let images: { data: string; mimeType: string }[] = []
  let ok = true
  try {
    const out = await perform(host, agent, code, readOnly, seconds, signal)
    text = out.text
    images = out.images
  } catch (err) {
    ok = false
    text = `ERROR: ${err instanceof Error ? err.message : String(err)}`
  }
  await host.append({
    type: 'tool/result',
    actor,
    payload: { agent, callId, tool: DESKTOP_TOOL, ok, output: text.slice(0, 8_000) },
  })
  // What apps show is outside content, as web pages are.
  if (ok) host.rememberUntrusted(agent, 'computer:desktop', text)
  return {
    content: [
      { type: 'text', text: ok ? spotlight(host.boundary, 'computer:desktop', text) : text },
      ...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
    ],
    isError: !ok,
  }
}

async function perform(
  host: ColonyHost,
  agent: string,
  code: string,
  readOnly: boolean,
  seconds: number,
  signal: AbortSignal | undefined,
): Promise<{ text: string; images: { data: string; mimeType: string }[] }> {
  if (host.state().status !== 'running') throw new Error('the colony is no longer running')
  if (host.huddling()) throw new Error(prompts.toolResults.huddling)
  const hub = host.computer
  if (!hub) throw new Error(t.notHere)
  if (!hub.enabled) throw new Error(t.off)
  if (hub.engine !== 'omp') throw new Error(d.cuaEngine)
  if (hub.stopped(host.id)) throw new Error(t.stopped)
  if (!hub.supported) throw new Error(d.unsupported)
  await needGrants(host, agent)
  if (!code) throw new Error(d.noCode)
  if (redactSecrets(code) !== code) throw new Error(d.secret)
  await approve(host, agent, code, readOnly)
  const holder = { colonyId: host.id, agent }
  if (hub.holdDesktop(holder, d.place))
    await host.append({
      type: 'computer/control',
      actor: agentActor(agent),
      payload: { agent, app: d.place, active: true },
    })
  const run = await hub.desktop.run(holder, code, {
    timeoutMs: seconds * 1000,
    readOnly,
    cwd: host.workspace.scratch(agent),
    ...(signal ? { signal } : {}),
  })
  return answer(host, agent, code, run)
}

/** The script's printed text and return value for the model, its latest screenshots, and a step for the chat. */
async function answer(host: ColonyHost, agent: string, code: string, run: ComputerRunOk) {
  // Captures land in the temp folder at full size; they are shown inline, so none stays on disk.
  for (const s of run.screenshots)
    await Bun.file(s.path)
      .delete()
      .catch(() => {})
  const printed = run.displays.flatMap((c) => (c.type === 'text' ? [c.text] : []))
  if (run.returnValue !== undefined) printed.push(d.returned(stringify(run.returnValue)))
  const text = (printed.join('\n').trim() || d.noOutput).slice(0, DESKTOP_OUTPUT_CHARS)
  const images = run.displays
    .flatMap((c) => (c.type === 'image' ? [{ data: c.data, mimeType: c.mimeType }] : []))
    .slice(-DESKTOP_IMAGES_SHOWN)
  const last = images.at(-1)
  const shot = run.screenshots.at(-1)
  if (last)
    try {
      const { hash } = await host.blobs.put(new Uint8Array(Buffer.from(last.data, 'base64')))
      await host.append({
        type: 'computer/keyframe',
        actor: agentActor(agent),
        payload: {
          agent,
          blob: hash,
          app: d.place,
          title: '',
          action: DESKTOP_TOOL,
          label: redactSecrets(code.split('\n')[0] ?? '').slice(0, 60),
          width: shot?.width ?? 0,
          height: shot?.height ?? 0,
        },
      })
    } catch (err) {
      // The chat's picture of the step is a convenience; a failed capture must not fail the agent's script.
      console.error(`[${agent}] desktop keyframe failed:`, err instanceof Error ? err.message : err)
    }
  return { text, images }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Looking asks once per chat; anything else every time, unless a rule (perhaps one this card offers) allows it. */
async function approve(host: ColonyHost, agent: string, code: string, readOnly: boolean) {
  const call: PermissionCall = readOnly
    ? { tool: DESKTOP_TOOL, kind: 'other', readOnly: true }
    : { tool: DESKTOP_TOOL, kind: 'other', readOnly: false, asks: true }
  const verdict = host.permit(agent, call)
  if (verdict.decision === 'deny')
    throw new Error(prompts.toolResults.denied('the desktop tool', prompts.permissionSource(verdict.source)))
  if (verdict.decision === 'allow' && verdict.source.by === 'rule') return
  if (verdict.decision === 'allow') {
    if (!host.state().computerApps?.some((a) => a.bundleId === DESKTOP_GRANT)) await approveLook(host, agent)
    return
  }
  await approveScript(host, agent, code, readOnly, call, verdict)
}

async function approveLook(host: ColonyHost, agent: string) {
  const r = d.review
  const decision = await host.reviewChange(agent, DESKTOP_TOOL, r.lookTitle, {
    review: {
      kind: 'call',
      title: r.lookTitle,
      fields: [{ key: 'access', label: r.access, value: r.look, format: 'text', editable: false }],
    },
  })
  if (!decision.approved) throw new Error(d.denied(decision.note))
  const others = (host.state().computerApps ?? []).filter((a) => a.bundleId !== DESKTOP_GRANT)
  await host.append({
    type: 'computer/apps',
    actor: { kind: 'user', id: 'user' },
    payload: { apps: [...others, { bundleId: DESKTOP_GRANT, name: d.grant, tier: 'view' }] },
  })
}

async function approveScript(
  host: ColonyHost,
  agent: string,
  code: string,
  readOnly: boolean,
  call: PermissionCall,
  verdict: PermissionVerdict,
) {
  const r = d.review
  const decision = await host.reviewChange(agent, DESKTOP_TOOL, `${r.runTitle}: ${code.split('\n')[0]}`, {
    review: {
      kind: 'call',
      title: r.runTitle,
      fields: [
        { key: 'script', label: r.script, value: code, format: 'code', editable: false },
        {
          key: 'access',
          label: r.access,
          value: readOnly ? r.lookOnly : r.run,
          format: 'text',
          editable: false,
        },
        {
          key: 'why',
          label: r.why,
          value: verdict.source.by === 'rule' ? r.ruleAsk : r.acts,
          format: 'text',
          editable: false,
        },
      ],
    },
    // The card offers to allow desktop for this chat (or wider), and is decided again if the rules change meanwhile.
    permission: { call, verdict },
  })
  if (!decision.approved) throw new Error(d.declined(decision.note))
}
