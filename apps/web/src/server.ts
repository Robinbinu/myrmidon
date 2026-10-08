import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BlobStore, colonyId, MyrError, Schema, SqliteLogStore } from '@myrmidon/core'
import { type ColonyId, colonyMetrics, foldColony, runDiff } from '@myrmidon/protocol'
import {
  accountName,
  type BrowserHub,
  buildCatalog,
  type ChatService,
  CUSTOM_APIS,
  type CustomApi,
  GreetingWriter,
  gitCommit,
  gitCommitChanges,
  gitDiscard,
  gitFileDiff,
  gitStage,
  gitStatus,
  gitUnstage,
  gitWorkingChanges,
  type HookStore,
  importFromOmp,
  type LiveInput,
  listFolders,
  type McpHub,
  type McpServerConfig,
  type MemoryStore,
  type ModelResolver,
  normalizeTeamConfig,
  type OmpRuntime,
  type PluginHost,
  type PluginStore,
  type ProjectStore,
  ruleGreeting,
  type ScheduleStore,
  type SettingsStore,
  type SkillLibrary,
  type SkillProposalStore,
  type SpecialistInput,
  type SpecialistStore,
  startScheduler,
  TOOL_DEFS,
  type ToolLibrary,
} from '@myrmidon/runtime'
import type { ServerWebSocket } from 'bun'
import index from './client/index.html'
import { AuthAudit, type Device, type DeviceScope, DeviceStore, needsFull, PairingCodes } from './devices.ts'
import {
  asDevice,
  checkHealth,
  FORWARD_MS,
  forwardHeaders,
  forwardTarget,
  type Gateway,
  type GatewayHealth,
  GatewayStore,
  pairWith,
  passableCode,
  responseHeaders,
  shown,
  socketUrl,
  unpair,
} from './gateways.ts'
import { Logins } from './logins.ts'
import { buildPluginUI, uiStamp } from './plugin-ui.ts'

export interface ServeOptions {
  readonly home: string
  /** 0 picks a free port. */
  readonly port?: number
  /**
   * Where to listen; loopback by default. Anything else (a tailnet address, `0.0.0.0`) makes this a remote gateway:
   * devices must be paired, and `noAuth` is refused.
   */
  readonly host?: string
  /** The address clients use for a remote gateway, e.g. `https://box.tail1234.ts.net`; also makes it remote. */
  readonly publicUrl?: string
  /** More Host values to accept (`name:port`), exactly as clients send them. */
  readonly allowHosts?: readonly string[]
  /** A fixed port for agent-built pages (random by default), so a tunnel or Tailscale Serve can forward it. */
  readonly previewPort?: number
  /**
   * The address clients open agent-built pages at on a remote gateway, e.g. `https://box.tail1234.ts.net:8443`. It
   * must be its own origin (another port or host, never a path), so a page cannot act as the dashboard.
   */
  readonly previewUrl?: string
  readonly token?: string
  /**
   * Development only: skip the bearer token. The server still binds to 127.0.0.1 and still rejects
   * foreign Host and Origin headers, so other sites and DNS rebinding cannot reach the API.
   */
  readonly noAuth?: boolean
  /**
   * Development only: bundle the client with React's development build and hot reload, and echo the browser's
   * console (errors included) to this process's output.
   */
  readonly debug?: boolean
  /** Enables the chat API; without it the server is a read-only dashboard. */
  readonly chats?: ChatService
  readonly settings?: SettingsStore
  readonly resolver?: ModelResolver
  /** omp's embedded model registry, credential vault, and web tools. */
  readonly omp?: OmpRuntime
  /** MCP servers whose tools colonies may use. */
  readonly mcp?: McpHub
  /** The agents' shared headless Chrome, for the live browser view. */
  readonly browser?: BrowserHub
  /** Project folders chats can work in. */
  readonly projects?: ProjectStore
  readonly specialists?: SpecialistStore
  readonly skillProposals?: SkillProposalStore
  /** Tools agents made that the person chose to keep. */
  readonly library?: ToolLibrary
  /** What the person keeps across chats (memory). */
  readonly memory?: MemoryStore
  /** Skills agents load by name. */
  readonly skills?: SkillLibrary
  /** The person's hooks (Claude Code format). */
  readonly hooks?: HookStore
  readonly plugins?: PluginStore
  readonly pluginHost?: PluginHost
  /** Rounds that start on a schedule; the server starts the due ones. */
  readonly schedules?: ScheduleStore
  /** Shown in settings so users know whether the shell tool is confined. */
  readonly sandboxKind?: string
}

export interface WebServer {
  readonly url: string
  /** A remote gateway's address for clients, when it has one. */
  readonly publicUrl?: string
  /** Where clients open agent-built pages, when the gateway names it. */
  readonly previewUrl?: string
  /** Whether devices must pair (the gateway is reachable beyond this machine). */
  readonly remote: boolean
  readonly token: string
  /** Makes a single-use pairing link for a new device. */
  pairingLink(scope: DeviceScope): { code: string; link: string }
  stop(): Promise<void>
}

/** Which paired device opened a socket, so revoking it closes them. */
type Opened = { device?: string }
type StreamData = Opened &
  (
    | { kind: 'events'; colony: ColonyId; cursor: number }
    /** A health check from a hub: answered once, then closed. */
    | { kind: 'ping' }
    /** A socket of the page's, carried through to another gateway (this server is the hub). */
    | {
        kind: 'bridge'
        target: string
        gateway: Gateway
        upstream?: WebSocket
        /** What the page sent before the gateway's end opened. */
        pending: (string | Uint8Array<ArrayBuffer>)[]
      }
    | { kind: 'browser'; colony: ColonyId; agent: string; unwatch?: () => void }
    | { kind: 'terminal'; cwd: string; cols: number; rows: number; proc?: Bun.Subprocess }
  )

/** Who a request comes from: the loopback token holder or a dev server (full), or a paired device. */
interface Access {
  readonly scope: DeviceScope
  readonly device?: Device
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** A bind address (no port) on this machine only. */
const isLoopbackName = (name: string) => LOOPBACK.has(name)
/** A Host header (`name:port`, `[v6]:port`) naming this machine only. */
const isLoopback = (host: string) =>
  isLoopbackName(host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, ''))
const DEVICE_COOKIE = 'myr_device'
/** Over HTTPS the cookie carries the `__Host-` prefix: only this exact origin, over TLS, can set or overwrite it. */
const SECURE_DEVICE_COOKIE = `__Host-${DEVICE_COOKIE}`
/** The pairing call comes before sign-in, so its body is capped. */
const PAIR_BODY_MAX = 4096

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

/** Interactive shells open at once; each is a real login shell with the person's own permissions. */
const MAX_TERMINALS = 8

const POLL_MS = 400
/** How long stopping waits for Bun to report the server stopped (see `stop`). */
const STOP_WAIT_MS = 500

const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const sendSchema = Schema.object({
  text: Schema.string().min(1).max(20_000).required(),
  chatId: Schema.string().pattern(/^chat-[a-z0-9-]{1,40}$/),
  delivery: Schema.union(['steer', 'queue']),
  plan: Schema.boolean(),
  project: Schema.string().pattern(/^[a-z0-9-]{1,80}$/),
  attachments: Schema.array(
    Schema.object({
      name: Schema.string().min(1).max(200).required(),
      // Base64; the decoded size is checked against MAX_ATTACHMENT_BYTES.
      data: Schema.string()
        .max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4)
        .required(),
    }),
  ).max(MAX_ATTACHMENTS),
  // Both the current team shape and the older auto/manual one are accepted; normalizeTeamConfig maps them.
  // Without one (the CLI, a script), the person's default team applies.
  config: Schema.union([
    Schema.const(undefined as never),
    Schema.object({
      mode: Schema.union(['orchestrated', 'swarm', 'auto', 'manual']).default('orchestrated'),
      leadModel: Schema.string().required(),
      judgeModel: Schema.string().required(),
      roster: Schema.array(
        Schema.object({ role: Schema.string().max(40).required(), model: Schema.string().required() }),
      ).max(8),
      extraWorkers: Schema.natural().max(8),
      workerModel: Schema.string(),
      workers: Schema.natural().max(8),
      wallMinutes: Schema.number().min(1).max(240),
      thinking: Schema.union(['low', 'medium', 'high']),
    }),
  ]),
})
const BATCH = 500

/** Local dashboard + API. Binds to 127.0.0.1 only and requires a bearer token for every API call. */
/** Validates an MCP server config from the settings page. */
function mcpConfig(raw: Record<string, unknown>): McpServerConfig {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const record = (v: unknown) =>
    v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : undefined
  const type = raw.type === 'http' || raw.type === 'sse' ? raw.type : 'stdio'
  const command = str(raw.command)
  const url = str(raw.url)
  const args = strings(raw.args)
  const env = record(raw.env)
  const headers = record(raw.headers)
  return type === 'stdio'
    ? { type, ...(command ? { command } : {}), ...(args?.length ? { args } : {}), ...(env ? { env } : {}) }
    : { type, ...(url ? { url } : {}), ...(headers ? { headers } : {}) }
}

/** A specialist as the page sends it; the store checks the values themselves. */
function specialistInput(body: unknown): SpecialistInput {
  const b = (body ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    name: text(b.name),
    specialty: text(b.specialty),
    instructions: text(b.instructions),
    ...(typeof b.model === 'string' && b.model ? { model: b.model } : {}),
    off: Array.isArray(b.off) ? (b.off.filter((g) => typeof g === 'string') as SpecialistInput['off']) : [],
  }
}

export function startServer(options: ServeOptions): WebServer {
  const bindHost = options.host ?? '127.0.0.1'
  // Reachable beyond this machine: devices pair, and nothing runs without auth (as Hermes and OpenClaw do).
  const remote = !isLoopbackName(bindHost) || Boolean(options.publicUrl)
  if (remote && options.noAuth)
    throw new Error(
      '--dev turns off auth, so it only works on this machine: drop --host/--public-url, or --dev',
    )
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : undefined
  const previewUrl = options.previewUrl ? new URL(options.previewUrl) : undefined
  // A preview URL names what a proxy or tunnel forwards to; a random port would leave it pointing nowhere.
  if (previewUrl && options.previewPort === undefined)
    throw new Error('--preview-url needs --preview-port, the port it forwards to')
  if (previewUrl && publicUrl && previewUrl.origin === publicUrl.origin)
    throw new Error('--preview-url must be its own origin (another port or host than --public-url)')
  const devices = new DeviceStore(options.home)
  const pairing = new PairingCodes()
  const audit = new AuthAudit(options.home)
  const token = options.noAuth
    ? ''
    : (options.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'))
  const store = new SqliteLogStore(options.home)
  const sockets = new Set<ServerWebSocket<StreamData>>()
  /** Every open socket of every kind, so revoking a device closes its terminals and live views too. */
  const opened = new Set<ServerWebSocket<StreamData>>()
  const gateways = new GatewayStore(options.home)
  const health = new Map<string, GatewayHealth>()
  /** How long a gateway's health stands before it is checked again. */
  const HEALTH_FRESH_MS = 15_000
  const gatewayHealth = async (g: Gateway) => {
    const last = health.get(g.id)
    if (last && Date.now() - Date.parse(last.checkedAt) < HEALTH_FRESH_MS) return last
    const next = await checkHealth(g)
    health.set(g.id, next)
    return next
  }
  /** The team a request gets when it brings none: the person's defaults from Settings. */
  const defaultTeam = () => {
    const team = options.settings?.get().team
    const leadModel = team?.leadModel ?? options.omp?.defaultModel()
    if (!leadModel) throw new Error('no default model: pick one in Settings → Team & budget')
    return normalizeTeamConfig({ ...team, leadModel, judgeModel: team?.judgeModel ?? leadModel })
  }
  const chats = options.chats
  const account = accountName()
  const greetings = options.resolver ? new GreetingWriter(options.resolver) : undefined
  const stopScheduler =
    options.schedules && chats
      ? startScheduler(options.schedules, async (s) => {
          const sent = await chats.send(
            s.request,
            defaultTeam(),
            undefined,
            s.project ? { project: s.project } : {},
          )
          await chats.rename(sent.chatId, `Scheduled · ${s.name}`).catch(() => {})
          return sent.chatId
        })
      : undefined
  const logins = options.omp ? new Logins(options.omp) : undefined
  /** Plugins with whether their code is running, its log, and their settings (secrets shown only as set or not). */
  const pluginList = () =>
    (options.plugins?.list() ?? []).map((p) => {
      const values = options.plugins?.settings(p.name) ?? {}
      return {
        ...p,
        ...(p.server && options.pluginHost ? { status: options.pluginHost.status(p.name) } : {}),
        ...(p.ui ? { uiStamp: uiStamp(p) } : {}),
        values: Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, p.settings[k]?.secret ? (v ? '••••' : '') : v]),
        ),
      }
    })

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })

  let terminals = 0
  /** Host values the server answers to, exactly: its loopback names, the public URL's host, and any added ones. */
  const allowedHosts = () =>
    new Set([
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      `[::1]:${server.port}`,
      // A server bound to one address answers on it; bound to every interface, only named hosts are accepted.
      ...(isLoopbackName(bindHost) || bindHost === '0.0.0.0' || bindHost === '::'
        ? []
        : [bindHost.includes(':') ? `[${bindHost}]:${server.port}` : `${bindHost}:${server.port}`]),
      ...(publicUrl ? [publicUrl.host] : []),
      ...(options.allowHosts ?? []),
    ])
  /** Pages the API accepts requests from: the server's own origins, never another site (DNS-rebinding defence). */
  const allowedOrigin = (origin: string, host: string) =>
    origin === `http://${host}` ||
    (publicUrl !== undefined && origin === publicUrl.origin) ||
    origin === `https://${host}`
  const sameOrigin = (req: Request) => {
    const host = req.headers.get('host') ?? ''
    if (!allowedHosts().has(host)) return false
    const origin = req.headers.get('origin')
    return !origin || allowedOrigin(origin, host)
  }
  const authorized = (req: Request, url: URL): Access | undefined => {
    if (!sameOrigin(req)) return undefined
    if (options.noAuth) return { scope: 'full' }
    const host = req.headers.get('host') ?? ''
    // The token the CLI prints works on this machine only (an SSH tunnel arrives as loopback too); remotely a paired
    // device's cookie is the only way in, so no token ever travels in a URL there.
    if (isLoopback(host)) {
      const header = req.headers.get('authorization')
      const given = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token')
      if (given && tokenEquals(given, token)) return { scope: 'full' }
    }
    const header = req.headers.get('authorization')
    const presented =
      cookie(req, SECURE_DEVICE_COOKIE) ??
      cookie(req, DEVICE_COOKIE) ??
      (header?.startsWith('Device ') ? header.slice(7) : undefined)
    const device = presented ? devices.find(presented) : undefined
    if (presented && !device) audit.record('rejected', { host })
    return device ? { scope: device.scope, device } : undefined
  }
  /** A revoked device is out at once: every socket it has open closes. */
  const closeDevice = (id: string) => {
    for (const ws of opened) if (ws.data.device === id) ws.close(4401, 'device revoked')
  }
  const forbidden = () =>
    json({ error: 'this device can use chats only; pair it with full access for this' }, 403)

  const guard =
    (
      handler: (
        req: Request & { params: Record<string, string> },
        url: URL,
        access: Access,
      ) => Promise<Response> | Response,
    ) =>
    async (req: Request & { params: Record<string, string> }) => {
      const url = new URL(req.url)
      const access = authorized(req, url)
      if (!access) return json({ error: 'unauthorized' }, 401)
      if (access.scope !== 'full' && needsFull(req.method, url.pathname)) return forbidden()
      try {
        return await handler(req, url, access)
      } catch (err) {
        if (
          err instanceof MyrError &&
          (err.code === 'COLONY_NOT_FOUND' || err.code === 'INVALID_COLONY_ID')
        ) {
          return json({ error: err.message }, 404)
        }
        if (err instanceof MyrError && err.code === 'BLOB_NOT_FOUND') return json({ error: err.message }, 404)
        console.error(err)
        return json({ error: 'internal error' }, 500)
      }
    }

  // Agent-built pages run on their own port: a separate origin cannot read the dashboard's token or call its API.
  // Each device gets its own preview key, so revoking a device ends its previews too.
  const previewSecret = crypto.getRandomValues(new Uint8Array(32))
  const previewSig = (subject: string) =>
    createHmac('sha256', previewSecret).update(subject).digest('base64url').slice(0, 32)
  const previewKey = (access: Access) => {
    const subject = access.device?.id ?? 'local'
    return `${subject}.${previewSig(subject)}`
  }
  const previewKeyValid = (key: string) => {
    const dot = key.indexOf('.')
    if (dot < 1) return false
    const subject = key.slice(0, dot)
    if (!tokenEquals(key.slice(dot + 1), previewSig(subject))) return false
    return subject === 'local' || devices.list().some((d) => d.id === subject)
  }
  /** Host values the preview server answers to, as for the dashboard: no foreign name that only resolves here. */
  const previewHosts = () =>
    new Set([
      `127.0.0.1:${preview.port}`,
      `localhost:${preview.port}`,
      `[::1]:${preview.port}`,
      ...(isLoopbackName(bindHost) || bindHost === '0.0.0.0' || bindHost === '::'
        ? []
        : [bindHost.includes(':') ? `[${bindHost}]:${preview.port}` : `${bindHost}:${preview.port}`]),
      ...(previewUrl ? [previewUrl.host] : []),
      ...(options.allowHosts ?? []),
    ])
  /** Where this request's page opens previews: the named preview URL, else the address it reached us on. */
  const previewOrigin = (req: Request): string | undefined => {
    if (previewUrl) return previewUrl.origin
    const host = req.headers.get('host') ?? ''
    // On this machine (an SSH tunnel included, when it forwards the preview port too).
    if (isLoopback(host)) return `http://127.0.0.1:${preview.port}`
    // Opened straight at the address the gateway is bound to (a tailnet address): the preview port is beside it.
    const name = bindHost.includes(':') ? `[${bindHost}]` : bindHost
    if (host === `${name}:${server.port}`) return `http://${name}:${preview.port}`
    return undefined
  }
  /** The latest version of an artifact by name, or why there is none. */
  const latestArtifact = async (
    rawId: string,
    name: string,
  ): Promise<{ body: Buffer<ArrayBuffer>; mediaType: string } | { missing: string }> => {
    try {
      const id = colonyId(rawId)
      const state = foldColony(id, await store.read(id))
      const latest = state.artifacts[name]?.at(-1)
      if (!latest) return { missing: `no artifact ${name}` }
      const blobs = new BlobStore(join(store.colonyDir(id), 'blobs'))
      return { body: Buffer.from(await blobs.get(latest.blob)), mediaType: latest.mediaType }
    } catch (err) {
      if (err instanceof MyrError) return { missing: err.message }
      throw err
    }
  }
  /** An agent-built page as the preview origin serves it: its own type, confined to its own origin. */
  const previewResponse = (body: BodyInit, mediaType: string) =>
    new Response(body, {
      headers: {
        'content-type': `${mediaType}; charset=utf-8`,
        'content-security-policy':
          "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'self'",
        'cache-control': 'no-store',
      },
    })
  const preview = Bun.serve({
    hostname: bindHost,
    port: options.previewPort ?? 0,
    async fetch(req) {
      if (!previewHosts().has(req.headers.get('host') ?? ''))
        return new Response('unauthorized', { status: 401 })
      const url = new URL(req.url)
      // Another gateway's pages, fetched through its API: they open here even when it has no preview address.
      const viaGateway = /^\/gw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname)
      if (viaGateway) {
        const [, gatewayId, rawId, given, rawPath] = viaGateway as unknown as [
          string,
          string,
          string,
          string,
          string,
        ]
        if (!previewKeyValid(given)) return new Response('unauthorized', { status: 401 })
        const gw = gateways.get(gatewayId)
        const target = gw && forwardTarget(gw, `/api/colonies/${rawId}/artifacts/${rawPath}`, '')
        if (!gw || !target) return new Response('not found', { status: 404 })
        try {
          const res = await fetch(target, { headers: asDevice(gw), signal: AbortSignal.timeout(FORWARD_MS) })
          if (!res.ok) return new Response(await res.text(), { status: res.status })
          return previewResponse(res.body ?? '', res.headers.get('x-myr-media-type') ?? 'text/plain')
        } catch {
          return new Response(`${gw.name} is unreachable`, { status: 502 })
        }
      }
      const match = /^\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname)
      if (!match) return new Response('not found', { status: 404 })
      const [, rawId, given, rawPath] = match as unknown as [string, string, string, string]
      if (!previewKeyValid(given)) return new Response('unauthorized', { status: 401 })
      const found = await latestArtifact(rawId, decodeURIComponent(rawPath))
      if ('missing' in found) return new Response(found.missing, { status: 404 })
      return previewResponse(found.body, found.mediaType)
    },
  })

  const server = Bun.serve<StreamData>({
    hostname: bindHost,
    port: options.port ?? 0,
    development: options.debug ? { hmr: true, console: true } : false,
    routes: {
      '/': index,
      // The entry page's line. The rules' greeting comes back at once; with the model writing it, `pending` asks the
      // page to come back shortly for the model's own.
      '/api/greeting': guard(async (req) => {
        const profile = options.settings?.get().profile
        const name = profile?.name ?? account
        const lastSeen = new URL(req.url).searchParams.get('lastSeen')
        const seen = lastSeen ? new Date(lastSeen) : undefined
        const facts = {
          name,
          now: new Date(),
          ...(seen && !Number.isNaN(seen.getTime()) ? { lastSeen: seen } : {}),
          chats: options.chats ? await options.chats.list() : [],
        }
        let model: string | undefined
        try {
          model = profile?.greeting === 'rules' ? undefined : defaultTeam().leadModel
        } catch {
          model = undefined
        }
        const written = model ? greetings?.written(facts, model) : undefined
        return json({
          name,
          greeting: written ?? ruleGreeting(facts),
          pending: !written && Boolean(model && greetings),
        })
      }),
      // Pairing a device: no sign-in yet (the code is the proof), but still only from the server's own origins.
      '/api/pair': {
        POST: async (req: Request) => {
          if (!sameOrigin(req)) return json({ error: 'unauthorized' }, 401)
          const raw = await req.text()
          if (raw.length > PAIR_BODY_MAX) return json({ error: 'request too large' }, 413)
          let body: { code?: unknown; name?: unknown; hub?: unknown } = {}
          try {
            body = JSON.parse(raw) as typeof body
          } catch {
            body = {}
          }
          const host = req.headers.get('host') ?? ''
          const scope = typeof body.code === 'string' ? pairing.take(body.code) : undefined
          if (!scope) {
            audit.record('pair-failed', { host })
            // A wrong code costs a moment, so guessing is slow as well as capped.
            await Bun.sleep(500)
            return json({ error: 'that pairing code is wrong, used or expired; make a new one' }, 401)
          }
          const hub = body.hub === true
          const { device, token: deviceToken } = devices.add(
            typeof body.name === 'string' ? body.name : 'Device',
            scope,
            hub,
          )
          audit.record('paired', {
            device: device.id,
            name: device.name,
            scope,
            host,
            ...(hub ? { hub: 'yes' } : {}),
          })
          const shown = { id: device.id, name: device.name, scope: device.scope }
          // A hub keeps the token itself; a browser gets it as a cookie its page can never read.
          if (hub) return json({ device: shown, token: deviceToken })
          // Over HTTPS (a Tailscale or TLS address) the cookie is Secure and `__Host-` prefixed; on plain HTTP (an SSH
          // tunnel to loopback) it cannot be.
          const secure = publicUrl?.protocol === 'https:' && host === publicUrl.host
          const name = secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE
          return new Response(JSON.stringify({ device: shown }), {
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'set-cookie': `${name}=${encodeURIComponent(deviceToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`,
            },
          })
        },
      },
      /** Who this is: lets the page show what this device may do, and whether the gateway is remote. */
      '/api/whoami': (req: Request) => {
        const access = authorized(req, new URL(req.url))
        if (!access) return json({ error: 'unauthorized', remote }, 401)
        return json({
          scope: access.scope,
          remote,
          ...(access.device ? { device: { id: access.device.id, name: access.device.name } } : {}),
        })
      },
      '/api/devices': {
        GET: guard((req) => {
          const me = authorized(req, new URL(req.url))?.device?.id
          return json({
            remote,
            devices: devices.list().map((d) => ({
              id: d.id,
              name: d.name,
              scope: d.scope,
              createdAt: d.createdAt,
              ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
              ...(d.hub ? { hub: true } : {}),
              ...(d.id === me ? { current: true } : {}),
            })),
          })
        }),
      },
      '/api/devices/pair-code': {
        POST: guard(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { scope?: unknown }
          return json(pairingLink(body.scope === 'chat' ? 'chat' : 'full'))
        }),
      },
      // A device (a hub) unpairing itself, e.g. when the person removes this gateway from their hub.
      '/api/pair/self': {
        DELETE: async (req: Request) => {
          const access = authorized(req, new URL(req.url))
          if (!access?.device) return json({ error: 'only a paired device can unpair itself' }, 401)
          devices.revoke(access.device.id)
          audit.record('revoked', { device: access.device.id, by: 'itself' })
          closeDevice(access.device.id)
          return json({ ok: true })
        },
      },
      '/api/gateways': {
        GET: guard(async () =>
          json({
            gateways: await Promise.all(
              gateways.list().map(async (g) => ({ ...shown(g), health: await gatewayHealth(g) })),
            ),
          }),
        ),
        POST: guard(async (req) => {
          const body = (await req.json().catch(() => ({}))) as {
            link?: unknown
            code?: unknown
            name?: unknown
          }
          if (typeof body.link !== 'string') return json({ error: 'link is required' }, 400)
          try {
            const paired = await pairWith(body.link, {
              ...(typeof body.code === 'string' ? { code: body.code } : {}),
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
            })
            if (gateways.list().some((g) => g.url === paired.url)) {
              await unpair({ ...paired, id: '', addedAt: '' })
              return json({ error: `${paired.url} is already added` }, 409)
            }
            const added = gateways.add(paired)
            return json({ gateway: { ...shown(added), health: await gatewayHealth(added) } })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/gateways/:id': {
        DELETE: guard(async (req) => {
          const gw = gateways.get(req.params.id ?? '')
          if (!gw) return json({ error: 'no such gateway' }, 404)
          gateways.remove(gw.id)
          health.delete(gw.id)
          for (const ws of opened)
            if (ws.data.kind === 'bridge' && ws.data.gateway.id === gw.id) ws.close(1001, 'gateway removed')
          await unpair(gw)
          return json({ ok: true })
        }),
      },
      // Everything for another gateway: the page's requests and sockets, sent on with this hub's token there.
      '/gw/:id/*': async (req: Request & { params: Record<string, string> }) => {
        const url = new URL(req.url)
        const access = authorized(req, url)
        if (!access) return json({ error: 'unauthorized' }, 401)
        if (access.scope !== 'full') return forbidden()
        const gw = gateways.get(req.params.id ?? '')
        if (!gw) return json({ error: 'no such gateway' }, 404)
        const target = forwardTarget(gw, url.pathname.slice(`/gw/${gw.id}`.length), url.search)
        if (!target) return json({ error: 'not found' }, 404)
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          // As for this server's own terminal: a socket that may carry a shell must come from a page with an Origin.
          if (!req.headers.get('origin')) return json({ error: 'unauthorized' }, 401)
          const data = {
            kind: 'bridge' as const,
            target: socketUrl(gw, `${target.pathname}${target.search}`),
            gateway: gw,
            pending: [],
            ...(access.device ? { device: access.device.id } : {}),
          }
          if (server.upgrade(req, { data })) return undefined as unknown as Response
          return json({ error: 'websocket upgrade failed' }, 400)
        }
        // Its pages open on this hub's preview origin, fetched from it by name.
        if (target.pathname === '/api/config') {
          const origin = previewOrigin(req)
          return json(
            origin
              ? { previewOrigin: `${origin}/gw/${gw.id}`, previewToken: previewKey(access) }
              : { previewOrigin: null },
          )
        }
        try {
          const res = await fetch(target, {
            method: req.method,
            headers: forwardHeaders(req, gw),
            ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: await req.arrayBuffer() }),
            redirect: 'manual',
            signal: AbortSignal.timeout(FORWARD_MS),
          })
          return new Response(res.body, { status: res.status, headers: responseHeaders(res) })
        } catch (err) {
          const why = err instanceof Error && err.name === 'TimeoutError' ? 'no answer' : 'unreachable'
          return json({ error: `${gw.name} is ${why}` }, 502)
        }
      },
      '/api/devices/:id': {
        DELETE: guard((req) => {
          const id = req.params.id ?? ''
          if (!devices.revoke(id)) return json({ error: 'no such device' }, 404)
          audit.record('revoked', { device: id })
          closeDevice(id)
          return json({ ok: true })
        }),
      },
      // Without a preview address this device can reach, the page says how to add one instead of a broken frame.
      '/api/config': guard((req, _url, access) => {
        const origin = previewOrigin(req)
        return json(
          origin ? { previewOrigin: origin, previewToken: previewKey(access) } : { previewOrigin: null },
        )
      }),
      '/api/models': guard(async (_req, url) => {
        const omp = options.omp
        if (!omp) return json({ models: [], defaults: options.settings?.get().team })
        if (url.searchParams.get('refresh') === '1') await omp.refreshModels()
        const models = buildCatalog(
          omp,
          options.settings,
          url.searchParams.get('hidden') === '1',
          options.resolver?.windows,
        )
        const saved = options.settings?.get().team
        return json({
          models,
          default: saved?.leadModel ?? omp.defaultModel() ?? models[0]?.ref,
          defaults: saved,
        })
      }),
      '/api/models/test': {
        POST: guard(async (req) => {
          if (!options.resolver) return json({ error: 'model testing needs the chat runtime' }, 503)
          const { ref } = (await req.json()) as { ref?: unknown }
          if (typeof ref !== 'string') return json({ error: 'ref is required' }, 400)
          const started = Date.now()
          try {
            await options.resolver.probe(ref, true)
            return json({ ok: true, ms: Date.now() - started })
          } catch (err) {
            return json({ ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }),
      },
      '/api/settings': {
        GET: guard(() => {
          if (!options.settings) return json({ error: 'settings need the chat runtime' }, 503)
          return json({
            settings: options.settings.get(),
            providers: options.omp?.providers() ?? [],
            searchProviders: options.omp?.searchProviders() ?? [],
            customApis: CUSTOM_APIS,
            sandbox: options.sandboxKind ?? 'unknown',
            home: options.home,
            account,
            agentDir: options.omp?.agentDir,
            ompSetup: existsSync(join(homedir(), '.omp', 'agent')),
            // What per-tool rules can name: every built-in tool, and `mcp` for all MCP tools.
            toolCatalog: [
              ...TOOL_DEFS.map((d) => ({
                name: d.name,
                description: d.description.split(/(?<=\.)\s/)[0] ?? '',
              })),
              { name: 'mcp', description: 'Every tool of the connected MCP servers.', mcp: true },
              ...(options.mcp?.toolList() ?? []).map((t) => ({
                name: t.name,
                description: t.description.split(/(?<=\.)\s/)[0] ?? '',
                mcp: true,
                readOnly: t.readOnly,
              })),
            ],
          })
        }),
        PUT: guard(async (req) => {
          if (!options.settings) return json({ error: 'settings need the chat runtime' }, 503)
          try {
            const settings = options.settings.set(await req.json())
            await options.chats?.permissionsChanged()
            return json({ settings })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/credentials/:provider': {
        PUT: guard(async (req) => {
          if (!options.omp) return json({ error: 'credentials need the chat runtime' }, 503)
          const { apiKey } = (await req.json()) as { apiKey?: unknown }
          if (typeof apiKey !== 'string') return json({ error: 'apiKey is required' }, 400)
          try {
            await options.omp.setApiKey(req.params.provider ?? '', apiKey)
            return json({ ok: true, providers: options.omp.providers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard(async (req) => {
          if (!options.omp) return json({ error: 'credentials need the chat runtime' }, 503)
          await options.omp.removeCredentials(req.params.provider ?? '')
          return json({ ok: true, providers: options.omp.providers() })
        }),
      },
      '/api/providers': {
        POST: guard(async (req) => {
          if (!options.omp) return json({ error: 'providers need the chat runtime' }, 503)
          const body = (await req.json()) as Record<string, unknown>
          if (
            typeof body.name !== 'string' ||
            typeof body.baseUrl !== 'string' ||
            typeof body.api !== 'string'
          ) {
            return json({ error: 'name, baseUrl and api are required' }, 400)
          }
          try {
            const provider = await options.omp.addProvider({
              name: body.name,
              baseUrl: body.baseUrl,
              api: body.api as CustomApi,
              ...(typeof body.apiKey === 'string' && body.apiKey ? { apiKey: body.apiKey } : {}),
              models: Array.isArray(body.models)
                ? body.models.filter((m): m is string => typeof m === 'string')
                : [],
            })
            return json({ ok: true, provider, providers: options.omp.providers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/providers/:name': {
        PUT: guard(async (req) => {
          if (!options.omp) return json({ error: 'providers need the chat runtime' }, 503)
          const body = (await req.json()) as Record<string, unknown>
          if (typeof body.baseUrl !== 'string' || typeof body.api !== 'string') {
            return json({ error: 'baseUrl and api are required' }, 400)
          }
          try {
            const provider = await options.omp.updateProvider(req.params.name ?? '', {
              baseUrl: body.baseUrl,
              api: body.api as CustomApi,
              ...(typeof body.apiKey === 'string' && body.apiKey ? { apiKey: body.apiKey } : {}),
              keyless: body.keyless === true,
              models: Array.isArray(body.models)
                ? body.models.filter((m): m is string => typeof m === 'string')
                : [],
            })
            return json({ ok: true, provider, providers: options.omp.providers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard(async (req) => {
          if (!options.omp) return json({ error: 'providers need the chat runtime' }, 503)
          try {
            await options.omp.removeProvider(req.params.name ?? '')
            return json({ ok: true, providers: options.omp.providers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/logins': {
        GET: guard(() => {
          if (!options.omp) return json({ error: 'sign-in needs the chat runtime' }, 503)
          return json({ logins: options.omp.logins() })
        }),
        POST: guard(async (req) => {
          if (!logins) return json({ error: 'sign-in needs the chat runtime' }, 503)
          const { login } = (await req.json()) as { login?: unknown }
          if (typeof login !== 'string' || !options.omp?.logins().some((l) => l.id === login))
            return json({ error: 'unknown sign-in' }, 400)
          return json(await logins.start(login))
        }),
      },
      '/api/logins/:id': {
        GET: guard((req) => {
          const state = logins?.get(req.params.id ?? '')
          return state ? json(state) : json({ error: 'no such sign-in' }, 404)
        }),
        POST: guard(async (req) => {
          const { answer } = (await req.json()) as { answer?: unknown }
          if (typeof answer !== 'string' || !answer.trim()) return json({ error: 'answer is required' }, 400)
          const state = logins?.answer(req.params.id ?? '', answer.trim())
          return state ? json(state) : json({ error: 'no such sign-in' }, 404)
        }),
        DELETE: guard((req) => {
          const state = logins?.cancel(req.params.id ?? '')
          return state ? json(state) : json({ error: 'no such sign-in' }, 404)
        }),
      },
      '/api/projects': {
        GET: guard(() => json({ projects: options.projects?.list() ?? [] })),
        POST: guard(async (req) => {
          if (!options.projects) return json({ error: 'projects need the chat runtime' }, 503)
          const { path, name } = (await req.json()) as { path?: unknown; name?: unknown }
          if (typeof path !== 'string') return json({ error: 'path is required' }, 400)
          try {
            const project = options.projects.add(path, typeof name === 'string' ? name : undefined)
            return json({ project, projects: options.projects.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/specialists': {
        GET: guard(() => json({ specialists: options.specialists?.list() ?? [] })),
        POST: guard(async (req) => {
          if (!options.specialists) return json({ error: 'specialists need the chat runtime' }, 503)
          try {
            const specialist = options.specialists.save(specialistInput(await req.json()))
            return json({ specialist, specialists: options.specialists.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/specialists/:id': {
        PUT: guard(async (req) => {
          if (!options.specialists) return json({ error: 'specialists need the chat runtime' }, 503)
          try {
            const specialist = options.specialists.save(
              specialistInput(await req.json()),
              req.params.id ?? '',
            )
            return json({ specialist, specialists: options.specialists.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard((req) => {
          if (!options.specialists) return json({ error: 'specialists need the chat runtime' }, 503)
          if (!options.specialists.remove(req.params.id ?? ''))
            return json({ error: 'no such specialist' }, 404)
          return json({ specialists: options.specialists.list() })
        }),
      },
      '/api/projects/:id/permissions': {
        PUT: guard(async (req) => {
          if (!options.projects) return json({ error: 'projects need the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as { mode?: unknown; allow?: unknown }
          const allow = Array.isArray(body.allow)
            ? body.allow.filter((a): a is string => typeof a === 'string')
            : []
          try {
            const project = options.projects.setPermissions(req.params.id ?? '', {
              mode: body.mode as 'auto' | 'ask' | 'read-only',
              allow,
            })
            await options.chats?.permissionsChanged()
            return json({ project, projects: options.projects.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/schedules': {
        GET: guard(() => json({ schedules: options.schedules?.list() ?? [] })),
        POST: guard(async (req) => {
          if (!options.schedules) return json({ error: 'schedules need the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          try {
            options.schedules.add({
              request: String(body.request ?? ''),
              cron: String(body.cron ?? ''),
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...(typeof body.project === 'string' && body.project ? { project: body.project } : {}),
            })
            return json({ schedules: options.schedules.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/schedules/:id': {
        PATCH: guard(async (req) => {
          if (!options.schedules) return json({ error: 'schedules need the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          try {
            options.schedules.update(req.params.id ?? '', {
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...(typeof body.request === 'string' ? { request: body.request } : {}),
              ...(typeof body.cron === 'string' ? { cron: body.cron } : {}),
              ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
              ...(body.project === null || typeof body.project === 'string'
                ? { project: (body.project as string | null) || null }
                : {}),
            })
            return json({ schedules: options.schedules.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard((req) => {
          if (!options.schedules) return json({ error: 'schedules need the chat runtime' }, 503)
          options.schedules.remove(req.params.id ?? '')
          return json({ schedules: options.schedules.list() })
        }),
      },
      '/api/schedules/:id/run': {
        POST: guard(async (req) => {
          const schedule = options.schedules?.list().find((s) => s.id === req.params.id)
          if (!schedule || !chats || !options.schedules) return json({ error: 'no such schedule' }, 404)
          try {
            const sent = await chats.send(
              schedule.request,
              defaultTeam(),
              undefined,
              schedule.project ? { project: schedule.project } : {},
            )
            await chats.rename(sent.chatId, `Scheduled · ${schedule.name}`).catch(() => {})
            options.schedules.ran(schedule.id, { chatId: sent.chatId })
            return json({ chatId: sent.chatId, schedules: options.schedules.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/hooks': {
        GET: guard(() => json(options.hooks?.read() ?? { hooks: {} })),
        PUT: guard(async (req) => {
          if (!options.hooks) return json({ error: 'hooks need the chat runtime' }, 503)
          return json(options.hooks.write(await req.json().catch(() => ({}))))
        }),
      },
      '/api/plugins': {
        GET: guard(() => json({ plugins: pluginList(), dir: options.plugins?.dir })),
        POST: guard(async (req) => {
          if (!options.plugins) return json({ error: 'plugins need the chat runtime' }, 503)
          const { source } = (await req.json().catch(() => ({}))) as { source?: unknown }
          if (typeof source !== 'string') return json({ error: 'give a folder or a git URL' }, 400)
          try {
            const plugin = await options.plugins.install(source)
            await Promise.all([options.mcp?.start(), options.pluginHost?.sync()])
            return json({ plugin, plugins: pluginList() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/plugins/:name/ui.js': guard(async (req) => {
        const plugin = options.plugins?.list().find((p) => p.name === req.params.name && p.enabled)
        if (!plugin?.ui) return json({ error: 'no such plugin UI' }, 404)
        try {
          return new Response(await buildPluginUI(plugin), {
            headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
          })
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 422)
        }
      }),
      '/api/plugins/:name/settings': {
        PUT: guard(async (req) => {
          if (!options.plugins) return json({ error: 'plugins need the chat runtime' }, 503)
          try {
            options.plugins.setSettings(req.params.name ?? '', (await req.json().catch(() => ({}))) as never)
            return json({ plugins: pluginList() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/plugins/:name': {
        PUT: guard(async (req) => {
          if (!options.plugins) return json({ error: 'plugins need the chat runtime' }, 503)
          const { enabled } = (await req.json().catch(() => ({}))) as { enabled?: unknown }
          if (typeof enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, 400)
          try {
            options.plugins.setEnabled(req.params.name ?? '', enabled)
            // Its MCP servers and code load or unload now; skills, commands and hooks apply from the next round.
            await Promise.all([options.mcp?.start(), options.pluginHost?.sync()])
            return json({ plugins: pluginList() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
        DELETE: guard(async (req) => {
          if (!options.plugins) return json({ error: 'plugins need the chat runtime' }, 503)
          try {
            await options.pluginHost?.unload(req.params.name ?? '')
            options.plugins.remove(req.params.name ?? '')
            await Promise.all([options.mcp?.start(), options.pluginHost?.sync()])
            return json({ plugins: pluginList() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/skills': guard((_req, url) => {
        const project = url.searchParams.get('project')
        const path = project ? options.projects?.get(project)?.path : undefined
        return json({ skills: options.skills?.list(path) ?? [], dir: options.skills?.dir })
      }),
      '/api/skills/:name': {
        PUT: guard(async (req) => {
          if (!options.skills) return json({ error: 'skills need the chat runtime' }, 503)
          const { enabled } = (await req.json().catch(() => ({}))) as { enabled?: unknown }
          if (typeof enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, 400)
          options.skills.setEnabled(req.params.name ?? '', enabled)
          return json({ skills: options.skills.list() })
        }),
      },
      '/api/memory': {
        GET: guard(() => json({ memories: options.memory?.list() ?? [] })),
        POST: guard(async (req) => {
          if (!options.memory) return json({ error: 'memory needs the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as {
            text?: unknown
            kind?: unknown
            project?: unknown
          }
          try {
            const memory = options.memory.add({
              text: String(body.text ?? ''),
              kind: String(body.kind ?? 'preference'),
              ...(typeof body.project === 'string' && body.project ? { project: body.project } : {}),
              status: 'active',
              source: { by: 'person' },
            })
            return json({ memory, memories: options.memory.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/memory/:id': {
        PATCH: guard(async (req) => {
          if (!options.memory) return json({ error: 'memory needs the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as {
            text?: unknown
            kind?: unknown
            project?: unknown
          }
          try {
            const memory = options.memory.update(req.params.id ?? '', {
              ...(typeof body.text === 'string' ? { text: body.text } : {}),
              ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
              ...(body.project === null || typeof body.project === 'string'
                ? { project: (body.project as string | null) || null }
                : {}),
            })
            return json({ memory, memories: options.memory.list() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard((req) => {
          if (!options.memory) return json({ error: 'memory needs the chat runtime' }, 503)
          options.memory.remove(req.params.id ?? '')
          return json({ memories: options.memory.list() })
        }),
      },
      // Skills a reviewer proposed from finished work: listed for Settings, kept or discarded by the person.
      '/api/skill-proposals': {
        GET: guard(() => json({ proposals: options.skillProposals?.list('proposed') ?? [] })),
      },
      '/api/skill-proposals/:id/decide': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as {
            keep?: unknown
            description?: unknown
            body?: unknown
          }
          if (typeof body.keep !== 'boolean') return json({ error: 'keep must be true or false' }, 400)
          try {
            await options.chats.decideSkill(req.params.id ?? '', body.keep, {
              ...(typeof body.description === 'string' ? { description: body.description } : {}),
              ...(typeof body.body === 'string' ? { body: body.body } : {}),
            })
            return json({ ok: true })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 409)
          }
        }),
      },
      '/api/chats/:chatId/learn': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          try {
            const proposal = await options.chats.learnNow(req.params.chatId ?? '')
            return json({ proposal: proposal ?? null })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/memory/:id/decide': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const { keep } = (await req.json().catch(() => ({}))) as { keep?: unknown }
          if (typeof keep !== 'boolean') return json({ error: 'keep must be true or false' }, 400)
          try {
            await options.chats.decideMemory(req.params.id ?? '', keep)
            return json({ ok: true })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 409)
          }
        }),
      },
      '/api/colonies/:id/approvals/:approval': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const body = (await req.json().catch(() => ({}))) as {
            approved?: unknown
            edits?: unknown
            note?: unknown
          }
          const { approved, edits, note } = body
          if (typeof approved !== 'boolean') return json({ error: 'approved must be true or false' }, 400)
          // The person may rewrite a review's text fields before approving; only strings, by field key.
          const fields =
            edits && typeof edits === 'object' && !Array.isArray(edits)
              ? Object.entries(edits as Record<string, unknown>)
              : []
          if (fields.some(([, v]) => typeof v !== 'string')) return json({ error: 'edits must be text' }, 400)
          if (note !== undefined && (typeof note !== 'string' || note.length > 2000))
            return json({ error: 'note must be text, at most 2000 characters' }, 400)
          try {
            await options.chats.decideApproval(req.params.id ?? '', req.params.approval ?? '', approved, {
              ...(fields.length ? { edits: Object.fromEntries(fields) as Record<string, string> } : {}),
              ...(typeof note === 'string' && note.trim() ? { note } : {}),
            })
            return json({ ok: true })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 409)
          }
        }),
      },
      '/api/projects/:id': {
        DELETE: guard((req) => {
          options.projects?.remove(req.params.id ?? '')
          return json({ projects: options.projects?.list() ?? [] })
        }),
      },
      // Read-only views of a project's own git repository for the workspace's Git tab.
      '/api/projects/:id/git': guard(async (req) => {
        const project = options.projects?.get(req.params.id ?? '')
        if (!project) return json({ error: 'no such project' }, 404)
        return json(await gitStatus(project.path))
      }),
      '/api/projects/:id/git/changes': guard(async (req) => {
        const project = options.projects?.get(req.params.id ?? '')
        if (!project) return json({ error: 'no such project' }, 404)
        return json(await gitWorkingChanges(project.path))
      }),
      '/api/projects/:id/git/diff': guard(async (req, url) => {
        const project = options.projects?.get(req.params.id ?? '')
        if (!project) return json({ error: 'no such project' }, 404)
        const kind = url.searchParams.get('kind')
        if (kind !== 'staged' && kind !== 'unstaged' && kind !== 'untracked')
          return json({ error: 'kind is staged, unstaged or untracked' }, 400)
        try {
          return json({ patch: await gitFileDiff(project.path, url.searchParams.get('path') ?? '', kind) })
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      }),
      // The person's own source-control actions (never an agent's): local only, nothing is pushed.
      '/api/projects/:id/git/:action': {
        POST: guard(async (req) => {
          const project = options.projects?.get(req.params.id ?? '')
          if (!project) return json({ error: 'no such project' }, 404)
          const body = (await req.json().catch(() => ({}))) as {
            paths?: unknown
            message?: unknown
            all?: unknown
          }
          const paths = Array.isArray(body.paths)
            ? body.paths.filter((p): p is string => typeof p === 'string')
            : []
          try {
            switch (req.params.action) {
              case 'stage':
                await gitStage(project.path, paths)
                return json({ ok: true })
              case 'unstage':
                await gitUnstage(project.path, paths)
                return json({ ok: true })
              case 'discard':
                await gitDiscard(project.path, paths)
                return json({ ok: true })
              case 'commit':
                return json({
                  commit: await gitCommitChanges(
                    project.path,
                    typeof body.message === 'string' ? body.message : '',
                    body.all === true,
                  ),
                })
              default:
                return json({ error: 'unknown git action' }, 404)
            }
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/projects/:id/git/commits/:hash': guard(async (req) => {
        const project = options.projects?.get(req.params.id ?? '')
        if (!project) return json({ error: 'no such project' }, 404)
        try {
          return json(await gitCommit(project.path, req.params.hash ?? ''))
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      }),
      '/api/tools': {
        GET: guard(() => json({ tools: options.library?.list() ?? [] })),
        // Keeps a tool an agent made in a colony, so later rounds start with it. Only the person can do this.
        POST: guard(async (req) => {
          if (!options.library) return json({ error: 'the tool library needs the chat runtime' }, 503)
          const { colonyId: raw, name } = (await req.json()) as { colonyId?: unknown; name?: unknown }
          if (typeof raw !== 'string' || typeof name !== 'string')
            return json({ error: 'colonyId and name are required' }, 400)
          const id = colonyId(raw)
          if (!(await store.exists(id))) return json({ error: 'no such colony' }, 404)
          const made = foldColony(id, await store.read(id)).madeTools[name]
          if (!made) return json({ error: `no tool called ${name} in that colony` }, 404)
          const { seq: _seq, time: _time, agent: _agent, library: _library, ...tool } = made
          try {
            options.library.save(tool)
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
          return json({ tools: options.library.list() })
        }),
      },
      '/api/tools/:name': {
        DELETE: guard((req) => {
          try {
            options.library?.remove(req.params.name ?? '')
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
          return json({ tools: options.library?.list() ?? [] })
        }),
      },
      // Folder names for the project picker; the browser cannot open a native folder dialog.
      '/api/folders': guard((_req, url) => {
        try {
          return json(listFolders(url.searchParams.get('path') ?? '~'))
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      }),
      '/api/mcp': {
        GET: guard(() => {
          if (!options.mcp) return json({ error: 'MCP needs the chat runtime' }, 503)
          return json({ servers: options.mcp.servers() })
        }),
        POST: guard(async (req) => {
          if (!options.mcp) return json({ error: 'MCP needs the chat runtime' }, 503)
          const body = (await req.json()) as { name?: unknown; config?: unknown }
          if (typeof body.name !== 'string' || typeof body.config !== 'object' || !body.config)
            return json({ error: 'name and config are required' }, 400)
          try {
            await options.mcp.add(body.name, mcpConfig(body.config as Record<string, unknown>))
            return json({ servers: options.mcp.servers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/mcp/:name': {
        PUT: guard(async (req) => {
          if (!options.mcp) return json({ error: 'MCP needs the chat runtime' }, 503)
          const { enabled } = (await req.json()) as { enabled?: unknown }
          if (typeof enabled !== 'boolean') return json({ error: 'enabled is required' }, 400)
          try {
            await options.mcp.setEnabled(req.params.name ?? '', enabled)
            return json({ servers: options.mcp.servers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard(async (req) => {
          if (!options.mcp) return json({ error: 'MCP needs the chat runtime' }, 503)
          try {
            await options.mcp.remove(req.params.name ?? '')
            return json({ servers: options.mcp.servers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/mcp-reload': {
        POST: guard(async () => {
          if (!options.mcp) return json({ error: 'MCP needs the chat runtime' }, 503)
          await options.mcp.start()
          return json({ servers: options.mcp.servers() })
        }),
      },
      '/api/import-omp': {
        POST: guard(async () => {
          if (!options.omp) return json({ error: 'import needs the chat runtime' }, 503)
          try {
            const report = importFromOmp(options.home)
            await options.omp.reload()
            await options.mcp?.start()
            return json({ ok: true, ...report, providers: options.omp.providers() })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
      },
      '/api/chats': {
        GET: guard(async () => json(options.chats ? await options.chats.list() : [])),
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          let body: ReturnType<typeof sendSchema>
          try {
            body = sendSchema((await req.json()) as never)
          } catch (err) {
            return json(
              { error: `invalid request: ${err instanceof Error ? err.message : String(err)}` },
              400,
            )
          }
          try {
            // A request without a team (the CLI, a script) runs with the person's default team from Settings.
            const config = body.config
              ? normalizeTeamConfig(body.config as Record<string, unknown>)
              : defaultTeam()
            const attachments = (body.attachments ?? []).map((a) => {
              const bytes = new Uint8Array(Buffer.from(a.data, 'base64'))
              if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${a.name} is larger than 10 MB`)
              return { name: a.name, bytes }
            })
            return json(
              await options.chats.send(body.text, config, body.chatId, {
                ...(body.delivery ? { delivery: body.delivery } : {}),
                attachments,
                planFirst: body.plan === true,
                ...(body.project ? { project: body.project } : {}),
              }),
            )
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      // Chats by what was said in them; the chat list already matches titles itself.
      '/api/chats/search': {
        GET: guard(async (_req, url) =>
          json(options.chats ? await options.chats.search(url.searchParams.get('q') ?? '') : []),
        ),
      },
      '/api/chats/:chatId': {
        PATCH: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const { title } = (await req.json()) as { title?: unknown }
          if (typeof title !== 'string') return json({ error: 'title is required' }, 400)
          try {
            return json({ ok: true, title: await options.chats.rename(req.params.chatId ?? '', title) })
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }),
        DELETE: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const deleted = await options.chats.delete(req.params.chatId ?? '')
          if (deleted.length === 0) return json({ error: 'no such chat' }, 404)
          for (const id of deleted) store.forget(id as ColonyId)
          for (const ws of sockets)
            if (ws.data.kind === 'events' && deleted.includes(ws.data.colony))
              ws.close(1000, 'colony deleted')
          return json({ ok: true, deleted })
        }),
      },
      '/api/chats/:chatId/resume': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          try {
            const body = (await req.json().catch(() => ({}))) as { model?: unknown }
            const model = typeof body.model === 'string' && body.model ? body.model : undefined
            return json(await options.chats.resume(req.params.chatId ?? '', model))
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/chats/:chatId/model': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const { model, agent } = (await req.json().catch(() => ({}))) as {
            model?: unknown
            agent?: unknown
          }
          if (typeof model !== 'string' || !model) return json({ error: 'model is required' }, 400)
          try {
            return json(
              await options.chats.switchModel(
                req.params.chatId ?? '',
                model,
                typeof agent === 'string' && agent ? agent : undefined,
              ),
            )
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/chats/:chatId/stop': {
        POST: guard(async (req) => {
          await options.chats?.stop(req.params.chatId ?? '')
          return json({ ok: true })
        }),
      },
      '/api/colonies': guard(async () => {
        const ids = await store.colonies()
        const rows = []
        for (const id of ids) {
          const state = foldColony(id, await store.read(id))
          rows.push({
            id,
            name: state.name,
            status: state.status,
            statusReason: state.statusReason,
            pattern: state.pattern,
            createdAt: state.createdAt,
            agents: Object.values(state.agents).map((a) => ({
              name: a.info.name,
              model: a.info.model,
              role: a.info.role,
            })),
            metrics: colonyMetrics(state),
          })
        }
        rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        return json(rows)
      }),
      '/api/compare': guard(async (_req, url) => {
        const a = colonyId(url.searchParams.get('a') ?? '')
        const b = colonyId(url.searchParams.get('b') ?? '')
        return json(runDiff({ id: a, events: await store.read(a) }, { id: b, events: await store.read(b) }))
      }),
      '/api/colonies/:id/events': guard(async (req, url) => {
        const id = colonyId(req.params.id ?? '')
        const from = Number(url.searchParams.get('from') ?? '1')
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '5000'), 20000)
        return json(await store.read(id, { from, limit }))
      }),
      '/api/colonies/:id/changes': guard(async (req, url) => {
        if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
        const round = url.searchParams.get('round')
        try {
          return json(await options.chats.changes(req.params.id ?? '', round ? Number(round) : undefined))
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 422)
        }
      }),
      '/api/colonies/:id/rewind': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const { undo, round, force } = (await req.json().catch(() => ({}))) as {
            undo?: unknown
            round?: unknown
            force?: unknown
          }
          try {
            return json(
              await options.chats.rewind(
                req.params.id ?? '',
                undo === true,
                typeof round === 'number' ? round : undefined,
                force === true,
              ),
            )
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      // An artifact by name, for a hub showing this gateway's pages on its own preview origin. Never rendered here: it
      // is inert text to a browser on this origin, with its real type in a header for the hub.
      '/api/colonies/:id/artifacts/*': guard(async (req, url) => {
        const name = decodeURIComponent(url.pathname.split('/artifacts/')[1] ?? '')
        const found = await latestArtifact(req.params.id ?? '', name)
        if ('missing' in found) return json({ error: found.missing }, 404)
        return new Response(found.body, {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "sandbox; default-src 'none'",
            'x-myr-media-type': found.mediaType,
            'cache-control': 'no-store',
          },
        })
      }),
      '/api/health/socket': (req: Request) => {
        const access = authorized(req, new URL(req.url))
        if (!access) return json({ error: 'unauthorized' }, 401)
        const data = { kind: 'ping' as const, ...(access.device ? { device: access.device.id } : {}) }
        if (server.upgrade(req, { data })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
      '/api/colonies/:id/blobs/:hash': guard(async (req) => {
        const id = colonyId(req.params.id ?? '')
        if (!(await store.exists(id))) return json({ error: 'no such colony' }, 404)
        const blobs = new BlobStore(join(store.colonyDir(id), 'blobs'))
        // Browser keyframes are JPEGs; everything else is served as inert text.
        const image = new URL(req.url).searchParams.get('as') === 'jpeg'
        return new Response(Buffer.from(await blobs.get(req.params.hash ?? '')), {
          headers: {
            'content-type': image ? 'image/jpeg' : 'text/plain; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
          },
        })
      }),
      '/api/colonies/:id/stream': async (req: Request & { params: Record<string, string> }) => {
        const url = new URL(req.url)
        const access = authorized(req, url)
        if (!access) return json({ error: 'unauthorized' }, 401)
        const id = colonyId(req.params.id ?? '')
        const cursor = Math.max(0, Number(url.searchParams.get('from') ?? '1') - 1)
        const device = access.device ? { device: access.device.id } : {}
        if (server.upgrade(req, { data: { kind: 'events', colony: id, cursor, ...device } }))
          return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
      '/api/colonies/:id/browsers': guard(async (req) => {
        if (!options.browser) return json({ tabs: [] })
        return json({ tabs: await options.browser.tabs(req.params.id ?? '') })
      }),
      // The person's own shell (not an agent's): a login shell in the chat's project folder, or home.
      '/api/terminal': (req: Request) => {
        const url = new URL(req.url)
        // A shell over a WebSocket must never be reachable from another site: browsers always send Origin, and
        // authorized() already rejects a foreign one, so require it to be present too.
        const access = req.headers.get('origin') ? authorized(req, url) : undefined
        if (!access) return json({ error: 'unauthorized' }, 401)
        if (access.scope !== 'full') return forbidden()
        if (terminals >= MAX_TERMINALS) return json({ error: 'too many terminals open' }, 429)
        const project = url.searchParams.get('project')
        const path = project ? options.projects?.get(project)?.path : homedir()
        if (!path) return json({ error: 'no such project' }, 404)
        const size = (key: string, fallback: number) =>
          Math.min(500, Math.max(10, Number(url.searchParams.get(key)) || fallback))
        const data = {
          kind: 'terminal' as const,
          cwd: path,
          cols: size('cols', 100),
          rows: size('rows', 30),
          ...(access.device ? { device: access.device.id } : {}),
        }
        if (server.upgrade(req, { data })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
      // Live view of an agent's browser tab: frames, its cursor, page changes; the person can take control.
      '/api/colonies/:id/browser/:agent': async (req: Request & { params: Record<string, string> }) => {
        const url = new URL(req.url)
        const access = authorized(req, url)
        if (!access) return json({ error: 'unauthorized' }, 401)
        if (!options.browser) return json({ error: 'no browser on this server' }, 404)
        const data = {
          kind: 'browser' as const,
          colony: colonyId(req.params.id ?? ''),
          agent: req.params.agent ?? '',
          ...(access.device ? { device: access.device.id } : {}),
        }
        if (server.upgrade(req, { data })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
    },
    fetch: () => json({ error: 'not found' }, 404),
    websocket: {
      open(ws) {
        opened.add(ws)
        // The hub closes it once it has its answer.
        if (ws.data.kind === 'ping') {
          ws.send('ok')
          return
        }
        if (ws.data.kind === 'bridge') {
          const data = ws.data
          const upstream = new WebSocket(data.target, {
            // The gateway checks the Origin of sockets (its terminal requires one): this is its own.
            headers: { ...asDevice(data.gateway), origin: data.gateway.url },
          } as never)
          upstream.binaryType = 'arraybuffer'
          data.upstream = upstream
          upstream.onopen = () => {
            for (const m of data.pending.splice(0)) upstream.send(m)
          }
          upstream.onmessage = (e) => ws.send(e.data as string | ArrayBuffer)
          upstream.onclose = (e) => ws.close(passableCode(e.code), e.reason.slice(0, 120))
          upstream.onerror = () => ws.close(1011, `${data.gateway.name} is unreachable`)
          return
        }
        if (ws.data.kind === 'terminal') {
          const data = ws.data
          terminals += 1
          data.proc = Bun.spawn([process.env.SHELL || '/bin/zsh', '-l'], {
            cwd: data.cwd,
            env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
            terminal: {
              cols: data.cols,
              rows: data.rows,
              data: (_t, chunk) => ws.send(chunk),
            },
          })
          void data.proc.exited.then(() => ws.close(1000, 'shell exited'))
          return
        }
        if (ws.data.kind === 'browser') {
          const data = ws.data
          options.browser
            ?.watch(data.colony, data.agent, (e) => ws.send(JSON.stringify(e)))
            .then((unwatch) => {
              data.unwatch = unwatch
            })
            .catch((err) => ws.close(1011, err instanceof Error ? err.message.slice(0, 120) : 'no tab'))
          return
        }
        sockets.add(ws)
        void pump(ws)
      },
      close(ws) {
        opened.delete(ws)
        if (ws.data.kind === 'bridge') {
          const up = ws.data.upstream
          if (up && up.readyState <= WebSocket.OPEN) up.close()
          return
        }
        if (ws.data.kind === 'ping') return
        if (ws.data.kind === 'terminal') {
          terminals -= 1
          ws.data.proc?.terminal?.close()
          ws.data.proc?.kill()
          return
        }
        if (ws.data.kind === 'browser') ws.data.unwatch?.()
        else sockets.delete(ws)
      },
      message(ws, raw) {
        if (ws.data.kind === 'bridge') {
          const up = ws.data.upstream
          const frame = typeof raw === 'string' ? raw : new Uint8Array(raw)
          if (up?.readyState === WebSocket.OPEN) up.send(frame)
          else ws.data.pending.push(frame)
          return
        }
        if (ws.data.kind === 'terminal') {
          const msg = JSON.parse(String(raw)) as {
            type?: string
            data?: unknown
            cols?: unknown
            rows?: unknown
          }
          const term = ws.data.proc?.terminal
          if (msg.type === 'input' && typeof msg.data === 'string') term?.write(msg.data)
          else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number')
            term?.resize(Math.min(500, Math.max(10, msg.cols)), Math.min(500, Math.max(5, msg.rows)))
          return
        }
        if (ws.data.kind !== 'browser' || !options.browser) return
        const { colony, agent } = ws.data
        void (async () => {
          const msg = JSON.parse(String(raw)) as { type: string; by?: unknown }
          if (msg.type === 'control') {
            const by = msg.by === 'person' ? 'person' : 'agent'
            await options.browser?.setControl(colony, agent, by)
            // Handing back ends a sign-in the agent was waiting for, or tells it the page may have changed.
            if (by === 'agent') await options.chats?.handBack(colony, agent)
            return
          }
          await options.browser?.input(colony, agent, msg as LiveInput)
        })().catch((err) =>
          ws.send(
            JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
          ),
        )
      },
    },
  })

  async function pump(ws: ServerWebSocket<StreamData>) {
    if (ws.data.kind !== 'events' || !(await store.exists(ws.data.colony))) return
    const events = await store.read(ws.data.colony, { from: ws.data.cursor + 1, limit: BATCH })
    if (events.length === 0) return
    ws.data.cursor = events.at(-1)?.seq ?? ws.data.cursor
    ws.send(JSON.stringify(events))
  }

  const poll = setInterval(() => {
    for (const ws of sockets) void pump(ws).catch(() => ws.close(1011, 'stream error'))
  }, POLL_MS)

  // A reply as it is written goes straight to whoever watches that round; it is never logged.
  const stopStreaming = options.chats?.onStream((colony, agent, text, done) => {
    const message = JSON.stringify({ type: 'stream', agent, text, done })
    for (const ws of sockets) if (ws.data.kind === 'events' && ws.data.colony === colony) ws.send(message)
  })

  /** A single-use pairing link for a new device, on the address clients use. */
  function pairingLink(scope: DeviceScope): { code: string; link: string } {
    const code = pairing.create(scope)
    const base: string = publicUrl?.origin ?? `http://127.0.0.1:${server.port}`
    return { code, link: `${base}/#pair=${code}` }
  }

  // What this machine's CLI uses to reach the server; a server bound to one address is reached on that address.
  const localHost =
    isLoopbackName(bindHost) || bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost
  return {
    url: options.noAuth
      ? `http://${localHost}:${server.port}/`
      : `http://${localHost}:${server.port}/#token=${token}`,
    ...(publicUrl ? { publicUrl: publicUrl.origin } : {}),
    ...(previewUrl ? { previewUrl: previewUrl.origin } : {}),
    remote,
    pairingLink,
    token,
    async stop() {
      stopScheduler?.()
      clearInterval(poll)
      stopStreaming?.()
      for (const ws of sockets) ws.close(1001, 'server stopping')
      // Bun 1.3 never settles stop() once the server has closed a socket itself (revoking a device, the loop
      // above), though the port is already released; waiting on it would hang shutdown.
      await Promise.race([server.stop(true), Bun.sleep(STOP_WAIT_MS)])
      await preview.stop(true)
      store.close()
    },
  }
}

function tokenEquals(a: string, b: string) {
  const ea = Buffer.from(a)
  const eb = Buffer.from(b)
  return ea.length === eb.length && nodeTimingSafeEqual(ea, eb)
}
