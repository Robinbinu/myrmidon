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
  /** Custom providers only: what `models.yml` declares, for editing. */
  readonly api?: string
  readonly modelIds?: string[]
  readonly keyless?: boolean
  readonly hasKey?: boolean
  /**
   * Myrmidon holds this provider's key (its vault or `models.yml`), so removing it there turns the provider off.
   * A ready provider without one works through credentials Myrmidon does not own: environment variables, a
   * cloud profile such as ~/.aws, or none at all.
   */
  readonly stored?: boolean
}

export interface ProviderUpdate {
  readonly baseUrl: string
  readonly api: CustomApi
  /** A new key; omitted keeps the current one. */
  readonly apiKey?: string
  readonly keyless: boolean
  readonly models: readonly string[]
}

/** A subscription or account sign-in omp supports (Claude Pro/Max, ChatGPT, Gemini, …). */
export interface LoginOption {
  readonly id: string
  readonly name: string
  /** The model provider the login authenticates. */
  readonly provider: string
  /** omp can call this provider's models right now. */
  readonly ready: boolean
  /** Myrmidon holds an OAuth sign-in for the provider (not just an API key), so there is something to sign out of. */
  readonly signedIn: boolean
}

/** How a sign-in talks to the person doing it. */
export interface LoginHandlers {
  /** Open this URL in a browser; the login finishes by itself when the provider redirects back. */
  onAuth(url: string, instructions?: string): void
  /** A question the flow needs answered, e.g. a pasted authorization code. */
  onPrompt(message: string, placeholder?: string): Promise<string>
  onProgress(message: string): void
  readonly signal: AbortSignal
}

export interface LoginResult {
  readonly email?: string
  readonly orgName?: string
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
  /** Removes the provider's OAuth sign-ins and keeps any API key stored for it. */
  signOut(provider: string): Promise<void>
  logins(): LoginOption[]
  /** Runs an interactive OAuth sign-in and stores the credential in the vault. */
  login(id: string, handlers: LoginHandlers): Promise<LoginResult | undefined>
  addProvider(input: CustomProviderInput): Promise<ProviderInfo>
  updateProvider(name: string, update: ProviderUpdate): Promise<ProviderInfo>
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
  const { getOAuthProviders } = await import('@oh-my-pi/pi-ai/registry/oauth/index')
  const search = await import('@oh-my-pi/pi-coding-agent/web/search/index')
  const searchTypes = await import('@oh-my-pi/pi-coding-agent/web/search/types')
  const fetchTool = await import('@oh-my-pi/pi-coding-agent/tools/fetch')
  const modelsPath = join(agentDir, 'models.yml')

  type Credentials = {
    providers(): Iterable<string>
    storeLoginApiKey(provider: string, key: string): Promise<void>
    remove(provider: string): Promise<void>
    hasOAuth(provider: string): boolean
    list(provider: string): { id: number; credential: { type: 'api_key' | 'oauth' } }[]
    removeById(provider: string, id: number): Promise<boolean>
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

  /** Writes a custom provider to models.yml, keeping fields Myrmidon does not edit (headers, compat, model limits). */
  const saveProvider = async (name: string, update: ProviderUpdate): Promise<ProviderInfo> => {
    if (!(CUSTOM_APIS as readonly string[]).includes(update.api))
      throw new Error(`api must be one of ${CUSTOM_APIS.join(', ')}`)
    if (!/^https?:\/\//.test(update.baseUrl)) throw new Error('baseUrl must be an http(s) URL')
    const ids = [...new Set(update.models.map((m) => m.trim()).filter(Boolean))]
    if (ids.length === 0 && update.api !== 'openai-completions' && update.api !== 'openai-responses') {
      throw new Error('list at least one model id: discovery only works for OpenAI-compatible endpoints')
    }
    const doc = readModelsYml()
    const previous = doc.providers[name] ?? {}
    const previousModels = new Map(
      (Array.isArray(previous.models) ? (previous.models as { id: string }[]) : []).map((m) => [m.id, m]),
    )
    const { apiKey: oldKey, auth: _auth, discovery: _discovery, models: _models, ...kept } = previous
    const apiKey = update.keyless ? undefined : update.apiKey?.trim() || (oldKey as string | undefined)
    if (!update.keyless && !apiKey) throw new Error('an API key is required unless the endpoint takes none')
    doc.providers[name] = {
      ...kept,
      baseUrl: update.baseUrl.trim().replace(/\/+$/, ''),
      api: update.api,
      ...(apiKey ? { apiKey } : { auth: 'none' }),
      ...(ids.length
        ? { models: ids.map((id) => previousModels.get(id) ?? { id, name: id }) }
        : { discovery: { type: 'openai-models-list' } }),
    }
    writeModelsYml(doc)
    await core.registry.refresh('online')
    const error = core.registry.getError()
    if (error) throw new Error(error.message)
    const info = runtime.providers().find((p) => p.id === name)
    if (!info) throw new Error(`omp did not load provider ${name}`)
    return info
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
      const stored = new Set(core.credentials.providers())
      const counts = new Map<string, number>()
      for (const m of core.registry.getAll('chat')) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1)
      for (const name of Object.keys(custom)) if (!counts.has(name)) counts.set(name, 0)
      return [...counts]
        .map(([id, models]): ProviderInfo => {
          const entry = custom[id]
          if (!entry) return { id, models, ready: ready.has(id), custom: false, stored: stored.has(id) }
          const declared = Array.isArray(entry.models) ? (entry.models as { id?: unknown }[]) : []
          return {
            id,
            models,
            ready: ready.has(id),
            custom: true,
            ...(typeof entry.baseUrl === 'string' ? { baseUrl: entry.baseUrl } : {}),
            ...(typeof entry.api === 'string' ? { api: entry.api } : {}),
            modelIds: declared.map((m) => m.id).filter((m): m is string => typeof m === 'string'),
            keyless: entry.auth === 'none',
            hasKey: typeof entry.apiKey === 'string' && entry.apiKey.length > 0,
            stored: typeof entry.apiKey === 'string' && entry.apiKey.length > 0,
          }
        })
        .sort((a, b) => Number(b.ready) - Number(a.ready) || a.id.localeCompare(b.id))
    },
    async setApiKey(provider, key) {
      if (!PROVIDER_NAME.test(provider)) throw new Error('invalid provider id')
      if (!key.trim()) throw new Error('API key is empty')
      const doc = readModelsYml()
      const entry = doc.providers[provider]
      if (entry) {
        // Custom providers read their key from models.yml.
        entry.apiKey = key.trim()
        delete entry.auth
        writeModelsYml(doc)
      } else {
        await core.credentials.storeLoginApiKey(provider, key.trim())
      }
      await core.registry.refresh('offline').catch(() => {})
    },
    async removeCredentials(provider) {
      await core.credentials.remove(provider)
      await core.registry.refresh('offline').catch(() => {})
    },
    async signOut(provider) {
      // remove(provider) would also delete an API key stored next to the sign-in.
      for (const row of core.credentials.list(provider))
        if (row.credential.type === 'oauth') await core.credentials.removeById(provider, row.id)
      await core.registry.refresh('offline').catch(() => {})
    },
    logins() {
      const ready = new Set(core.registry.getAvailable('chat').map((m) => m.provider))
      return getOAuthProviders()
        .filter((p) => p.available)
        .map((p) => {
          const provider = p.storeCredentialsAs ?? p.id
          return {
            id: p.id,
            name: p.name,
            provider,
            ready: ready.has(provider),
            signedIn: core.credentials.hasOAuth(provider),
          }
        })
    },
    async login(id, handlers) {
      if (!getOAuthProviders().some((p) => p.id === id)) throw new Error(`unknown sign-in ${id}`)
      const identity = await core.auth.oauth.login(id, {
        // The full authorization URL, not omp's short `launchUrl`: that one redirects from this machine's loopback
        // callback server, so it opens nowhere for someone signing in from another device (a remote gateway).
        onAuth: (info) => handlers.onAuth(info.url, info.instructions),
        onPrompt: (prompt) => handlers.onPrompt(prompt.message, prompt.placeholder),
        onManualCodeInput: () =>
          handlers.onPrompt('Or paste the authorization code / redirect URL here', 'code#state or URL'),
        onProgress: handlers.onProgress,
        signal: handlers.signal,
      })
      await core.registry.refresh('offline').catch(() => {})
      if (!identity) return undefined
      return {
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.orgName ? { orgName: identity.orgName } : {}),
      }
    },
    async addProvider(input) {
      if (!PROVIDER_NAME.test(input.name))
        throw new Error('provider name must be lowercase letters, digits and dashes')
      if (
        readModelsYml().providers[input.name] ||
        core.registry.getAll('chat').some((m) => m.provider === input.name)
      )
        throw new Error(`a provider named ${input.name} already exists`)
      return saveProvider(input.name, {
        baseUrl: input.baseUrl,
        api: input.api,
        ...(input.apiKey?.trim() ? { apiKey: input.apiKey } : {}),
        keyless: !input.apiKey?.trim(),
        models: input.models,
      })
    },
    async updateProvider(name, update) {
      if (!readModelsYml().providers[name]) throw new Error(`${name} is not a custom provider`)
      return saveProvider(name, update)
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
