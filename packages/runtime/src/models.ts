import type { StreamFn } from '@oh-my-pi/pi-agent-core'
import { completeSimple, getEnvApiKey, type Model } from '@oh-my-pi/pi-ai'
import { getBundledModel, getBundledProviders } from '@oh-my-pi/pi-catalog'
import type { OmpRuntime } from './omp/runtime.ts'

export interface ResolvedModel {
  readonly ref: string
  readonly model: Model
  /** Set for test models that stream without a network provider. */
  readonly streamFn?: StreamFn
}

/**
 * Resolves `provider/model-id` references through omp's model registry (built-in providers, custom
 * providers from `models.yml`, discovered models). Without omp (tests) only bundled models resolve.
 */
export class ModelResolver {
  private readonly _custom = new Map<string, ResolvedModel>()

  constructor(readonly omp?: OmpRuntime) {}

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
    if (this.omp) {
      const model = this.omp.find(provider, id)
      if (!model)
        throw new Error(`unknown model ${JSON.stringify(ref)}: add its provider in Settings → Models`)
      return { ref, model: model as Model }
    }
    if (!(getBundledProviders() as string[]).includes(provider)) {
      throw new Error(`unknown model provider ${JSON.stringify(provider)}`)
    }
    try {
      return { ref, model: getBundledModel(provider as never, id) as Model }
    } catch {
      throw new Error(`unknown model ${JSON.stringify(ref)}`)
    }
  }

  /** omp's credential chain (stored keys, OAuth logins refreshed as needed, keyless providers), then env vars. */
  async apiKey(model: Model): Promise<string | undefined> {
    if (model.api === 'mock') return 'mock'
    return (await this.omp?.apiKey(model as never)) ?? getEnvApiKey(model.provider)
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
        `no credentials for ${model.provider}: add a key in Settings → Models, import your omp setup, or set its environment variable`,
      )
    }
    return key
  }
}
