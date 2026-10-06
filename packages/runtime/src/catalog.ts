import { getBundledModels, getBundledProviders } from '@oh-my-pi/pi-catalog'
import type { ModelResolver } from './models.ts'
import { listAvailableModels, type ModelOption } from './omp-config.ts'
import type { CustomApi, SettingsStore } from './settings.ts'

export interface CatalogEntry extends ModelOption {
  /** Where the model comes from: the user's omp setup, a provider added in settings, or a saved API key. */
  readonly source: 'omp' | 'custom' | 'key'
  readonly hidden: boolean
}

// Bundled models with these APIs are not chat models and cannot run agents.
const NON_CHAT = /images|speech|embeddings|transcriptions|rerank|video|tts|decisions|web-search/

/** Every model the user can pick: omp's list, custom providers, and built-in providers with a saved key. */
export async function buildCatalog(
  resolver: ModelResolver,
  settings?: SettingsStore,
): Promise<CatalogEntry[]> {
  const hidden = new Set(settings?.get().models.hidden ?? [])
  const out = new Map<string, CatalogEntry>()
  const add = (m: ModelOption, source: CatalogEntry['source']) => {
    if (!out.has(m.ref)) out.set(m.ref, { ...m, source, hidden: hidden.has(m.ref) })
  }
  const custom = new Set((settings?.get().models.providers ?? []).map((p) => p.name))
  for (const [name, provider] of resolver.customProviders()) {
    for (const m of provider.models) {
      add(
        {
          ref: `${name}/${m.id}`,
          provider: name,
          id: m.id,
          name: m.name ?? m.id,
          reasoning: m.reasoning ?? false,
        },
        custom.has(name) ? 'custom' : 'omp',
      )
    }
  }
  for (const m of await listAvailableModels()) add(m, 'omp')
  const bundled = new Set<string>(getBundledProviders() as string[])
  for (const provider of settings?.configuredProviders() ?? []) {
    if (!bundled.has(provider)) continue
    for (const m of getBundledModels(provider as never)) {
      if (NON_CHAT.test(m.api)) continue
      add(
        {
          ref: `${provider}/${m.id}`,
          provider,
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
        },
        'key',
      )
    }
  }
  return [...out.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
  )
}

export function builtInProviders(): string[] {
  return (getBundledProviders() as string[]).filter((p) =>
    getBundledModels(p as never).some((m) => !NON_CHAT.test(m.api)),
  )
}

/** Lists model ids an endpoint offers, the way omp's discovery does for OpenAI-compatible servers. */
export async function discoverModels(api: CustomApi, baseUrl: string, apiKey?: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const signal = AbortSignal.timeout(15_000)
  let url: string
  const headers: Record<string, string> = {}
  if (api === 'anthropic-messages') {
    url = /\/v1$/.test(base) ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`
    if (apiKey) headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (api === 'google-generative-ai') {
    url = `${base}/models?pageSize=1000`
    if (apiKey) headers['x-goog-api-key'] = apiKey
  } else {
    url = `${base}/models`
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  }
  const res = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`)
  const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] }
  const ids = [
    ...(body.data ?? []).map((m) => m.id),
    ...(body.models ?? []).map((m) => m.id ?? m.name?.replace(/^models\//, '')),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort().slice(0, 1000)
}
