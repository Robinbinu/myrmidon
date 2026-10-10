import { PROBE_FRESH_MS } from './config.ts'
import type { StreamFn } from './omp/agent-core.ts'
import { completeSimple, getEnvApiKey, type Model } from './omp/ai.ts'
import { getBundledModel, getBundledProviders } from './omp/catalog.ts'
import type { OmpRuntime } from './omp/runtime.ts'
import { prompts } from './prompts.ts'
import type { ContextWindows } from './windows.ts'

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

  constructor(
    readonly omp?: OmpRuntime,
    /** Corrects windows omp only guessed; without it omp's own windows are used. */
    readonly windows?: ContextWindows,
  ) {}

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
      return { ref, model: this.windows ? this.windows.apply(model as Model) : (model as Model) }
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

  /** When each model last answered a probe, so a chat does not pay a model round-trip on every message. */
  private readonly _probed = new Map<string, number>()

  /**
   * Sends a one-line request so unsupported models or rejected credentials fail before a colony starts. A model
   * that answered in the last 15 minutes is not asked again; if it fails later, the round pauses on the error.
   * Resolves to what the model said, when it was asked (setup shows it as proof the model answers).
   */
  async probe(ref: string, force = false): Promise<string | undefined> {
    const resolved = this.resolve(ref)
    if (resolved.streamFn || resolved.model.api === 'mock') return undefined
    if (!force && Date.now() - (this._probed.get(ref) ?? 0) < PROBE_FRESH_MS) return undefined
    const apiKey = await this.requireApiKey(resolved.model)
    const reply = await completeSimple(
      resolved.model,
      {
        systemPrompt: [prompts.probe.system],
        messages: [{ role: 'user', content: prompts.probe.message, timestamp: Date.now() }],
      },
      { apiKey },
    )
    if (reply.stopReason === 'error')
      throw new Error(`model ${ref} is not usable: ${reply.errorMessage ?? 'unknown error'}`)
    this._probed.set(ref, Date.now())
    return (
      reply.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join('')
        .trim() || undefined
    )
  }

  /** Fails if a model has no credentials, without calling it. */
  async requireCredentials(ref: string): Promise<void> {
    const resolved = this.resolve(ref)
    if (resolved.streamFn || resolved.model.api === 'mock') return
    await this.requireApiKey(resolved.model)
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

type StreamOptions = Parameters<StreamFn>[2]

/**
 * Ollama loads a model with a 2–4k context unless the request says otherwise, and silently drops what does not fit
 * (Aider and Cline both work around this). Each request asks for room for its prompt plus a reply, rounded up to a
 * power of two so the model is not reloaded on every call, and never more than the model's window.
 */
export function withOllamaContext(model: Model, options: StreamOptions): StreamOptions {
  if (model.api !== 'ollama-chat') return options
  const window = model.contextWindow ?? undefined
  return {
    ...options,
    onPayload: async (payload, m, signal) => {
      const body = ((await options?.onPayload?.(payload, m, signal)) ?? payload) as {
        options?: Record<string, unknown>
      }
      const wanted = Math.ceil(JSON.stringify(body).length / 4) * 1.25 + 8_192
      const size = 2 ** Math.ceil(Math.log2(wanted))
      return { ...body, options: { ...body.options, num_ctx: window ? Math.min(size, window) : size } }
    },
  }
}
