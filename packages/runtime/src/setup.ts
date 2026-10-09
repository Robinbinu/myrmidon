import {
  SETUP_STEPS,
  type SetupHave,
  type SetupMark,
  type SetupState,
  type SetupStep,
} from '@myrmidon/protocol'
import { SETUP_ENV_KEYS, SETUP_LOCAL_SERVERS, SETUP_PROBE_MS } from './config.ts'
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
  const ready = input.providers.filter((p) => p.ready).map((p) => ({ id: p.id, models: p.models }))
  const readyIds = new Set(ready.map((p) => p.id))
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
    const added = input.providers.some(
      (p) =>
        p.id === s.provider || (p.baseUrl !== undefined && trimSlash(p.baseUrl) === trimSlash(s.baseUrl)),
    )
    return [{ id: s.id, baseUrl: s.baseUrl, provider: s.provider, models, added }]
  })
  return { ready, env: found, local }
}

/**
 * The state setup starts in when it is first asked about. An install from before the assistant existed, one that
 * already has a chat or a model, counts as set up; a new one starts at the beginning.
 */
export function firstSetup(seen: { chats: number; modelReady: boolean }, now = new Date()): SetupState {
  return seen.chats > 0 || seen.modelReady ? { finishedAt: now.toISOString(), steps: {} } : { steps: {} }
}

/** What exists already, from the settings and stores, whoever set it up. Alerts live in each browser, not here. */
export function setupHave(input: {
  settings: MyrSettings
  modelReady: boolean
  projects: number
  channelsOn: boolean
}): SetupHave {
  return {
    you: !!input.settings.profile.name,
    models: input.modelReady,
    crew: !!input.settings.team.leadModel,
    project: input.projects > 0,
    voice: input.settings.voice.enabled,
    channels: input.channelsOn,
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
 * so what is left shows on the home screen.
 */
export function finishSetup(state: SetupState, have: SetupHave, now = new Date()): SetupState {
  const steps = { ...state.steps }
  // Welcome has nothing to set up later.
  for (const step of SETUP_STEPS) steps[step] ??= step === 'welcome' || have[step] ? 'done' : 'later'
  return { finishedAt: now.toISOString(), steps }
}
