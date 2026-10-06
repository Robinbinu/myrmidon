import type { StreamFn } from '@oh-my-pi/pi-agent-core'
import { completeSimple, getEnvApiKey, type Model } from '@oh-my-pi/pi-ai'
import { getBundledModel, getBundledModels, getBundledProviders } from '@oh-my-pi/pi-catalog'
import { buildCustomModel, readCustomProviders } from './omp-config.ts'
import type { SettingsStore } from './settings.ts'

export interface ResolvedModel {
  readonly ref: string
  readonly model: Model
  /** Set for test models that stream without a network provider. */
  readonly streamFn?: StreamFn
}

/** Resolves `provider/model-id` references. Tests register scripted models under their own refs. */
export class ModelResolver {
  private readonly _custom = new Map<string, ResolvedModel>()
  private readonly _tokens = new Map<string, { value: string; at: number }>()

  private _providers?: ReturnType<typeof readCustomProviders>

  constructor(private readonly settings?: SettingsStore) {
    settings?.onChange(() => {
      this._providers = undefined
    })
  }

  /** Providers from omp's models.yml, overlaid by providers added in Myrmidon settings. */
  customProviders() {
    if (!this._providers) {
      const merged = readCustomProviders()
      for (const p of this.settings?.get().models.providers ?? []) merged.set(p.name, p)
      this._providers = merged
    }
    return this._providers
  }

  private _customProviders() {
    return this.customProviders()
  }

  register(ref: string, resolved: Omit<ResolvedModel, 'ref'>): () => void {
    this._custom.set(ref, { ref, ...resolved })
    return () => this._custom.delete(ref)
  }

  resolve(ref: string): ResolvedModel {
    const custom = this._custom.get(ref)
    if (custom) return custom
    const slash = ref.indexOf('/')
    if (slash <= 0) throw new Error(`model must be "provider/model-id", got ${JSON.stringify(ref)}`)
    const provider = ref.slice(0, slash)
    const id = ref.slice(slash + 1)
    const ompProvider = this._customProviders().get(provider)
    if (ompProvider) {
      const model = buildCustomModel(provider, ompProvider, id)
      if (!model) throw new Error(`unknown model ${JSON.stringify(id)} for provider ${provider}`)
      return { ref, model }
    }
    if (!(getBundledProviders() as string[]).includes(provider)) {
      throw new Error(`unknown model provider ${JSON.stringify(provider)}`)
    }
    try {
      return { ref, model: getBundledModel(provider as never, id) as Model }
    } catch {
      const known = getBundledModels(provider as never)
        .map((m) => m.id)
        .slice(0, 20)
        .join(', ')
      throw new Error(`unknown model ${JSON.stringify(id)} for ${provider}. Known: ${known}`)
    }
  }

  /**
   * Credentials, in order: a key saved in Myrmidon settings, the provider's environment variable,
   * then an existing `omp` login.
   */
  async apiKey(model: Model): Promise<string | undefined> {
    if (model.api === 'mock') return 'mock'
    const saved = this.settings?.apiKey(model.provider)
    if (saved) return saved
    if (this._customProviders().get(model.provider)?.auth === 'none') return 'none'
    const env = getEnvApiKey(model.provider)
    if (env) return env
    const cached = this._tokens.get(model.provider)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value
    const omp = Bun.which('omp')
    if (!omp) return undefined
    const proc = Bun.spawn([omp, 'token', model.provider], { stdout: 'pipe', stderr: 'ignore' })
    const value = (await new Response(proc.stdout).text()).trim()
    if ((await proc.exited) !== 0 || !value) return undefined
    this._tokens.set(model.provider, { value, at: Date.now() })
    return value
  }

  /** Sends a one-line request so unsupported models or rejected credentials fail before a colony starts. */
  async probe(ref: string): Promise<void> {
    const resolved = this.resolve(ref)
    if (resolved.streamFn || resolved.model.api === 'mock') return
    const apiKey = await this.requireApiKey(resolved.model)
    const reply = await completeSimple(
      resolved.model,
      {
        systemPrompt: ['Reply with OK.'],
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
      },
      { apiKey },
    )
    if (reply.stopReason === 'error')
      throw new Error(`model ${ref} is not usable: ${reply.errorMessage ?? 'unknown error'}`)
  }

  async requireApiKey(model: Model): Promise<string> {
    const key = await this.apiKey(model)
    if (!key) {
      throw new Error(
        `no credentials for ${model.provider}: add an API key in Settings → Models, set its environment variable, or run \`omp login ${model.provider}\``,
      )
    }
    return key
  }
}
