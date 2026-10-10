import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { Api, Model } from '@oh-my-pi/pi-ai'
import { ownerOnly } from '../owner-only.ts'
import type { VoiceKeys } from '../voice/providers.ts'
import { createQuotaReader, type QuotaReader } from './usage.ts'

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

/** What generate_image asks an image model for (omp's `ImageGenerationRequest`). */
export interface ImageRequest {
  readonly prompt: string
  /** Pictures to edit or draw from, as base64. */
  readonly inputImages?: readonly { readonly data: string; readonly mimeType: string }[]
  readonly aspectRatio?: string
  readonly imageSize?: string
  readonly count?: number
}

export interface GeneratedImages {
  /** The model that made them, `provider/id`: the one the provider reports when it runs another (Codex does). */
  readonly model: string
  readonly images: readonly { readonly data: string; readonly mimeType: string; readonly size?: string }[]
  /** Words the model wrote beside the pictures, if any. */
  readonly text?: string
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number }
  /** USD, from what the provider reported or the catalog's prices; undefined when neither says. */
  readonly cost?: number
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
  /**
   * Deletes a model from the list a custom provider declares in `models.yml`. False, with nothing changed, when the
   * provider is built in, discovers its models, or this is its only model: those can only be hidden.
   */
  removeModel(provider: string, id: string): Promise<boolean>
  /** Re-reads `models.yml` and asks providers for their current model lists. */
  refreshModels(): Promise<void>
  /**
   * Speech to text with the first speech model omp can call (an OpenAI or Groq key, say); throws when there is none.
   * For voice notes arriving on a channel.
   */
  transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string>
  /** Text to speech (WAV) with the first speech model omp can call (OpenAI or xAI); throws when there is none. */
  speak(
    text: string,
    options?: { voice?: string; speed?: number },
  ): Promise<{ audio: Uint8Array; mimeType: string }>
  /** The speech models omp can call now, as `provider/id`, for Settings → Voice. */
  speechModels(): { stt: string[]; tts: string[] }
  /**
   * The image models omp can call now, as `provider/id`, in the order generate_image tries them when none is chosen:
   * omp's own preference for its image role first, then the rest.
   */
  imageModels(): string[]
  /**
   * Generates (or, with input images, edits) pictures with `model` (`provider/id`), or else with the first of
   * imageModels() that answers. Throws when none can.
   */
  generateImage(
    request: ImageRequest,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<GeneratedImages>
  /**
   * Voice providers' keys, in the same vault as the model providers' (`agent.db`), so a voice provider whose API is a
   * model provider's (OpenAI, Groq, Gemini) uses the key already added for it, and none sits in a file of its own.
   */
  readonly voiceKeys: VoiceKeys
  /**
   * Every credential the vault and `models.yml` hold (API keys, sign-ins' tokens, voice providers' keys), so what goes
   * to model providers can be kept free of them (provider-secrets.ts). Never shown or logged.
   */
  secretValues(): string[]
  search(query: string, options?: SearchOptions): Promise<string>
  read(url: string, signal?: AbortSignal): Promise<ReadResult>
  searchProviders(): { id: string; label: string }[]
  /** How close each signed-in account is to its plan's limits, cached briefly (see omp/usage.ts). */
  readonly quota: QuotaReader
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
 * directory, and its root for logs and caches (PI_CONFIG_DIR, relative to the home directory), from the
 * environment at first import.
 */
export function pointOmpAt(home: string): string {
  const dir = ompAgentDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_CONFIG_DIR = relative(homedir(), join(home, 'omp'))
  return dir
}

let booted: Promise<OmpRuntime> | undefined

export function bootOmp(home: string): Promise<OmpRuntime> {
  booted ??= start(home)
  return booted
}

const PROVIDER_NAME = /^[a-z][a-z0-9-]{1,40}$/
/** A voice provider's vault id: a provider's own (`deepgram`), or a person's endpoint's (`voice-endpoint-<id>`). */
const VOICE_KEY_ID = /^[a-z][a-z0-9-]{1,60}$/

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
  const { collectStoredAccounts } = await import(
    '@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-accounts'
  )
  const search = await import('@oh-my-pi/pi-coding-agent/web/search/index')
  const searchTypes = await import('@oh-my-pi/pi-coding-agent/web/search/types')
  const fetchTool = await import('@oh-my-pi/pi-coding-agent/tools/fetch')
  const { transcribeAudio } = await import('@oh-my-pi/pi-ai/transcription/index')
  const { isSpeechApi, synthesizeSpeech } = await import('@oh-my-pi/pi-ai/speech/index')
  const images = await import('@oh-my-pi/pi-ai/images/index')
  const { ProviderHttpError } = await import('@oh-my-pi/pi-ai/error')
  const { calculateCost } = await import('@oh-my-pi/pi-catalog')
  const { resolveRoleChain } = await import('@oh-my-pi/pi-coding-agent/config/model-resolver')
  const { isAuthenticated } = await import('@oh-my-pi/pi-coding-agent/config/model-registry')
  const modelsPath = join(agentDir, 'models.yml')

  type Credentials = {
    providers(): Iterable<string>
    storeLoginApiKey(provider: string, key: string): Promise<void>
    remove(provider: string): Promise<void>
    hasOAuth(provider: string): boolean
    list(provider?: string): {
      id: number
      credential: { type: 'api_key'; key: string } | { type: 'oauth'; access: string; refresh: string }
    }[]
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
    ownerOnly(tmp)
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

  const ref = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`

  /** Image models omp can call, best first: what omp's image role prefers (as its generate_image does), then the rest. */
  const imagePool = (): Model<Api>[] => {
    const pool = core.registry.getAvailable('image').filter((m) => images.isImageGenerationApi(m.api))
    const preferred = resolveRoleChain('image', core.settings, pool).map((c) => c.model)
    const first = new Set(preferred.map(ref))
    return [...preferred, ...pool.filter((m) => !first.has(ref(m)))]
  }

  /**
   * The chat model that carries a hosted image model's `image_generation` call (OpenAI Responses, ChatGPT sign-ins):
   * the model itself when it can, else the cheapest one on its provider that can, as omp's generate_image picks.
   */
  const imageCarrier = (model: Model<Api>): Model<Api> | undefined => {
    if (model.hostedImage) return model
    let carrier: Model<Api> | undefined
    for (const m of core.registry.getAvailable('chat'))
      if (m.provider === model.provider && m.hostedImage && (!carrier || m.cost.input < carrier.cost.input))
        carrier = m
    return carrier
  }

  /** One image model's attempt: why it was skipped, or what it made. Provider errors are thrown for the caller. */
  const imageAttempt = async (
    model: Model<Api>,
    request: ImageRequest,
    signal: AbortSignal | undefined,
  ): Promise<GeneratedImages | string> => {
    const key = await core.registry.getApiKey(model)
    if (!isAuthenticated(key)) return 'no credentials'
    if (model.api === 'google-gemini-cli' && !images.parseAntigravityCredentials(key))
      return 'invalid credentials'
    let carrier: Model<Api> | undefined
    let apiKey = core.registry.resolver(model)
    if (model.api === 'openai-responses' || model.api === 'openai-codex-responses') {
      carrier = imageCarrier(model)
      if (!carrier) return 'no chat model on its provider to carry it'
      if (!isAuthenticated(await core.registry.getApiKey(carrier))) return 'no credentials for its carrier'
      apiKey = core.registry.resolver(carrier)
    }
    const result = await images.generateImage(
      model,
      {
        prompt: request.prompt,
        ...(request.inputImages?.length ? { inputImages: [...request.inputImages] } : {}),
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
        ...(request.imageSize ? { imageSize: request.imageSize } : {}),
        count: request.count ?? 1,
      },
      { apiKey, ...(carrier ? { carrier } : {}), ...(signal ? { signal } : {}) },
    )
    // What the provider billed when it says; the catalog's per-token prices otherwise.
    const cost = result.usage.cost.total || calculateCost(model, result.usage).total
    return {
      model: result.model && result.model !== model.id ? `${model.provider}/${result.model}` : ref(model),
      images: result.images.map((i) => ({
        data: i.data,
        mimeType: i.mimeType,
        ...(i.size ? { size: i.size } : {}),
      })),
      ...(result.text?.trim() ? { text: result.text.trim() } : {}),
      tokens: { input: result.usage.input, output: result.usage.output, total: result.usage.totalTokens },
      ...(cost > 0 ? { cost } : {}),
    }
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
    async removeModel(provider, id) {
      const doc = readModelsYml()
      const entry = doc.providers[provider]
      const declared = Array.isArray(entry?.models) ? (entry.models as { id?: unknown }[]) : []
      // An empty list would switch the endpoint to discovering its models, bringing every one back.
      if (!entry || declared.length < 2 || !declared.some((m) => m.id === id)) return false
      entry.models = declared.filter((m) => m.id !== id)
      writeModelsYml(doc)
      await core.registry.refresh('offline').catch(() => {})
      return true
    },
    async refreshModels() {
      await core.registry.refresh('online')
    },
    async transcribe(audio, mimeType, fileName) {
      // Only models this transcriber can call: omp also lists local ones it runs another way ("local-inference").
      const models = core.registry.getAvailable('stt').filter((m) => m.api === 'openai-transcriptions')
      // Whisper-style models first; any speech model otherwise.
      const model = models.find((m) => /whisper/i.test(m.id)) ?? models[0]
      if (!model)
        throw new Error(
          'no speech-to-text model: turn on Voice calls in Settings → Voice (Phonon-2 runs on this Mac), or add an OpenAI or Groq key in Settings → Models',
        )
      const apiKey = (await core.registry.getApiKey(model)) as string | undefined
      if (!apiKey) throw new Error(`no key for ${model.provider}`)
      const result = await transcribeAudio(
        model,
        { audio, mimeType, fileName, responseFormat: 'json' },
        { apiKey: apiKey as never },
      )
      return result.text
    },
    async speak(text, options = {}) {
      const model = core.registry.getAvailable('tts').find((m) => isSpeechApi(m.api))
      if (!model) throw new Error('no text-to-speech model: add an OpenAI or xAI key in Settings → Models')
      const apiKey = (await core.registry.getApiKey(model)) as string | undefined
      if (!apiKey) throw new Error(`no key for ${model.provider}`)
      const result = await synthesizeSpeech(
        model,
        {
          text,
          format: 'wav',
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.speed ? { speed: options.speed } : {}),
        },
        { apiKey: apiKey as never },
      )
      return { audio: result.audio, mimeType: result.mimeType }
    },
    speechModels() {
      return {
        stt: core.registry.getAvailable('stt').map(ref),
        tts: core.registry
          .getAvailable('tts')
          .filter((m) => isSpeechApi(m.api))
          .map(ref),
      }
    },
    imageModels: () => imagePool().map(ref),
    async generateImage(request, options = {}) {
      const pool = imagePool()
      let candidates = pool
      if (options.model) {
        const chosen = pool.find((m) => ref(m) === options.model)
        if (!chosen) throw new Error(`the image model ${options.model} cannot be used now`)
        candidates = [chosen]
      }
      if (candidates.length === 0) throw new Error('no image model')
      // Like omp's generate_image: a model that cannot be reached or refuses (a provider error) hands over to the next.
      const failed: string[] = []
      for (const model of candidates) {
        try {
          const made = await imageAttempt(model, request, options.signal)
          if (typeof made !== 'string') return made
          failed.push(`${ref(model)} (${made})`)
        } catch (err) {
          if (!(err instanceof ProviderHttpError) || options.signal?.aborted) throw err
          failed.push(`${ref(model)} (${err.message})`)
        }
      }
      throw new Error(`no image model could make it: ${failed.join('; ')}`)
    },
    voiceKeys: {
      // omp's cascade: a stored key, else the provider's environment variable when omp knows one.
      get: async (id) => ((await core.auth.keys.get(id)) as string | undefined) || undefined,
      stored: (id) => [...core.credentials.providers()].includes(id),
      async set(id, key) {
        if (!VOICE_KEY_ID.test(id)) throw new Error('invalid provider id')
        if (!key.trim()) throw new Error('API key is empty')
        await core.credentials.storeLoginApiKey(id, key.trim())
        await core.registry.refresh('offline').catch(() => {})
      },
      async remove(id) {
        await core.credentials.remove(id)
        await core.registry.refresh('offline').catch(() => {})
      },
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
    // Through `core` on each call, so a reload's new vault is the one read.
    quota: createQuotaReader({
      reports: (signal) =>
        core.auth.usage.reports({
          baseUrlResolver: (provider) => core.registry.getProviderBaseUrl(provider),
          signal,
        }),
      accounts: () => collectStoredAccounts(core.auth),
      supported: (provider) => core.auth.usage.providerFor(provider as never) !== undefined,
      invalidate: () => core.auth.usage.invalidate(),
    }),
    defaultModel: () => core.settings.getModelRole('default'),
    secretValues() {
      const values = core.credentials
        .list()
        .flatMap(({ credential: c }) => (c.type === 'api_key' ? [c.key] : [c.access, c.refresh]))
      // A models.yml key may instead name an environment variable, or a command (`!cmd`) that prints the key: hiding
      // the name or the command would hide words, so the variable's value is hidden instead.
      for (const entry of Object.values(readModelsYml().providers)) {
        const key = entry.apiKey
        if (typeof key !== 'string' || key.startsWith('!')) continue
        values.push(/^[A-Z][A-Z0-9_]*$/.test(key) ? (process.env[key] ?? '') : key)
      }
      return values.filter((v) => typeof v === 'string' && v.length > 0)
    },
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
      ownerOnly(dest)
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
      ownerOnly(join(target, file))
      copied.push(file)
    }
  }
  return { copied, skipped }
}
