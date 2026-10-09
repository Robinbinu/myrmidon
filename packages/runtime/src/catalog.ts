import { titleModel } from './chat-titles.ts'
import type { OmpRuntime } from './omp/runtime.ts'
import type { SettingsStore } from './settings.ts'
import type { ContextWindows, WindowSource } from './windows.ts'

/** A model the user can pick. */
export interface ModelOption {
  readonly ref: string
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly contextWindow?: number
  /** Where `contextWindow` came from; absent when it is omp's default guess. */
  readonly windowSource?: WindowSource
}

export interface CatalogEntry extends ModelOption {
  readonly hidden: boolean
}

/** Chat models omp can call with the credentials it has; hidden ones only when `includeHidden`. */
export function buildCatalog(
  omp: OmpRuntime,
  settings?: SettingsStore,
  includeHidden = false,
  windows?: ContextWindows,
): CatalogEntry[] {
  const prefs = settings?.get().models
  const hiddenRefs = new Set(prefs?.hidden ?? [])
  const hiddenProviders = new Set(prefs?.hiddenProviders ?? [])
  const out: CatalogEntry[] = []
  for (const m of omp.available()) {
    const ref = `${m.provider}/${m.id}`
    const hidden = hiddenRefs.has(ref) || hiddenProviders.has(m.provider)
    if (!includeHidden && hidden) continue
    const window = windows?.of(m) ?? { tokens: m.contextWindow ?? undefined }
    out.push({
      ref,
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning === true,
      ...(window.tokens ? { contextWindow: window.tokens } : {}),
      ...(window.source ? { windowSource: window.source } : {}),
      hidden,
    })
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
}

/**
 * The model a crew gets when no lead is set: omp's default while the person can see it; else the first model they can
 * see from `provider` (the one a removed model came from), else the first they can see at all.
 */
export function defaultModelRef(
  omp: OmpRuntime,
  settings?: SettingsStore,
  provider?: string,
): string | undefined {
  const shown = buildCatalog(omp, settings)
  const preferred = omp.defaultModel()
  if (preferred && (!shown.length || shown.some((m) => m.ref === preferred))) return preferred
  return (shown.find((m) => m.provider === provider) ?? shown[0])?.ref ?? preferred
}

/** The model that names chats (`titleModel`) among those the person can use and has not hidden. */
export function namingModel(omp: OmpRuntime, settings: SettingsStore | undefined, lead: string): string {
  const prefs = settings?.get().models
  const hidden = new Set(prefs?.hidden ?? [])
  const hiddenProviders = new Set(prefs?.hiddenProviders ?? [])
  const candidates = omp
    .available()
    .filter((m) => !hidden.has(`${m.provider}/${m.id}`) && !hiddenProviders.has(m.provider))
    .map((m) => ({
      provider: m.provider,
      id: m.id,
      inputPrice: m.cost?.input ?? 0,
      contextWindow: m.contextWindow ?? null,
    }))
  return titleModel(candidates, lead)
}
