import { Database } from 'bun:sqlite'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Api, Model } from '@oh-my-pi/pi-ai'

/**
 * Myrmidon embeds omp's (oh-my-pi) agent libraries in-process: its settings, credential vault, model
 * registry, web search providers, and URL reader. Their data lives in `<home>/agent` in omp's own file
 * formats, so nothing depends on the omp CLI or on `~/.omp`.
 */

export interface SearchOptions {
  readonly limit?: number
  readonly recency?: 'day' | 'week' | 'month' | 'year'
  /** A specific omp search provider id, or `auto` for omp's configured fallback chain. */
  readonly provider?: string
  readonly signal?: AbortSignal
}

export interface ReadResult {
  readonly url: string
  readonly method: string
  readonly contentType: string
  readonly output: string
}

export interface CustomProviderInput {
  readonly name: string
  readonly baseUrl: string
  readonly api: CustomApi
  /** Written to `models.yml` (mode 0600) as omp expects. Omit for endpoints that take no key. */
  readonly apiKey?: string
  /** Model ids. Leave empty to discover them from the endpoint's `/models` list. */
  readonly models: readonly string[]
}

export const CUSTOM_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
export type CustomApi = (typeof CUSTOM_APIS)[number]

export interface ProviderInfo {
  readonly id: string
  readonly models: number
  /** omp holds credentials for it, or it needs none. */
  readonly ready: boolean
  /** Declared in `models.yml` rather than built in. */
  readonly custom: boolean
  readonly baseUrl?: string
}

export interface OmpRuntime {
  readonly agentDir: string
  /** Models omp can call with the credentials it has. */
  available(): Model<Api>[]
  /** Every chat model omp knows, credentialed or not. */
  all(): Model<Api>[]
  find(provider: string, id: string): Model<Api> | undefined
  apiKey(model: Model<Api>): Promise<string | undefined>
  providers(): ProviderInfo[]
  setApiKey(provider: string, key: string): Promise<void>
  removeCredentials(provider: string): Promise<void>
  addProvider(input: CustomProviderInput): Promise<ProviderInfo>
  removeProvider(name: string): Promise<void>
  /** Re-reads `models.yml` and asks providers for their current model lists. */
  refreshModels(): Promise<void>
  search(query: string, options?: SearchOptions): Promise<string>
  read(url: string, signal?: AbortSignal): Promise<ReadResult>
  searchProviders(): { id: string; label: string }[]
  /** omp's `modelRoles.default` from `config.yml`, as `provider/model-id`. */
  defaultModel(): string | undefined
  /** Reopens the credential vault and settings, e.g. after importing an omp setup. */
  reload(): Promise<void>
  close(): void
}

export function ompAgentDir(home: string): string {
  return join(home, 'agent')
}

/**
 * Must run before any `@oh-my-pi/*` module is imported anywhere in the process: omp captures its agent
 * directory from the environment at first import.
 */
export function pointOmpAt(home: string): string {
  const dir = ompAgentDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  process.env.PI_CODING_AGENT_DIR = dir
  return dir
}

let booted: Promise<OmpRuntime> | undefined

export function bootOmp(home: string): Promise<OmpRuntime> {
  booted ??= start(home)
  return booted
}

const PROVIDER_NAME = /^[a-z][a-z0-9-]{1,40}$/

async function start(home: string): Promise<OmpRuntime> {
  const agentDir = ompAgentDir(home)
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  if (process.env.PI_CODING_AGENT_DIR !== agentDir) {
    throw new Error(
      `omp was pointed at ${process.env.PI_CODING_AGENT_DIR ?? '~/.omp'}; call pointOmpAt(home) at startup`,
    )
  }
  const { Settings } = await import('@oh-my-pi/pi-coding-agent/config/settings')
  const { discoverAuthStorage } = await import('@oh-my-pi/pi-coding-agent/sdk')
  const { ModelRegistry } = await import('@oh-my-pi/pi-coding-agent/config/model-registry')
  const search = await import('@oh-my-pi/pi-coding-agent/web/search/index')
  const searchTypes = await import('@oh-my-pi/pi-coding-agent/web/search/types')
  const fetchTool = await import('@oh-my-pi/pi-coding-agent/tools/fetch')
  const modelsPath = join(agentDir, 'models.yml')

  type Credentials = {
    providers(): Iterable<string>
    storeLoginApiKey(provider: string, key: string): Promise<void>
    remove(provider: string): Promise<void>
  }
  const open = async () => {
    const settings = await Settings.init({ agentDir, cwd: agentDir })
    const auth = await discoverAuthStorage(agentDir)
    const registry = new ModelRegistry(auth, modelsPath)
    await registry.refresh('offline').catch(() => {})
    registry.refreshInBackground()
    return { settings, auth, registry, credentials: auth.credentials as unknown as Credentials }
  }
  let core = await open()

  const readModelsYml = (): { providers: Record<string, Record<string, unknown>> } & Record<
    string,
    unknown
  > => {
    if (!existsSync(modelsPath)) return { providers: {} }
    const parsed = (Bun.YAML.parse(readFileSync(modelsPath, 'utf8')) ?? {}) as Record<string, unknown>
    return { ...parsed, providers: (parsed.providers as Record<string, Record<string, unknown>>) ?? {} }
  }
  const writeModelsYml = (doc: object) => {
    const tmp = `${modelsPath}.${process.pid}.tmp`
    // Holds API keys of custom providers.
    writeFileSync(tmp, Bun.YAML.stringify(doc, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, modelsPath)
  }

  const runtime: OmpRuntime = {
    agentDir,
    available: () => core.registry.getAvailable('chat'),
    all: () => core.registry.getAll('chat'),
    find: (provider, id) => core.registry.find(provider, id),
    apiKey: async (model) => (await core.registry.getApiKey(model)) as string | undefined,
    providers() {
      const custom = readModelsYml().providers
      const ready = new Set(core.registry.getAvailable('chat').map((m) => m.provider))
      const counts = new Map<string, number>()
      for (const m of core.registry.getAll('chat')) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1)
      for (const name of Object.keys(custom)) if (!counts.has(name)) counts.set(name, 0)
      return [...counts]
        .map(([id, models]) => {
          const baseUrl = custom[id]?.baseUrl
          return {
            id,
            models,
            ready: ready.has(id),
            custom: id in custom,
            ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
          }
        })
        .sort((a, b) => Number(b.ready) - Number(a.ready) || a.id.localeCompare(b.id))
    },
    async setApiKey(provider, key) {
      if (!PROVIDER_NAME.test(provider)) throw new Error('invalid provider id')
      if (!key.trim()) throw new Error('API key is empty')
      await core.credentials.storeLoginApiKey(provider, key.trim())
      await core.registry.refresh('offline').catch(() => {})
    },
    async removeCredentials(provider) {
      await core.credentials.remove(provider)
      await core.registry.refresh('offline').catch(() => {})
    },
    async addProvider(input) {
      if (!PROVIDER_NAME.test(input.name))
        throw new Error('provider name must be lowercase letters, digits and dashes')
      if (!(CUSTOM_APIS as readonly string[]).includes(input.api))
        throw new Error(`api must be one of ${CUSTOM_APIS.join(', ')}`)
      if (!/^https?:\/\//.test(input.baseUrl)) throw new Error('baseUrl must be an http(s) URL')
      const ids = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))]
      if (ids.length === 0 && input.api !== 'openai-completions' && input.api !== 'openai-responses') {
        throw new Error('list at least one model id: discovery only works for OpenAI-compatible endpoints')
      }
      const doc = readModelsYml()
      doc.providers[input.name] = {
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        api: input.api,
        ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : { auth: 'none' }),
        ...(ids.length
          ? { models: ids.map((id) => ({ id, name: id })) }
          : { discovery: { type: 'openai-models-list' } }),
      }
      writeModelsYml(doc)
      await core.registry.refresh('online')
      const error = core.registry.getError()
      if (error) throw new Error(error.message)
      const info = runtime.providers().find((p) => p.id === input.name)
      if (!info) throw new Error(`omp did not load provider ${input.name}`)
      return info
    },
    async removeProvider(name) {
      const doc = readModelsYml()
      if (!(name in doc.providers)) throw new Error(`${name} is not a custom provider`)
      delete doc.providers[name]
      writeModelsYml(doc)
      await core.credentials.remove(name).catch(() => {})
      await core.registry.refresh('offline').catch(() => {})
    },
    async refreshModels() {
      await core.registry.refresh('online')
    },
    async search(query, options = {}) {
      const result = await search.runSearchQuery(
        {
          query,
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.recency ? { recency: options.recency } : {}),
          ...(options.provider && options.provider !== 'auto' ? { provider: options.provider as never } : {}),
        },
        {
          authStorage: core.auth,
          modelRegistry: core.registry,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
      return result.content.map((c) => c.text).join('\n')
    },
    async read(url, signal) {
      const entry = await fetchTool.fetchReadUrl({ settings: core.settings } as never, { path: url }, signal)
      return {
        url: entry.details.finalUrl ?? url,
        method: entry.details.method,
        contentType: entry.details.contentType,
        output: entry.output,
      }
    },
    searchProviders: () =>
      Object.entries(searchTypes.SEARCH_PROVIDER_LABELS as Record<string, string>).map(([id, label]) => ({
        id,
        label,
      })),
    defaultModel: () => core.settings.getModelRole('default'),
    async reload() {
      const previous = core
      core = await open()
      previous.auth.close()
    },
    close: () => core.auth.close(),
  }
  return runtime
}

export interface ImportReport {
  readonly copied: string[]
  readonly skipped: string[]
}

/**
 * One-time copy of an existing omp setup (credentials, OAuth logins, custom providers, settings) into
 * Myrmidon's agent directory. The credential database is copied with SQLite's online backup so a running
 * omp is never disturbed. Existing Myrmidon files are replaced.
 */
export function importFromOmp(home: string, source = join(homedir(), '.omp', 'agent')): ImportReport {
  const target = ompAgentDir(home)
  mkdirSync(target, { recursive: true })
  const copied: string[] = []
  const skipped: string[] = []
  if (!existsSync(source)) throw new Error(`no omp setup found at ${source}`)
  for (const db of ['agent.db', 'models.db']) {
    const from = join(source, db)
    if (!existsSync(from)) {
      skipped.push(db)
      continue
    }
    const src = new Database(from, { readonly: true })
    try {
      const dest = join(target, db)
      for (const suffix of ['', '-wal', '-shm']) rmSync(dest + suffix, { force: true })
      src.run(`VACUUM INTO '${dest.replaceAll("'", "''")}'`)
      chmodSync(dest, 0o600)
      copied.push(db)
    } finally {
      src.close()
    }
  }
  for (const file of ['models.yml', 'models.yaml', 'config.yml', 'config.yaml', 'mcp.json']) {
    const from = join(source, file)
    if (existsSync(from)) {
      // models.yml may hold API keys inline.
      copyFileSync(from, join(target, file))
      chmodSync(join(target, file), 0o600)
      copied.push(file)
    }
  }
  return { copied, skipped }
}
