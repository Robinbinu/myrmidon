import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Schema } from '@myrmidon/core'
import {
  type AccessGroup,
  DEFAULT_PRESET,
  isSetupStep,
  normalizeLevel,
  type PermissionLevel,
  type PermissionPreset,
  rulesFromToolDict,
  type SetupState,
} from '@myrmidon/protocol'
import {
  DEFAULT_COST_USD,
  MAX_CREW_NAMES,
  MAX_FALLBACKS,
  MAX_IMPORTED_THEMES,
  MAX_READ_FOLDERS,
  MAX_THEME_COLORS,
} from './config.ts'
import { ownerOnly } from './owner-only.ts'

/** Tool groups a saved specialist can be kept out of (Settings → Specialists). */
export const TOOL_GROUPS = {
  shell: ['shell', 'eval'],
  web: ['web_search', 'web_fetch'],
  files: ['fs_write', 'fs_edit', 'fs_read', 'fs_list', 'ast_grep', 'ast_edit', 'lsp', 'request_read'],
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
    /**
     * The advisor: a second model that reads each agent's latest steps as it works and steers it with a short note
     * when it sees a concrete problem (the wrong file, an ignored error, a loop). Unset: no advisor, the default.
     */
    advisorModel?: string
    /**
     * Prewalk's carry-out model: the lead of a work round plans on its own model, then hands off once to this cheaper
     * one to carry the plan out (after omp's prewalk). Unset: the lead keeps its model, the default.
     */
    carryOutModel?: string
    /**
     * Models to go on with, in order, when the lead's model fails in a way another model could get past (an outage,
     * a rate limit retries did not clear, an expired sign-in, a model taken down); `workerFallbacks` the same for
     * crewmates and swarm peers. Empty: the round pauses on the error for the person, as before.
     */
    leadFallbacks: string[]
    workerFallbacks: string[]
    wallMinutes: number
    maxTurns: number
    /** Per-round limits; 0 means no limit. */
    costUsd: number
    tokens: number
  }
  /** What sandboxed agents may read beyond their workspace, in every chat. Full access is a preset (`permissions`). */
  sandbox: {
    /**
     * Folders sandboxed agents may also read (never write) in every chat of the person's, `~` or absolute. Naming one of
     * their keys' folders (SANDBOX_SECRETS) or Myrmidon's data folder exactly is the only way to open it.
     */
    read?: string[]
    /** Everything in the person's home is readable too, but for their keys and other chats' data. */
    readHome?: boolean
  }
  /**
   * Computer use: agents may see and control the person's Mac, once the person approves it in the chat. Off until the
   * person turns it on; separate from the sandbox, and never given to rounds a channel member started. `engine`: Cua
   * Driver (one approved app at a time; the default when absent) or omp's desktop engine (scripts, approved each time).
   */
  computerUse: { enabled: boolean; engine?: 'cua' | 'omp' }
  /**
   * `hideSecrets`: keys, tokens and passwords reach model providers as placeholders (provider-secrets.ts). On unless
   * the person turns it off: Myrmidon keeps their data on their machine, and a key read in a .env file should not leave
   * it by accident, while the model still sees that a secret is there and Myrmidon writes the value back into the
   * agent's own files. Off is for when the model must read the value itself (a key that looks malformed).
   */
  privacy: { hideSecrets: boolean }
  /** An omp search provider id (e.g. `brave`, `exa`, `duckduckgo`) or `auto` for omp's fallback chain. */
  search: { provider: string }
  /**
   * The model agents make pictures with (generate_image), as `provider/id`. Unset: the first image model a provider the
   * person set up can run, in omp's order of preference.
   */
  images: { model?: string }
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
   * The global level of the permission model (see protocol's permissions.ts): the preset every chat starts from
   * (Full access runs without the OS sandbox), allow / ask / deny rules, and which tool groups the lead and crew get.
   */
  permissions: GlobalPermissions
  /** `name`: what the mascot calls the person (their computer account's name when unset); `greeting`: who writes the entry page's line. */
  /** `titles`: name chats from what they are about (`model`), or keep their first message as the name. */
  profile: { name?: string; greeting: 'model' | 'rules'; titles: 'model' | 'first-message' }
  /** How the entry page's mascot looks, and what its screen shows beside its mood. */
  mascot: {
    eyes: 'round' | 'happy' | 'tall' | 'sleepy' | 'lashes'
    look: 'neutral' | 'flower' | 'bow'
    color: 'amber' | 'ice' | 'mint' | 'pink' | 'violet' | 'white'
    screen: 'face' | 'clock' | 'name' | 'crew' | 'rotate'
    /** How often it plays a trick while left alone. */
    idle: 'off' | 'rare' | 'normal' | 'often'
    /** The shows that may take its whole screen. */
    shows: { pacman: boolean; life: boolean; confetti: boolean; boot: boolean }
    /** `calm`: no bouncing, dizzy spells or knocked-over crew, and only quiet eye tricks. */
    temper: 'calm' | 'playful'
    /** The crew cursors around it: whether they show, how many, whose names they wear, and how bold they are. */
    crew: {
      show: boolean
      count: number
      names: 'minions' | 'specialists' | 'custom'
      custom: string[]
      boldness: 'shy' | 'curious' | 'bold'
    }
    /** Its dot screen: the dots' shape, the unlit grid, the glow, the eyes' colour (its own or the theme's), the size. */
    display: {
      dots: 'led' | 'round' | 'square'
      grid: 'faint' | 'tinted' | 'off'
      glow: 'off' | 'soft' | 'strong'
      eyeColor: 'own' | 'theme'
      size: 'small' | 'medium' | 'large'
    }
    /** Soft blips made in the page (Web Audio) when it reacts and while the person types; off until turned on. */
    sounds: { enabled: boolean; reactions: boolean; typing: boolean; volume: 'quiet' | 'normal' | 'loud' }
  }
  /**
   * VS Code themes the person imported (Settings → Appearance), cut down to the hex colours Myrmidon reads. Which theme
   * is in use is kept by each browser, like light and dark.
   */
  appearance: { imported: ImportedTheme[] }
  /**
   * Voice calls: the call model (the lead's when unset), and how a call hears and speaks. `pipeline` (the default):
   * speech to text, the call model, text to speech, each on this machine (Phonon-2, Kitten TTS), omp's cloud models,
   * a voice provider set up in Settings → Models & providers, or the person's own OpenAI-compatible service;
   * `realtime`: one speech-to-speech model does all three. Keys live in the credential vault with the model providers'
   * (see voice/providers.ts), never here: this file is readable by others.
   */
  voice: {
    /** Voice calls are off until the person turns them on: nothing is downloaded or started before. */
    enabled: boolean
    callModel?: string
    mode: 'pipeline' | 'realtime'
    /**
     * `provider`: `phonon`, `omp`, a voice provider's id (`deepgram`…), or `endpoint:<id>` for one of `endpoints`;
     * `model`: the provider's model, its default when unset.
     */
    stt: { provider: string; model?: string }
    tts: {
      provider: string
      model?: string
      /** A cloud provider's voice id (Kitten's is `voice`); the provider's default when unset. */
      voiceId?: string
      kittenModel: 'nano' | 'micro' | 'mini'
      voice: string
      speed: number
    }
    /** The realtime model a `realtime` call uses: its provider (`openai`, `gemini`…), model and voice. */
    realtime?: { provider?: string; model?: string; voice?: string }
    /** Regions for the providers that need one (Azure, AWS, Speechmatics), by provider id. Not secret. */
    regions?: Record<string, string>
    /** The person's own speech services with the OpenAI audio API; each one's key is in the vault. */
    endpoints?: VoiceEndpoint[]
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
  /**
   * The crew last picked in the message box (lead, crewmates, thinking, how helpers join), so a new chat starts with it
   * in every browser, the desktop app included, whose page loses its storage with each new port. Absent until the
   * first pick; not the default crew above, which channels, calls and schedules use.
   */
  composer?: ComposerChoice
}

/** The message box's crew as the page keeps it (its TeamConfig). */
export interface ComposerChoice {
  mode: 'orchestrated' | 'swarm'
  leadModel: string
  judgeModel: string
  roster: { role: string; model: string; specialist?: string }[]
  extraWorkers: number
  thinking?: 'low' | 'medium' | 'high'
  helpers?: 'always'
}

/** An imported VS Code theme as saved: only `#hex` colours, by VS Code key and by syntax role. */
export interface ImportedTheme {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
  syntax: Record<string, string>
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const THEME_KEY = /^[A-Za-z][A-Za-z.]{0,59}$/
const SYNTAX_ROLES = new Set(['comment', 'string', 'keyword', 'function', 'number'])

/** An OpenAI-compatible speech service the person added (a local whisper, Kokoro or Piper server, Groq…). */
export interface VoiceEndpoint {
  /** How it is named in pickers (`endpoint:<id>`); lowercase letters, digits and dashes. */
  id: string
  /** Up to the API version, e.g. `http://localhost:8880/v1`. */
  baseUrl: string
  /** It takes no key. */
  keyless?: boolean
}

export const VOICE_ENDPOINT_ID = /^[a-z][a-z0-9-]{0,30}$/
/** What a voice provider choice may be: a fixed engine, a registry id, or one of the person's endpoints. */
const VOICE_PROVIDER = /^([a-z][a-z0-9-]{1,30}|endpoint:[a-z][a-z0-9-]{0,30})$/

export const settingsSchema = Schema.object({
  version: Schema.const(1).default(1),
  team: Schema.object({
    mode: Schema.union(['orchestrated', 'swarm']).default('orchestrated'),
    workers: Schema.natural().max(8).default(3),
    leadModel: Schema.string(),
    workerModel: Schema.string(),
    judgeModel: Schema.string(),
    advisorModel: Schema.string().max(200),
    carryOutModel: Schema.string().max(200),
    leadFallbacks: Schema.array(Schema.string().max(200)).max(MAX_FALLBACKS).default([]),
    workerFallbacks: Schema.array(Schema.string().max(200)).max(MAX_FALLBACKS).default([]),
    wallMinutes: Schema.number().min(1).max(240).default(30),
    maxTurns: Schema.natural().min(1).max(200).default(40),
    costUsd: Schema.number().min(0).max(1000).default(DEFAULT_COST_USD),
    tokens: Schema.natural().max(1_000_000_000).default(0),
  }).default({}),
  sandbox: Schema.object({
    read: Schema.array(
      Schema.string()
        .pattern(/^(~$|~\/|\/)/)
        .max(1000),
    ).max(MAX_READ_FOLDERS),
    readHome: Schema.boolean(),
  }).default({}),
  computerUse: Schema.object({
    enabled: Schema.boolean().default(false),
    engine: Schema.union(['cua', 'omp']).default('cua'),
  }).default({}),
  privacy: Schema.object({ hideSecrets: Schema.boolean().default(true) }).default({}),
  search: Schema.object({
    provider: Schema.string()
      .pattern(/^[a-z][a-z0-9-]{1,30}$/)
      .default('auto'),
  }).default({}),
  images: Schema.object({ model: Schema.string().max(200) }).default({}),
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
  // Checked by `globalPermissions`, which also reads the shape from before the permission model.
  permissions: Schema.any(),
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
    idle: Schema.union(['off', 'rare', 'normal', 'often']).default('normal'),
    shows: Schema.object({
      pacman: Schema.boolean().default(true),
      life: Schema.boolean().default(true),
      confetti: Schema.boolean().default(true),
      boot: Schema.boolean().default(true),
    }).default({}),
    temper: Schema.union(['calm', 'playful']).default('playful'),
    crew: Schema.object({
      show: Schema.boolean().default(true),
      count: Schema.natural().min(1).max(6).default(3),
      names: Schema.union(['minions', 'specialists', 'custom']).default('minions'),
      custom: Schema.array(Schema.string().max(16)).max(MAX_CREW_NAMES).default([]),
      boldness: Schema.union(['shy', 'curious', 'bold']).default('curious'),
    }).default({}),
    display: Schema.object({
      dots: Schema.union(['led', 'round', 'square']).default('led'),
      grid: Schema.union(['faint', 'tinted', 'off']).default('faint'),
      glow: Schema.union(['off', 'soft', 'strong']).default('soft'),
      eyeColor: Schema.union(['own', 'theme']).default('own'),
      size: Schema.union(['small', 'medium', 'large']).default('medium'),
    }).default({}),
    sounds: Schema.object({
      enabled: Schema.boolean().default(false),
      reactions: Schema.boolean().default(true),
      typing: Schema.boolean().default(true),
      volume: Schema.union(['quiet', 'normal', 'loud']).default('quiet'),
    }).default({}),
  }).default({}),
  appearance: Schema.object({
    imported: Schema.array(
      Schema.object({
        id: Schema.string()
          .pattern(/^imported-[a-z0-9]{1,16}$/)
          .required(),
        name: Schema.string().max(60).required(),
        type: Schema.union(['dark', 'light']).required(),
        colors: Schema.dict(Schema.string().pattern(HEX_COLOR)).default({}),
        syntax: Schema.dict(Schema.string().pattern(HEX_COLOR)).default({}),
      }),
    )
      .max(MAX_IMPORTED_THEMES)
      .default([]),
  }).default({}),
  voice: Schema.object({
    enabled: Schema.boolean().default(false),
    callModel: Schema.string(),
    mode: Schema.union(['pipeline', 'realtime']).default('pipeline'),
    stt: Schema.object({
      provider: Schema.string().pattern(VOICE_PROVIDER).default('phonon'),
      model: Schema.string().max(200),
    }).default({}),
    tts: Schema.object({
      provider: Schema.string().pattern(VOICE_PROVIDER).default('kitten'),
      model: Schema.string().max(200),
      voiceId: Schema.string().max(200),
      kittenModel: Schema.union(['nano', 'micro', 'mini']).default('nano'),
      voice: Schema.string().max(60).default('Leo'),
      speed: Schema.number().min(0.5).max(2).default(1),
    }).default({}),
    realtime: Schema.object({
      provider: Schema.string().pattern(VOICE_PROVIDER),
      model: Schema.string().max(200),
      voice: Schema.string().max(200),
    }).default({}),
    regions: Schema.dict(Schema.string().pattern(/^[a-z0-9-]{2,40}$/)).default({}),
    endpoints: Schema.array(
      Schema.object({
        id: Schema.string().pattern(VOICE_ENDPOINT_ID).required(),
        baseUrl: Schema.string()
          .pattern(/^https?:\/\//)
          .max(500)
          .required(),
        keyless: Schema.boolean(),
      }),
    )
      .max(20)
      .default([]),
    sensitivity: Schema.union(['low', 'normal', 'high']).default('normal'),
    phone: Schema.boolean().default(false),
  }).default({}),
  setup: Schema.object({
    finishedAt: Schema.string().max(40),
    dismissedAt: Schema.string().max(40),
    steps: Schema.dict(Schema.union(['done', 'later'])).default({}),
  }),
  composer: Schema.union([
    Schema.const(undefined as never),
    Schema.object({
      mode: Schema.union(['orchestrated', 'swarm']).default('orchestrated'),
      leadModel: Schema.string().max(200).required(),
      judgeModel: Schema.string().max(200).required(),
      roster: Schema.array(
        Schema.object({
          role: Schema.string().max(40).required(),
          model: Schema.string().max(200).required(),
          specialist: Schema.string().max(100),
        }),
      )
        .max(8)
        .default([]),
      extraWorkers: Schema.natural().max(8).default(0),
      thinking: Schema.union(['low', 'medium', 'high']),
      helpers: Schema.const('always'),
    }),
  ]),
})

export type GlobalPermissions = PermissionLevel & { preset: PermissionPreset }

/**
 * The global level from saved or sent settings. The shape from before the permission model is read too, and its old
 * switches are still understood when sent: per-tool rules (`{ shell: 'ask', mcp: 'allow', web_fetch: 'off' }`) become
 * rules (`off` a deny); `sandbox.enabled: false` (turning the sandbox off, which took a confirmation) is Full access
 * and `true` takes Full access back; a group switched off in `tools` is off for the lead and crew alike.
 */
function globalPermissions(input: unknown): GlobalPermissions {
  const raw = (input ?? {}) as {
    permissions?: unknown
    sandbox?: { enabled?: unknown }
    tools?: Record<string, unknown>
  }
  const given = raw.permissions as { rules?: unknown } | undefined
  const legacy = !given || typeof given !== 'object' || !Array.isArray(given.rules)
  const level = legacy
    ? normalizeLevel({ rules: rulesFromToolDict((given ?? {}) as Record<string, unknown>) })
    : normalizeLevel(given)
  let preset = level.preset ?? DEFAULT_PRESET
  if (raw.sandbox?.enabled === false) preset = 'full'
  else if (raw.sandbox?.enabled === true && preset === 'full') preset = DEFAULT_PRESET
  const access = { lead: { ...level.access?.lead }, crew: { ...level.access?.crew } }
  for (const group of Object.keys(TOOL_GROUPS) as AccessGroup[]) {
    const on = raw.tools?.[group]
    if (typeof on !== 'boolean') continue
    for (const role of [access.lead, access.crew])
      if (on) delete role[group]
      else role[group] = false
  }
  const kept = {
    ...(Object.keys(access.lead).length ? { lead: access.lead } : {}),
    ...(Object.keys(access.crew).length ? { crew: access.crew } : {}),
  }
  return { preset, rules: level.rules, ...(kept.lead || kept.crew ? { access: kept } : {}) }
}

/**
 * Voice settings from before voice providers: one OpenAI-compatible address per direction (`provider: 'endpoint'`,
 * `baseUrl`, `model`, `endpointVoice`) becomes one of the person's endpoints, named for what it was for
 * (`endpoint` when both used the same address, else `endpoint-stt` / `endpoint-tts`; their keys move to the vault
 * under those names, see VOICE_LEGACY_KEYS), and the choice names it. Other choices (Phonon-2, Kitten, omp) are kept.
 */
function legacyVoice(voice: unknown): unknown {
  if (!voice || typeof voice !== 'object') return voice
  const v = voice as Record<string, unknown> & { endpoints?: unknown }
  const stt = (v.stt ?? {}) as Record<string, unknown>
  const tts = (v.tts ?? {}) as Record<string, unknown>
  const url = (x: unknown) =>
    typeof x === 'string' && /^https?:\/\//.test(x) ? x.trim().replace(/\/+$/, '') : ''
  const sttUrl = url(stt.baseUrl)
  const ttsUrl = url(tts.baseUrl)
  const legacy =
    stt.provider === 'endpoint' || tts.provider === 'endpoint' || 'baseUrl' in stt || 'baseUrl' in tts
  if (!legacy) return voice
  const shared = sttUrl && sttUrl === ttsUrl
  const sttId = shared ? 'endpoint' : 'endpoint-stt'
  const ttsId = shared ? 'endpoint' : 'endpoint-tts'
  const endpoints = Array.isArray(v.endpoints) ? [...v.endpoints] : []
  const add = (id: string, baseUrl: string) => {
    if (baseUrl && !endpoints.some((e) => (e as { id?: unknown }).id === id)) endpoints.push({ id, baseUrl })
  }
  add(sttId, sttUrl)
  add(ttsId, ttsUrl)
  const { baseUrl: _sb, model: sttModel, ...sttRest } = stt
  const { baseUrl: _tb, model: ttsModel, endpointVoice, ...ttsRest } = tts
  return {
    ...v,
    endpoints,
    stt:
      stt.provider === 'endpoint'
        ? { ...sttRest, provider: `endpoint:${sttId}`, ...(sttModel ? { model: sttModel } : {}) }
        : sttRest,
    tts:
      tts.provider === 'endpoint'
        ? {
            ...ttsRest,
            provider: `endpoint:${ttsId}`,
            ...(ttsModel ? { model: ttsModel } : {}),
            ...(endpointVoice ? { voiceId: endpointVoice } : {}),
          }
        : ttsRest,
  }
}

/** Where each key of the old `voice/secrets.json` goes in the vault: the endpoint legacyVoice made for it. */
export const VOICE_LEGACY_KEYS = {
  shared: 'endpoint',
  stt: 'endpoint-stt',
  tts: 'endpoint-tts',
} as const

/** Validates, then keeps only known fields: the schema passes unknown keys (e.g. from older versions) through. */
function parse(input: unknown): MyrSettings {
  // Older files say `auto`/`manual`; both were lead-run teams.
  const raw = (input ?? {}) as { team?: { mode?: unknown } }
  if (raw.team && (raw.team.mode === 'auto' || raw.team.mode === 'manual'))
    input = { ...raw, team: { ...raw.team, mode: 'orchestrated' } }
  const voice = (input as { voice?: unknown } | undefined)?.voice
  if (voice !== undefined) input = { ...(input as object), voice: legacyVoice(voice) }
  const s = settingsSchema((input ?? {}) as never) as MyrSettings
  // The schema fills in an absent setup; absent must stay absent, so the first read can still decide it.
  const setup = (input as { setup?: unknown } | undefined)?.setup !== undefined ? s.setup : undefined
  const composer = s.composer
  return {
    version: 1,
    team: {
      ...s.team,
      leadFallbacks: [...new Set(s.team.leadFallbacks.filter(Boolean))],
      workerFallbacks: [...new Set(s.team.workerFallbacks.filter(Boolean))],
    },
    sandbox: {
      ...(s.sandbox.read?.length ? { read: [...new Set(s.sandbox.read.map((f) => f.trim()))] } : {}),
      ...(s.sandbox.readHome ? { readHome: true } : {}),
    },
    computerUse: {
      enabled: s.computerUse.enabled,
      ...(s.computerUse.engine === 'omp' ? { engine: 'omp' as const } : {}),
    },
    privacy: { hideSecrets: s.privacy.hideSecrets },
    search: { provider: s.search.provider },
    images: s.images.model?.trim() ? { model: s.images.model.trim() } : {},
    verification: s.verification,
    instructions: s.instructions,
    observer: s.observer,
    models: { hidden: s.models.hidden, hiddenProviders: s.models.hiddenProviders, windows: s.models.windows },
    permissions: globalPermissions(input),
    profile: {
      ...(s.profile.name?.trim() ? { name: s.profile.name.trim() } : {}),
      greeting: s.profile.greeting,
      titles: s.profile.titles,
    },
    mascot: {
      ...s.mascot,
      crew: {
        ...s.mascot.crew,
        custom: [...new Set(s.mascot.crew.custom.map((n) => n.trim()).filter(Boolean))],
      },
    },
    appearance: {
      imported: [...new Map(s.appearance.imported.map((t) => [t.id, t])).values()].map((t) => ({
        id: t.id,
        name: t.name.trim(),
        type: t.type,
        colors: Object.fromEntries(
          Object.entries(t.colors)
            .filter(([k]) => THEME_KEY.test(k))
            .slice(0, MAX_THEME_COLORS),
        ),
        syntax: Object.fromEntries(Object.entries(t.syntax).filter(([k]) => SYNTAX_ROLES.has(k))),
      })),
    },
    voice: voiceSettings(s.voice),
    ...(setup
      ? {
          setup: {
            ...(setup.finishedAt ? { finishedAt: setup.finishedAt } : {}),
            ...(setup.dismissedAt ? { dismissedAt: setup.dismissedAt } : {}),
            steps: Object.fromEntries(Object.entries(setup.steps).filter(([step]) => isSetupStep(step))),
          },
        }
      : {}),
    ...(composer
      ? {
          composer: {
            mode: composer.mode,
            leadModel: composer.leadModel,
            judgeModel: composer.judgeModel,
            roster: composer.roster.map((r) => ({
              role: r.role,
              model: r.model,
              ...(r.specialist ? { specialist: r.specialist } : {}),
            })),
            extraWorkers: composer.extraWorkers,
            ...(composer.thinking ? { thinking: composer.thinking } : {}),
            ...(composer.helpers ? { helpers: composer.helpers } : {}),
          },
        }
      : {}),
  }
}

/** The voice settings with only what is set: no empty realtime choice, regions or endpoints. */
function voiceSettings(v: MyrSettings['voice']): MyrSettings['voice'] {
  const realtime = Object.fromEntries(
    Object.entries(v.realtime ?? {}).filter(([, x]) => typeof x === 'string' && x.trim()),
  )
  const endpoints = [
    ...new Map(
      (v.endpoints ?? []).map((e) => [
        e.id,
        { id: e.id, baseUrl: e.baseUrl.trim().replace(/\/+$/, ''), ...(e.keyless ? { keyless: true } : {}) },
      ]),
    ).values(),
  ]
  const regions = Object.fromEntries(Object.entries(v.regions ?? {}).filter(([, r]) => r))
  const set = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== '')) as T
  return {
    enabled: v.enabled,
    ...(v.callModel ? { callModel: v.callModel } : {}),
    mode: v.mode,
    stt: set({ provider: v.stt.provider, model: v.stt.model }),
    tts: set({
      provider: v.tts.provider,
      model: v.tts.model,
      voiceId: v.tts.voiceId,
      kittenModel: v.tts.kittenModel,
      voice: v.tts.voice,
      speed: v.tts.speed,
    }),
    ...(Object.keys(realtime).length ? { realtime } : {}),
    ...(Object.keys(regions).length ? { regions } : {}),
    ...(endpoints.length ? { endpoints } : {}),
    sensitivity: v.sensitivity,
    phone: v.phone,
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
  // A fallback is not a default the person is told about: the chain just goes on without it.
  // Nor is the advisor, which is optional help: the crew just works unadvised.
  if (next.team.advisorModel === ref) delete next.team.advisorModel
  // Nor is the carry-out model: the lead just keeps its own.
  if (next.team.carryOutModel === ref) delete next.team.carryOutModel
  next.team.leadFallbacks = next.team.leadFallbacks.filter((r) => r !== ref)
  next.team.workerFallbacks = next.team.workerFallbacks.filter((r) => r !== ref)
  if (next.voice.callModel === ref) {
    delete next.voice.callModel
    cleared.push('call')
  }
  const hidden = next.models.hidden.filter((r) => r !== ref)
  next.models.hidden = hide ? [...hidden, ref] : hidden
  if (!hide) delete next.models.windows[ref]
  return { settings: next, cleared }
}

/** Writes a file whole or not at all: a crash leaves the old one, never half the new. */
export function atomicWrite(path: string, text: string, mode: number) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  // A file only its owner may read (cookies, say) needs its access list set on Windows too.
  if (mode & 0o077) chmodSync(tmp, mode)
  else ownerOnly(tmp, mode)
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
