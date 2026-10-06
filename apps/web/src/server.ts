import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BlobStore, colonyId, MyrError, Schema, SqliteLogStore } from '@myrmidon/core'
import { type ColonyId, colonyMetrics, foldColony } from '@myrmidon/protocol'
import {
  type BrowserHub,
  buildCatalog,
  type ChatService,
  CUSTOM_APIS,
  type CustomApi,
  gitCommit,
  gitStatus,
  gitWorkingChanges,
  importFromOmp,
  type LiveInput,
  listFolders,
  type McpHub,
  type McpServerConfig,
  type ModelResolver,
  normalizeTeamConfig,
  type OmpRuntime,
  type ProjectStore,
  type SettingsStore,
  type ToolLibrary,
} from '@myrmidon/runtime'
import type { ServerWebSocket } from 'bun'
import index from './client/index.html'
import { Logins } from './logins.ts'

export interface ServeOptions {
  readonly home: string
  /** 0 picks a free port. */
  readonly port?: number
  readonly token?: string
  /**
   * Development only: skip the bearer token. The server still binds to 127.0.0.1 and still rejects
   * foreign Host and Origin headers, so other sites and DNS rebinding cannot reach the API.
   */
  readonly noAuth?: boolean
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
  /** Tools agents made that the person chose to keep. */
  readonly library?: ToolLibrary
  /** Shown in settings so users know whether the shell tool is confined. */
  readonly sandboxKind?: string
}

export interface WebServer {
  readonly url: string
  readonly token: string
  stop(): Promise<void>
}

type StreamData =
  | { kind: 'events'; colony: ColonyId; cursor: number }
  | { kind: 'browser'; colony: ColonyId; agent: string; unwatch?: () => void }
  | { kind: 'terminal'; cwd: string; cols: number; rows: number; proc?: Bun.Subprocess }

/** Interactive shells open at once; each is a real login shell with the person's own permissions. */
const MAX_TERMINALS = 8

const POLL_MS = 400

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
  config: Schema.object({
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
  }).required(),
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

export function startServer(options: ServeOptions): WebServer {
  const token = options.noAuth
    ? ''
    : (options.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'))
  const store = new SqliteLogStore(options.home)
  const sockets = new Set<ServerWebSocket<StreamData>>()
  const logins = options.omp ? new Logins(options.omp) : undefined

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })

  let terminals = 0
  const authorized = (req: Request, url: URL) => {
    const host = req.headers.get('host') ?? ''
    if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return false
    const origin = req.headers.get('origin')
    if (origin && origin !== `http://${host}`) return false
    if (options.noAuth) return true
    const header = req.headers.get('authorization')
    const given = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token')
    return given !== null && given !== undefined && tokenEquals(given, token)
  }

  const guard =
    (
      handler: (req: Request & { params: Record<string, string> }, url: URL) => Promise<Response> | Response,
    ) =>
    async (req: Request & { params: Record<string, string> }) => {
      const url = new URL(req.url)
      if (!authorized(req, url)) return json({ error: 'unauthorized' }, 401)
      try {
        return await handler(req, url)
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
  const previewToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')
  const preview = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const match = /^\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname)
      if (!match) return new Response('not found', { status: 404 })
      const [, rawId, given, rawPath] = match as unknown as [string, string, string, string]
      if (!tokenEquals(given, previewToken)) return new Response('unauthorized', { status: 401 })
      try {
        const id = colonyId(rawId)
        const state = foldColony(id, await store.read(id))
        const name = decodeURIComponent(rawPath)
        const latest = state.artifacts[name]?.at(-1)
        if (!latest) return new Response(`no artifact ${name}`, { status: 404 })
        const blobs = new BlobStore(join(store.colonyDir(id), 'blobs'))
        return new Response(Buffer.from(await blobs.get(latest.blob)), {
          headers: {
            'content-type': `${latest.mediaType}; charset=utf-8`,
            'content-security-policy': "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'",
            'cache-control': 'no-store',
          },
        })
      } catch (err) {
        if (err instanceof MyrError) return new Response(err.message, { status: 404 })
        throw err
      }
    },
  })

  const server = Bun.serve<StreamData>({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    development: false,
    routes: {
      '/': index,
      '/api/config': guard(() => json({ previewOrigin: `http://127.0.0.1:${preview.port}`, previewToken })),
      '/api/models': guard(async (_req, url) => {
        const omp = options.omp
        if (!omp) return json({ models: [], defaults: options.settings?.get().team })
        if (url.searchParams.get('refresh') === '1') await omp.refreshModels()
        const models = buildCatalog(omp, options.settings, url.searchParams.get('hidden') === '1')
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
            await options.resolver.probe(ref)
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
            agentDir: options.omp?.agentDir,
            ompSetup: existsSync(join(homedir(), '.omp', 'agent')),
          })
        }),
        PUT: guard(async (req) => {
          if (!options.settings) return json({ error: 'settings need the chat runtime' }, 503)
          try {
            return json({ settings: options.settings.set(await req.json()) })
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
            const config = normalizeTeamConfig(body.config as Record<string, unknown>)
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
      '/api/colonies/:id/events': guard(async (req, url) => {
        const id = colonyId(req.params.id ?? '')
        const from = Number(url.searchParams.get('from') ?? '1')
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '5000'), 20000)
        return json(await store.read(id, { from, limit }))
      }),
      '/api/colonies/:id/changes': guard(async (req) => {
        if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
        try {
          return json(await options.chats.changes(req.params.id ?? ''))
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 422)
        }
      }),
      '/api/colonies/:id/rewind': {
        POST: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const { undo } = (await req.json().catch(() => ({}))) as { undo?: unknown }
          try {
            return json(await options.chats.rewind(req.params.id ?? '', undo === true))
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
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
        if (!authorized(req, url)) return json({ error: 'unauthorized' }, 401)
        const id = colonyId(req.params.id ?? '')
        const cursor = Math.max(0, Number(url.searchParams.get('from') ?? '1') - 1)
        if (server.upgrade(req, { data: { kind: 'events', colony: id, cursor } }))
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
        if (!req.headers.get('origin') || !authorized(req, url)) return json({ error: 'unauthorized' }, 401)
        if (terminals >= MAX_TERMINALS) return json({ error: 'too many terminals open' }, 429)
        const project = url.searchParams.get('project')
        const path = project ? options.projects?.get(project)?.path : homedir()
        if (!path) return json({ error: 'no such project' }, 404)
        const size = (key: string, fallback: number) =>
          Math.min(500, Math.max(10, Number(url.searchParams.get(key)) || fallback))
        const data = { kind: 'terminal' as const, cwd: path, cols: size('cols', 100), rows: size('rows', 30) }
        if (server.upgrade(req, { data })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
      // Live view of an agent's browser tab: frames, its cursor, page changes; the person can take control.
      '/api/colonies/:id/browser/:agent': async (req: Request & { params: Record<string, string> }) => {
        const url = new URL(req.url)
        if (!authorized(req, url)) return json({ error: 'unauthorized' }, 401)
        if (!options.browser) return json({ error: 'no browser on this server' }, 404)
        const data = {
          kind: 'browser' as const,
          colony: colonyId(req.params.id ?? ''),
          agent: req.params.agent ?? '',
        }
        if (server.upgrade(req, { data })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
    },
    fetch: () => json({ error: 'not found' }, 404),
    websocket: {
      open(ws) {
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
            if (by === 'agent')
              options.chats?.wakeAgent(
                colony,
                agent,
                'The person handed your browser back. They may have navigated or filled things in: take a fresh browser_snapshot and continue.',
              )
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

  return {
    url: options.noAuth
      ? `http://127.0.0.1:${server.port}/`
      : `http://127.0.0.1:${server.port}/#token=${token}`,
    token,
    async stop() {
      clearInterval(poll)
      for (const ws of sockets) ws.close(1001, 'server stopping')
      await server.stop(true)
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
