import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '@oh-my-pi/pi-ai'
import { buildModel } from '@oh-my-pi/pi-catalog/build'

/** A model the user can pick, as reported by their omp installation. */
export interface ModelOption {
  readonly ref: string
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly contextWindow?: number
}

interface CustomModelSpec {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ('text' | 'image')[]
}

interface CustomProvider {
  baseUrl: string
  api: string
  /** `none` means the endpoint takes no credential. */
  auth?: string
  models: CustomModelSpec[]
}

export function ompAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent')
}

/**
 * Custom OpenAI-compatible providers declared in omp's models.yml (e.g. `ark`). Secret fields are
 * dropped here; credentials are always fetched through `omp token` at call time.
 */
export function readCustomProviders(dir = ompAgentDir()): Map<string, CustomProvider> {
  const out = new Map<string, CustomProvider>()
  const path = join(dir, 'models.yml')
  if (!existsSync(path)) return out
  const parsed = Bun.YAML.parse(readFileSync(path, 'utf8')) as {
    providers?: Record<string, Record<string, unknown>>
  }
  for (const [name, raw] of Object.entries(parsed?.providers ?? {})) {
    if (typeof raw.baseUrl !== 'string' || typeof raw.api !== 'string' || !Array.isArray(raw.models)) continue
    out.set(name, {
      baseUrl: raw.baseUrl,
      api: raw.api,
      ...(typeof raw.auth === 'string' ? { auth: raw.auth } : {}),
      models: (raw.models as CustomModelSpec[]).filter((m) => typeof m?.id === 'string'),
    })
  }
  return out
}

export function buildCustomModel(
  providerName: string,
  provider: CustomProvider,
  id: string,
): Model | undefined {
  const spec = provider.models.find((m) => m.id === id)
  if (!spec) return undefined
  return buildModel({
    id: spec.id,
    name: spec.name ?? spec.id,
    api: provider.api,
    provider: providerName,
    baseUrl: provider.baseUrl,
    reasoning: spec.reasoning ?? false,
    input: spec.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow ?? 128_000,
    maxTokens: spec.maxTokens ?? 16_384,
  } as never) as Model
}

let cached: { at: number; models: ModelOption[] } | undefined

/** Models usable with the user's current omp logins and config, via `omp models --json`. */
export async function listAvailableModels(force = false): Promise<ModelOption[]> {
  if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached.models
  const omp = Bun.which('omp')
  const models: ModelOption[] = []
  if (omp) {
    const proc = Bun.spawn([omp, 'models', '--json'], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    if ((await proc.exited) === 0) {
      const parsed = JSON.parse(text) as { models?: Record<string, unknown>[] }
      for (const m of parsed.models ?? []) {
        if (typeof m.provider !== 'string' || typeof m.id !== 'string') continue
        if (m.kind !== undefined && m.kind !== 'chat' && m.kind !== 'text') continue
        models.push({
          ref: `${m.provider}/${m.id}`,
          provider: m.provider,
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          reasoning: m.reasoning === true,
          ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
        })
      }
    }
  }
  cached = { at: Date.now(), models }
  return models
}

/** omp's configured default model (`modelRoles.default`), used as the picker's starting choice. */
export function ompDefaultModel(dir = ompAgentDir()): string | undefined {
  const path = join(dir, 'config.yml')
  if (!existsSync(path)) return undefined
  const parsed = Bun.YAML.parse(readFileSync(path, 'utf8')) as { modelRoles?: { default?: unknown } }
  return typeof parsed?.modelRoles?.default === 'string' ? parsed.modelRoles.default : undefined
}
