import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Schema } from '@myrmidon/core'

export const TOOL_GROUPS = {
  shell: ['shell'],
  web: ['web_search', 'web_fetch'],
  files: ['fs_write', 'fs_read', 'fs_list'],
  messaging: ['send_mail', 'post', 'append_note'],
} as const
export type ToolGroup = keyof typeof TOOL_GROUPS

/**
 * Myrmidon's own preferences. Model providers, API keys, and OAuth logins are not here: they live in
 * omp's credential vault and `models.yml` inside `<home>/agent` (see `omp/runtime.ts`).
 */
export interface MyrSettings {
  version: 1
  team: {
    mode: 'orchestrated' | 'swarm'
    workers: number
    leadModel?: string
    workerModel?: string
    judgeModel?: string
    wallMinutes: number
    maxTurns: number
  }
  tools: Record<ToolGroup, boolean>
  /** An omp search provider id (e.g. `brave`, `exa`, `duckduckgo`) or `auto` for omp's fallback chain. */
  search: { provider: string }
  verification: { threshold: number; rubric?: string }
  instructions: { lead?: string; worker?: string }
  observer: { intervalSeconds: number }
  /** `hidden`: model refs; `hiddenProviders`: provider ids whose models stay out of pickers. */
  models: { hidden: string[]; hiddenProviders: string[] }
}

export const settingsSchema = Schema.object({
  version: Schema.const(1).default(1),
  team: Schema.object({
    mode: Schema.union(['orchestrated', 'swarm']).default('orchestrated'),
    workers: Schema.natural().max(8).default(3),
    leadModel: Schema.string(),
    workerModel: Schema.string(),
    judgeModel: Schema.string(),
    wallMinutes: Schema.number().min(1).max(240).default(30),
    maxTurns: Schema.natural().min(1).max(200).default(40),
  }).default({}),
  tools: Schema.object({
    shell: Schema.boolean().default(true),
    web: Schema.boolean().default(true),
    files: Schema.boolean().default(true),
    messaging: Schema.boolean().default(true),
  }).default({}),
  search: Schema.object({
    provider: Schema.string()
      .pattern(/^[a-z][a-z0-9-]{1,30}$/)
      .default('auto'),
  }).default({}),
  verification: Schema.object({
    threshold: Schema.number().min(0).max(1).default(0.7),
    rubric: Schema.string().max(8000),
  }).default({}),
  instructions: Schema.object({
    lead: Schema.string().max(8000),
    worker: Schema.string().max(8000),
  }).default({}),
  observer: Schema.object({ intervalSeconds: Schema.natural().min(10).max(600).default(45) }).default({}),
  models: Schema.object({
    hidden: Schema.array(Schema.string()).default([]),
    hiddenProviders: Schema.array(Schema.string()).default([]),
  }).default({}),
})

/** Validates, then keeps only known fields: the schema passes unknown keys (e.g. from older versions) through. */
function parse(input: unknown): MyrSettings {
  // Older files say `auto`/`manual`; both were lead-run teams.
  const raw = (input ?? {}) as { team?: { mode?: unknown } }
  if (raw.team && (raw.team.mode === 'auto' || raw.team.mode === 'manual'))
    input = { ...raw, team: { ...raw.team, mode: 'orchestrated' } }
  const s = settingsSchema((input ?? {}) as never) as MyrSettings
  return {
    version: 1,
    team: s.team,
    tools: s.tools,
    search: { provider: s.search.provider },
    verification: s.verification,
    instructions: s.instructions,
    observer: s.observer,
    models: { hidden: s.models.hidden, hiddenProviders: s.models.hiddenProviders },
  }
}

function atomicWrite(path: string, text: string, mode: number) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

/** `settings.json` in the Myrmidon home. */
export class SettingsStore {
  private _settings: MyrSettings
  private readonly _listeners = new Set<(s: MyrSettings) => void>()

  constructor(readonly home: string) {
    this._settings = this._read()
  }

  private get path() {
    return join(this.home, 'settings.json')
  }

  private _read(): MyrSettings {
    if (!existsSync(this.path)) return parse({})
    try {
      return parse(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (err) {
      throw new Error(`${this.path} is invalid: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  get(): MyrSettings {
    return structuredClone(this._settings)
  }

  /** Validates and replaces the settings. Throws with the validation message on bad input. */
  set(input: unknown): MyrSettings {
    const next = parse(input)
    atomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`, 0o644)
    this._settings = next
    for (const l of this._listeners) l(this.get())
    return this.get()
  }

  onChange(listener: (s: MyrSettings) => void): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }
}
