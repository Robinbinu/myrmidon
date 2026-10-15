import {
  SETUP_STEPS,
  type SetupHave,
  type SetupMark,
  type SetupSkip,
  type SetupState,
  type SetupStep,
} from '@myrmidon/protocol'
import { SETUP_ENV_KEYS, SETUP_LEAD_MIN_WINDOW, SETUP_LOCAL_SERVERS, SETUP_PROBE_MS } from './config.ts'
import type { ProviderInfo } from './omp/runtime.ts'
import type { MyrSettings } from './settings.ts'

/** A model server setup looks for on this computer: its OpenAI-compatible address and the provider name it gets. */
export interface LocalServer {
  readonly id: string
  readonly baseUrl: string
  readonly provider: string
}

/** What the Connect models step offers before asking for anything. */
export interface SetupDetection {
  /** Providers whose models can be called now, however they were connected. */
  readonly ready: { id: string; models: number }[]
  /** Provider keys in Myrmidon's environment: their names only, never their values. */
  readonly env: { provider: string; variable: string; ready: boolean }[]
  /** Model servers answering on this computer, the models they serve, and whether one is added already. */
  readonly local: { id: string; baseUrl: string; provider: string; models: string[]; added: boolean }[]
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/** The models an OpenAI-compatible server lists, or undefined when it does not answer in time. */
async function listModels(baseUrl: string, timeoutMs: number): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${trimSlash(baseUrl)}/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { data?: { id?: unknown }[] }
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  } catch {
    return undefined
  }
}

/**
 * Looks for what can be used straight away: providers ready now, provider keys in the environment, and local model
 * servers (Ollama, LM Studio) answering on their usual ports. The servers are asked at once, each with a short limit,
 * so a computer running none waits no longer than one limit.
 */
export async function detectSetup(input: {
  providers: readonly ProviderInfo[]
  env?: Readonly<Record<string, string | undefined>>
  servers?: readonly LocalServer[]
  timeoutMs?: number
}): Promise<SetupDetection> {
  const env = input.env ?? process.env
  const readyIds = new Set(input.providers.filter((p) => p.ready).map((p) => p.id))
  const found = Object.entries(SETUP_ENV_KEYS)
    .filter(([, variable]) => !!env[variable]?.trim())
    .map(([provider, variable]) => ({ provider, variable, ready: readyIds.has(provider) }))
  const servers = input.servers ?? SETUP_LOCAL_SERVERS
  const listed = await Promise.all(
    servers.map((s) => listModels(s.baseUrl, input.timeoutMs ?? SETUP_PROBE_MS)),
  )
  const local = servers.flatMap((s, i) => {
    const models = listed[i]
    if (!models) return []
    // omp has built-in providers for some local servers (`ollama`, `lm-studio`), ready once the server answers.
    const builtIn = readyIds.has(s.id) ? s.id : undefined
    const custom = input.providers.find(
      (p) =>
        p.id === s.provider || (p.baseUrl !== undefined && trimSlash(p.baseUrl) === trimSlash(s.baseUrl)),
    )
    const provider = builtIn ?? custom?.id ?? s.provider
    return [{ id: s.id, baseUrl: s.baseUrl, provider, models, added: !!builtIn || !!custom }]
  })
  // A provider that is one of those servers is offered once, as the server.
  const covered = new Set(local.filter((l) => l.added).map((l) => l.provider))
  const ready = input.providers
    .filter((p) => p.ready && !covered.has(p.id))
    .map((p) => ({ id: p.id, models: p.models }))
  return { ready, env: found, local }
}

/**
 * Whether any of these models can lead a crew: one whose context window, when known, holds an agent. Small
 * on-device models a computer brings along (Apple's) cannot, so they do not make the Connect models step done.
 */
export function canLeadACrew(models: readonly { contextWindow?: number }[]): boolean {
  return models.some((m) => (m.contextWindow ?? SETUP_LEAD_MIN_WINDOW) >= SETUP_LEAD_MIN_WINDOW)
}

/**
 * The state setup starts in when it is first asked about. An install from before the assistant existed, one that
 * already has a chat or a model the person connected, counts as set up; a new one starts at the beginning.
 */
export function firstSetup(seen: { chats: number; modelConnected: boolean }, now = new Date()): SetupState {
  return seen.chats > 0 || seen.modelConnected ? { finishedAt: now.toISOString(), steps: {} } : { steps: {} }
}

/** What exists already, from the settings and stores, whoever set it up. Alerts live in each browser, not here. */
export function setupHave(input: {
  settings: MyrSettings
  modelReady: boolean
  projects: number
  channelsOn: boolean
  /** The myrmidon command is installed and points at this app. */
  command: boolean
}): SetupHave {
  return {
    you: !!input.settings.profile.name,
    models: input.modelReady,
    crew: !!input.settings.team.leadModel,
    project: input.projects > 0,
    voice: input.settings.voice.enabled,
    channels: input.channelsOn,
    command: input.command,
  }
}

/** One step marked (or its mark cleared with `null`). */
export function markSetup(state: SetupState, step: SetupStep, mark: SetupMark | null): SetupState {
  const steps = { ...state.steps }
  if (mark) steps[step] = mark
  else delete steps[step]
  return { ...state, steps }
}

/**
 * Finished, or left with Finish later: every step not marked yet is done when its thing exists and later otherwise,
 * so what is left shows on the home screen. A step skipped on this Myrmidon is done: there is nothing to come back to.
 */
export function finishSetup(
  state: SetupState,
  have: SetupHave,
  now = new Date(),
  skip: SetupSkip = [],
): SetupState {
  const steps = { ...state.steps }
  // Welcome has nothing to set up later.
  for (const step of SETUP_STEPS)
    steps[step] ??= step === 'welcome' || have[step] || skip.includes(step) ? 'done' : 'later'
  return { ...state, finishedAt: now.toISOString(), steps }
}

/** Starting again from the first step. A dismissed Finish setting up card stays dismissed: that was for good. */
export function restartSetup(state: SetupState): SetupState {
  return { steps: {}, ...(state.dismissedAt ? { dismissedAt: state.dismissedAt } : {}) }
}

/** The home screen's Finish setting up card dismissed, for good. */
export function dismissSetup(state: SetupState, now = new Date()): SetupState {
  return { ...state, dismissedAt: state.dismissedAt ?? now.toISOString() }
}
