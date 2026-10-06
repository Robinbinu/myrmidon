import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Schema } from '@myrmidon/core'

/** API wire formats a user-added provider may speak (all supported by pi-ai). */
export const CUSTOM_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'ollama-chat',
] as const
export type CustomApi = (typeof CUSTOM_APIS)[number]

export interface CustomModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
}

export interface ProviderConfig {
  name: string
  api: CustomApi
  baseUrl: string
  /** `none` for local servers that take no key. */
  auth: 'key' | 'none'
  models: CustomModel[]
}

export const TOOL_GROUPS = {
  shell: ['shell'],
  web: ['web_search', 'web_fetch'],
  files: ['fs_write', 'fs_read', 'fs_list'],
  messaging: ['send_mail', 'post', 'append_note'],
} as const
export type ToolGroup = keyof typeof TOOL_GROUPS

export interface MyrSettings {
  version: 1
  team: {
    mode: 'auto' | 'manual'
    workers: number
    leadModel?: string
    workerModel?: string
    judgeModel?: string
    wallMinutes: number
    maxTurns: number
  }
  tools: Record<ToolGroup, boolean>
  verification: { threshold: number; rubric?: string }
  instructions: { lead?: string; worker?: string }
  observer: { intervalSeconds: number }
  models: { hidden: string[]; providers: ProviderConfig[] }
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

const providerSchema = Schema.object({
  name: Schema.string().pattern(NAME).required(),
  api: Schema.union([...CUSTOM_APIS]).required(),
  baseUrl: Schema.string()
    .pattern(/^https?:\/\/\S+$/)
    .required(),
  auth: Schema.union(['key', 'none']).default('key'),
  models: Schema.array(
    Schema.object({
      id: Schema.string().min(1).max(200).required(),
      name: Schema.string().max(200),
      contextWindow: Schema.natural(),
      maxTokens: Schema.natural(),
      reasoning: Schema.boolean(),
    }),
  ).default([]),
})

export const settingsSchema = Schema.object({
  version: Schema.const(1).default(1),
  team: Schema.object({
    mode: Schema.union(['auto', 'manual']).default('auto'),
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
    providers: Schema.array(providerSchema).default([]),
  }).default({}),
})

function atomicWrite(path: string, text: string, mode: number) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

/**
 * Settings (`settings.json`) and credentials (`credentials.json`, mode 0600) in the Myrmidon home.
 * Credentials are write-only from the API's point of view: callers learn which providers have a key, never the key.
 */
export class SettingsStore {
  private _settings: MyrSettings
  private _keys: Record<string, string>
  private readonly _listeners = new Set<(s: MyrSettings) => void>()

  constructor(readonly home: string) {
    this._settings = this._readSettings()
    this._keys = this._readKeys()
  }

  private get settingsPath() {
    return join(this.home, 'settings.json')
  }

  private get keysPath() {
    return join(this.home, 'credentials.json')
  }

  private _readSettings(): MyrSettings {
    if (!existsSync(this.settingsPath)) return settingsSchema({}) as MyrSettings
    try {
      return settingsSchema(JSON.parse(readFileSync(this.settingsPath, 'utf8'))) as MyrSettings
    } catch (err) {
      throw new Error(`${this.settingsPath} is invalid: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private _readKeys(): Record<string, string> {
    if (!existsSync(this.keysPath)) return {}
    const parsed = JSON.parse(readFileSync(this.keysPath, 'utf8')) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  }

  get(): MyrSettings {
    return structuredClone(this._settings)
  }

  /** Validates and replaces the settings. Throws with the validation message on bad input. */
  set(input: unknown): MyrSettings {
    const next = settingsSchema(input as never) as MyrSettings
    const names = next.models.providers.map((p) => p.name)
    if (new Set(names).size !== names.length) throw new Error('provider names must be unique')
    atomicWrite(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`, 0o644)
    this._settings = next
    for (const l of this._listeners) l(this.get())
    return this.get()
  }

  onChange(listener: (s: MyrSettings) => void): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  apiKey(provider: string): string | undefined {
    return this._keys[provider]
  }

  keys(): string[] {
    return Object.values(this._keys)
  }

  configuredProviders(): string[] {
    return Object.keys(this._keys).sort()
  }

  setApiKey(provider: string, key: string | null) {
    if (!NAME.test(provider)) throw new Error('invalid provider name')
    if (key !== null && (key.trim().length < 8 || key.length > 4096))
      throw new Error('that does not look like an API key')
    const next = { ...this._keys }
    if (key === null) delete next[provider]
    else next[provider] = key.trim()
    atomicWrite(this.keysPath, `${JSON.stringify(next, null, 2)}\n`, 0o600)
    this._keys = next
    for (const l of this._listeners) l(this.get())
  }
}
