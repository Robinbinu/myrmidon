import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BlobStore, colonyId, MyrError, Schema, SqliteLogStore } from '@myrmidon/core'
import { type ColonyId, colonyMetrics, foldColony } from '@myrmidon/protocol'
import {
  buildCatalog,
  type ChatService,
  CUSTOM_APIS,
  type CustomApi,
  importFromOmp,
  type ModelResolver,
  type OmpRuntime,
  type SettingsStore,
} from '@myrmidon/runtime'
import type { ServerWebSocket } from 'bun'
import index from './client/index.html'

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
  /** Shown in settings so users know whether the shell tool is confined. */
  readonly sandboxKind?: string
}

export interface WebServer {
  readonly url: string
  readonly token: string
  stop(): Promise<void>
}

interface StreamData {
  colony: ColonyId
  cursor: number
}

const POLL_MS = 400

const sendSchema = Schema.object({
  text: Schema.string().min(1).max(20_000).required(),
  chatId: Schema.string().pattern(/^chat-[a-z0-9-]{1,40}$/),
  config: Schema.object({
    mode: Schema.union(['auto', 'manual']).default('auto'),
    leadModel: Schema.string().required(),
    workerModel: Schema.string().required(),
    workers: Schema.natural().max(8).default(2),
    judgeModel: Schema.string().required(),
    wallMinutes: Schema.number().min(1).max(240),
  }).required(),
})
const BATCH = 500

/** Local dashboard + API. Binds to 127.0.0.1 only and requires a bearer token for every API call. */
export function startServer(options: ServeOptions): WebServer {
  const token = options.noAuth
    ? ''
    : (options.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'))
  const store = new SqliteLogStore(options.home)
  const sockets = new Set<ServerWebSocket<StreamData>>()

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })

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
      '/api/import-omp': {
        POST: guard(async () => {
          if (!options.omp) return json({ error: 'import needs the chat runtime' }, 503)
          try {
            const report = importFromOmp(options.home)
            await options.omp.reload()
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
            return json(await options.chats.send(body.text, body.config, body.chatId))
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 422)
          }
        }),
      },
      '/api/chats/:chatId': {
        DELETE: guard(async (req) => {
          if (!options.chats) return json({ error: 'this server was started without the chat runtime' }, 503)
          const deleted = await options.chats.delete(req.params.chatId ?? '')
          if (deleted.length === 0) return json({ error: 'no such chat' }, 404)
          for (const id of deleted) store.forget(id as ColonyId)
          for (const ws of sockets) if (deleted.includes(ws.data.colony)) ws.close(1000, 'colony deleted')
          return json({ ok: true, deleted })
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
      '/api/colonies/:id/blobs/:hash': guard(async (req) => {
        const id = colonyId(req.params.id ?? '')
        if (!(await store.exists(id))) return json({ error: 'no such colony' }, 404)
        const blobs = new BlobStore(join(store.colonyDir(id), 'blobs'))
        return new Response(Buffer.from(await blobs.get(req.params.hash ?? '')), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
          },
        })
      }),
      '/api/colonies/:id/stream': async (req: Request & { params: Record<string, string> }) => {
        const url = new URL(req.url)
        if (!authorized(req, url)) return json({ error: 'unauthorized' }, 401)
        const id = colonyId(req.params.id ?? '')
        const cursor = Math.max(0, Number(url.searchParams.get('from') ?? '1') - 1)
        if (server.upgrade(req, { data: { colony: id, cursor } })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      },
    },
    fetch: () => json({ error: 'not found' }, 404),
    websocket: {
      open(ws) {
        sockets.add(ws)
        void pump(ws)
      },
      close(ws) {
        sockets.delete(ws)
      },
      message() {},
    },
  })

  async function pump(ws: ServerWebSocket<StreamData>) {
    if (!(await store.exists(ws.data.colony))) return
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
