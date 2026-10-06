import { getEnvApiKey, type Model } from '@oh-my-pi/pi-ai'
import { getBundledModel, getBundledModels, getBundledProviders } from '@oh-my-pi/pi-catalog'
import type { StreamFn } from '@oh-my-pi/pi-agent-core'

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
   * Credentials come from the provider's environment variable first, then from an existing
   * `omp` login. Nothing is persisted by Myrmidon.
   */
  async apiKey(model: Model): Promise<string | undefined> {
    if (model.api === 'mock') return 'mock'
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

  async requireApiKey(model: Model): Promise<string> {
    const key = await this.apiKey(model)
    if (!key) {
      throw new Error(
        `no credentials for ${model.provider}: set its API key environment variable or run \`omp login ${model.provider}\``,
      )
    }
    return key
  }
}
