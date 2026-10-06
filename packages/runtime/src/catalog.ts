import type { OmpRuntime } from './omp/runtime.ts'
import type { SettingsStore } from './settings.ts'

/** A model the user can pick. */
export interface ModelOption {
  readonly ref: string
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly contextWindow?: number
}

export interface CatalogEntry extends ModelOption {
  readonly hidden: boolean
}

/** Chat models omp can call with the credentials it has; hidden ones only when `includeHidden`. */
export function buildCatalog(
  omp: OmpRuntime,
  settings?: SettingsStore,
  includeHidden = false,
): CatalogEntry[] {
  const hidden = new Set(settings?.get().models.hidden ?? [])
  const out: CatalogEntry[] = []
  for (const m of omp.available()) {
    const ref = `${m.provider}/${m.id}`
    if (!includeHidden && hidden.has(ref)) continue
    out.push({
      ref,
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning === true,
      ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
      hidden: hidden.has(ref),
    })
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
}
