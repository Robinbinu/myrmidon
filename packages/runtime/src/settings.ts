import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Schema } from '@myrmidon/core'
import { isSetupStep, type SetupState } from '@myrmidon/protocol'
import { DEFAULT_COST_USD, MAX_READ_FOLDERS } from './config.ts'

export const TOOL_GROUPS = {
  shell: ['shell'],
  web: ['web_search', 'web_fetch'],
  files: ['fs_write', 'fs_edit', 'fs_read', 'fs_list', 'request_read'],
  messaging: ['message', 'create_group', 'update_group', 'append_note'],
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
  /**
   * `enabled: false` is full access for every chat of the person's: commands run without the OS sandbox, file tools
   * reach any path and the web any address (approvals still apply). Read-only projects and rounds a channel member
   * started stay sandboxed whatever this says; a project set to full access has it with the sandbox on.
   */
  sandbox: {
    enabled: boolean
    /**
     * Folders sandboxed agents may also read (never write) in every chat of the person's, `~` or absolute. Naming one of
     * their keys' folders (SANDBOX_SECRETS) or Myrmidon's data folder exactly is the only way to open it.
     */
    read?: string[]
    /** Everything in the person's home is readable too, but for their keys and other chats' data. */
    readHome?: boolean
  }
  /**
   * Computer use: agents may see and control the person's Mac (through Cua Driver), one app at a time once the person
   * approves it in the chat. Off until the person turns it on; separate from the sandbox, and never given to rounds a
   * channel member started.
   */
  computerUse: { enabled: boolean }
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
  /** `titles`: name chats from what they are about (`model`), or keep their first message as the name. */
  profile: { name?: string; greeting: 'model' | 'rules'; titles: 'model' | 'first-message' }
  /** How the entry page's mascot looks, and what its screen shows beside its mood. */
  mascot: {
    eyes: 'round' | 'happy' | 'tall' | 'sleepy' | 'lashes'
    look: 'neutral' | 'flower' | 'bow'
    color: 'amber' | 'ice' | 'mint' | 'pink' | 'violet' | 'white'
    screen: 'face' | 'clock' | 'name' | 'crew' | 'rotate'
  }
  /**
   * Voice calls: the call model (the lead's when unset), speech to text and text to speech (on this machine by
   * default, omp's cloud models, or any OpenAI-compatible endpoint, whose keys live in `voice/secrets.json`), and how
   * loud speech must be to count.
   */
  voice: {
    /** Voice calls are off until the person turns them on: nothing is downloaded or started before. */
    enabled: boolean
    callModel?: string
    stt: { provider: 'phonon' | 'omp' | 'endpoint'; baseUrl?: string; model?: string }
    tts: {
      provider: 'kitten' | 'omp' | 'endpoint'
      kittenModel: 'nano' | 'micro' | 'mini'
      voice: string
      speed: number
      baseUrl?: string
      model?: string
      endpointVoice?: string
    }
    sensitivity: 'low' | 'normal' | 'high'
    /**
     * Phone calls on the SMS channel's Twilio number: answered (its voice webhook is pointed at this gateway) and
     * made to the people SMS lets in. Off until the person turns it on, so the number's own voice setup is left alone.
     */
    phone: boolean
  }
  /**
   * The first-run setup assistant. Absent until it is first asked about: an install from before it existed is then
   * counted as set up when it has a chat or a model (see `setup.ts`).
   */
  setup?: SetupState
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
    costUsd: Schema.number().min(0).max(1000).default(DEFAULT_COST_USD),
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
  sandbox: Schema.object({
    enabled: Schema.boolean().default(true),
    read: Schema.array(
      Schema.string()
        .pattern(/^(~$|~\/|\/)/)
        .max(1000),
    ).max(MAX_READ_FOLDERS),
    readHome: Schema.boolean(),
  }).default({}),
  computerUse: Schema.object({ enabled: Schema.boolean().default(false) }).default({}),
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
    titles: Schema.union(['model', 'first-message']).default('model'),
  }).default({}),
  mascot: Schema.object({
    eyes: Schema.union(['round', 'happy', 'tall', 'sleepy', 'lashes']).default('round'),
    look: Schema.union(['neutral', 'flower', 'bow']).default('neutral'),
    color: Schema.union(['amber', 'ice', 'mint', 'pink', 'violet', 'white']).default('amber'),
    screen: Schema.union(['face', 'clock', 'name', 'crew', 'rotate']).default('rotate'),
  }).default({}),
  voice: Schema.object({
    enabled: Schema.boolean().default(false),
    callModel: Schema.string(),
    stt: Schema.object({
      provider: Schema.union(['phonon', 'omp', 'endpoint']).default('phonon'),
      baseUrl: Schema.string().max(500),
      model: Schema.string().max(200),
    }).default({}),
    tts: Schema.object({
      provider: Schema.union(['kitten', 'omp', 'endpoint']).default('kitten'),
      kittenModel: Schema.union(['nano', 'micro', 'mini']).default('nano'),
      voice: Schema.string().max(60).default('Leo'),
      speed: Schema.number().min(0.5).max(2).default(1),
      baseUrl: Schema.string().max(500),
      model: Schema.string().max(200),
      endpointVoice: Schema.string().max(60),
    }).default({}),
    sensitivity: Schema.union(['low', 'normal', 'high']).default('normal'),
    phone: Schema.boolean().default(false),
  }).default({}),
  setup: Schema.object({
    finishedAt: Schema.string().max(40),
    dismissedAt: Schema.string().max(40),
    steps: Schema.dict(Schema.union(['done', 'later'])).default({}),
  }),
})

/** Validates, then keeps only known fields: the schema passes unknown keys (e.g. from older versions) through. */
function parse(input: unknown): MyrSettings {
  // Older files say `auto`/`manual`; both were lead-run teams.
  const raw = (input ?? {}) as { team?: { mode?: unknown } }
  if (raw.team && (raw.team.mode === 'auto' || raw.team.mode === 'manual'))
    input = { ...raw, team: { ...raw.team, mode: 'orchestrated' } }
  const s = settingsSchema((input ?? {}) as never) as MyrSettings
  // The schema fills in an absent setup; absent must stay absent, so the first read can still decide it.
  const setup = (input as { setup?: unknown } | undefined)?.setup !== undefined ? s.setup : undefined
  return {
    version: 1,
    team: s.team,
    tools: s.tools,
    sandbox: {
      enabled: s.sandbox.enabled,
      ...(s.sandbox.read?.length ? { read: [...new Set(s.sandbox.read.map((f) => f.trim()))] } : {}),
      ...(s.sandbox.readHome ? { readHome: true } : {}),
    },
    computerUse: { enabled: s.computerUse.enabled },
    search: { provider: s.search.provider },
    verification: s.verification,
    instructions: s.instructions,
    observer: s.observer,
    models: { hidden: s.models.hidden, hiddenProviders: s.models.hiddenProviders, windows: s.models.windows },
    permissions: s.permissions,
    profile: {
      ...(s.profile.name?.trim() ? { name: s.profile.name.trim() } : {}),
      greeting: s.profile.greeting,
      titles: s.profile.titles,
    },
    mascot: s.mascot,
    voice: {
      enabled: s.voice.enabled,
      ...(s.voice.callModel ? { callModel: s.voice.callModel } : {}),
      stt: s.voice.stt,
      tts: s.voice.tts,
      sensitivity: s.voice.sensitivity,
      phone: s.voice.phone,
    },
    ...(setup
      ? {
          setup: {
            ...(setup.finishedAt ? { finishedAt: setup.finishedAt } : {}),
            ...(setup.dismissedAt ? { dismissedAt: setup.dismissedAt } : {}),
            steps: Object.fromEntries(Object.entries(setup.steps).filter(([step]) => isSetupStep(step))),
          },
        }
      : {}),
  }
}

/** A default that can name a model: the lead's, the crewmates', the reviewer's, the call assistant's, or chat naming's. */
export type ModelDefault = 'lead' | 'crewmates' | 'reviewer' | 'call' | 'titles'

/**
 * The settings once a model is removed: no default names it any more, so each falls back as an unset one does (the
 * crewmates, reviewer and call assistant to the lead, the lead to the default model). It is hidden from pickers when it
 * stays listed (`hide`), or forgotten with its context window when it was deleted. Says which defaults it was.
 */
export function withoutModel(
  s: MyrSettings,
  ref: string,
  hide: boolean,
): { settings: MyrSettings; cleared: ModelDefault[] } {
  const next = structuredClone(s)
  const cleared: ModelDefault[] = []
  const roles = [
    ['leadModel', 'lead'],
    ['workerModel', 'crewmates'],
    ['judgeModel', 'reviewer'],
  ] as const
  for (const [key, role] of roles)
    if (next.team[key] === ref) {
      delete next.team[key]
      cleared.push(role)
    }
  if (next.voice.callModel === ref) {
    delete next.voice.callModel
    cleared.push('call')
  }
  const hidden = next.models.hidden.filter((r) => r !== ref)
  next.models.hidden = hide ? [...hidden, ref] : hidden
  if (!hide) delete next.models.windows[ref]
  return { settings: next, cleared }
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
