import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Schema } from '@myrmidon/core'

export const TOOL_GROUPS = {
  shell: ['shell'],
  web: ['web_search', 'web_fetch'],
  files: ['fs_write', 'fs_edit', 'fs_read', 'fs_list'],
  messaging: ['send_mail', 'post', 'append_note'],
  browser: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_screenshot',
    'browser_console',
    'browser_eval',
  ],
  // Stands for every tool of the connected MCP servers.
  mcp: ['mcp'],
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
    /** Per-round limits; 0 means no limit. */
    costUsd: number
    tokens: number
  }
  tools: Record<ToolGroup, boolean>
  /** An omp search provider id (e.g. `brave`, `exa`, `duckduckgo`) or `auto` for omp's fallback chain. */
  search: { provider: string }
  /** `reviewer`: off never reviews; auto lets the speaking agent ask (request_review); always reviews every final answer. */
  verification: { threshold: number; rubric?: string; reviewer: 'off' | 'auto' | 'always' }
  instructions: { lead?: string; worker?: string }
  observer: { intervalSeconds: number }
  /**
   * `hidden`: model refs; `hiddenProviders`: provider ids whose models stay out of pickers; `windows`: context windows
   * the person set, in tokens, by model ref.
   */
  models: { hidden: string[]; hiddenProviders: string[]; windows: Record<string, number> }
  /**
   * Per-tool rules on top of the groups above, by tool name (`mcp` for every MCP tool): `ask` needs the person's
   * approval for each call, `off` removes the tool. Tools not listed are allowed.
   */
  permissions: Record<string, 'allow' | 'ask' | 'off'>
  /** `name`: what the mascot calls the person (their computer account's name when unset); `greeting`: who writes the entry page's line. */
  profile: { name?: string; greeting: 'model' | 'rules' }
  /** How the entry page's mascot looks, and what its screen shows beside its mood. */
  mascot: {
    eyes: 'round' | 'happy' | 'tall' | 'sleepy' | 'lashes'
    look: 'neutral' | 'flower' | 'bow'
    color: 'amber' | 'ice' | 'mint' | 'pink' | 'violet' | 'white'
    screen: 'face' | 'clock' | 'name' | 'crew' | 'rotate'
  }
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
    costUsd: Schema.number().min(0).max(1000).default(0),
    tokens: Schema.natural().max(1_000_000_000).default(0),
  }).default({}),
  tools: Schema.object({
    shell: Schema.boolean().default(true),
    web: Schema.boolean().default(true),
    files: Schema.boolean().default(true),
    messaging: Schema.boolean().default(true),
    mcp: Schema.boolean().default(true),
    browser: Schema.boolean().default(true),
  }).default({}),
  search: Schema.object({
    provider: Schema.string()
      .pattern(/^[a-z][a-z0-9-]{1,30}$/)
      .default('auto'),
  }).default({}),
  verification: Schema.object({
    threshold: Schema.number().min(0).max(1).default(0.7),
    rubric: Schema.string().max(8000),
    reviewer: Schema.union(['off', 'auto', 'always']).default('auto'),
  }).default({}),
  instructions: Schema.object({
    lead: Schema.string().max(8000),
    worker: Schema.string().max(8000),
  }).default({}),
  observer: Schema.object({ intervalSeconds: Schema.natural().min(10).max(600).default(45) }).default({}),
  models: Schema.object({
    hidden: Schema.array(Schema.string()).default([]),
    hiddenProviders: Schema.array(Schema.string()).default([]),
    windows: Schema.dict(Schema.natural().min(1024).max(100_000_000)).default({}),
  }).default({}),
  permissions: Schema.dict(Schema.union(['allow', 'ask', 'off'])).default({}),
  profile: Schema.object({
    name: Schema.string().max(40),
    greeting: Schema.union(['model', 'rules']).default('model'),
  }).default({}),
  mascot: Schema.object({
    eyes: Schema.union(['round', 'happy', 'tall', 'sleepy', 'lashes']).default('round'),
    look: Schema.union(['neutral', 'flower', 'bow']).default('neutral'),
    color: Schema.union(['amber', 'ice', 'mint', 'pink', 'violet', 'white']).default('amber'),
    screen: Schema.union(['face', 'clock', 'name', 'crew', 'rotate']).default('rotate'),
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
    models: { hidden: s.models.hidden, hiddenProviders: s.models.hiddenProviders, windows: s.models.windows },
    permissions: s.permissions,
    profile: {
      ...(s.profile.name?.trim() ? { name: s.profile.name.trim() } : {}),
      greeting: s.profile.greeting,
    },
    mascot: s.mascot,
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
