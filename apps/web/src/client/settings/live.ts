import type { Company } from '@myrmidon/protocol'
import { useEffect, useMemo, useState } from 'react'
import { api, type GatewayInfo, listGateways, type ModelOption, type Specialist } from '../api.ts'
import { ACCESS_INFO } from '../permissions/describe.ts'
import type {
  ChannelView,
  DeviceRow,
  LoginOption,
  McpServer,
  PluginEntry,
  ScheduleEntry,
  SettingsResponse,
  SkillEntry,
} from '../Settings.tsx'
import { themeItems } from '../themes/AppearanceSection.tsx'
import type { VoiceEndpointView, VoiceProviderView } from '../voice/providers.ts'
import type { LiveData } from './registry.ts'

type Fetched = Pick<
  LiveData,
  | 'logins'
  | 'voiceProviders'
  | 'voiceEndpoints'
  | 'mcpServers'
  | 'plugins'
  | 'specialists'
  | 'companies'
  | 'channels'
  | 'gateways'
  | 'devices'
  | 'schedules'
  | 'skills'
>

/** Asks for one list the way its page does; a list that cannot be had leaves its items out of search. */
const ask = <T, R>(load: () => Promise<T>, pick: (r: T) => R | undefined): Promise<R | undefined> =>
  load().then(pick, () => undefined)

/** Every live list the pages load for themselves, from the same endpoints. */
async function fetchLive(): Promise<Partial<Fetched>> {
  const [
    logins,
    voice,
    mcpServers,
    plugins,
    specialists,
    channels,
    gateways,
    devices,
    schedules,
    skills,
    companies,
  ] = await Promise.all([
    ask(
      () => api<{ logins: LoginOption[] }>('/api/logins'),
      (r) => r.logins,
    ),
    ask(
      () => api<{ providers?: VoiceProviderView[]; endpoints?: VoiceEndpointView[] }>('/api/voice'),
      (r) => r,
    ),
    ask(
      () => api<{ servers: McpServer[] }>('/api/mcp'),
      (r) => r.servers,
    ),
    ask(
      () => api<{ plugins: PluginEntry[] }>('/api/plugins'),
      (r) => r.plugins,
    ),
    ask(
      () => api<{ specialists: Specialist[] }>('/api/specialists'),
      (r) => r.specialists,
    ),
    ask(
      () => api<{ channels: ChannelView[] }>('/api/channels'),
      (r) => r.channels,
    ),
    ask<GatewayInfo[], GatewayInfo[]>(listGateways, (r) => r),
    ask(
      () => api<{ devices: DeviceRow[] }>('/api/devices'),
      (r) => r.devices,
    ),
    ask(
      () => api<{ schedules: ScheduleEntry[] }>('/api/schedules'),
      (r) => r.schedules,
    ),
    ask(
      () => api<{ skills: SkillEntry[] }>('/api/skills'),
      (r) => r.skills,
    ),
    ask(
      () => api<{ companies: Company[] }>('/api/companies'),
      (r) => r.companies,
    ),
  ])
  const list = <T>(x: T[] | undefined) => (Array.isArray(x) ? x : [])
  return {
    logins: list(logins),
    voiceProviders: list(voice?.providers),
    voiceEndpoints: list(voice?.endpoints),
    mcpServers: list(mcpServers),
    plugins: list(plugins),
    specialists: list(specialists),
    channels: list(channels),
    gateways: list(gateways),
    devices: list(devices),
    schedules: list(schedules),
    skills: list(skills),
    companies: list(companies),
  }
}

/** The providers Models & providers lists models under: each with a model not removed to Hidden models. */
export const modelGroups = (models: readonly ModelOption[], hidden: readonly string[]): string[] => {
  const removed = new Set(hidden)
  return [...new Set(models.filter((x) => !removed.has(x.ref)).map((x) => x.provider))].sort((a, b) =>
    a.localeCompare(b),
  )
}

/**
 * The live lists search indexes, for the same registry entries the pages render their rows with: what Settings
 * already has (providers, models, rules, themes) at once, the rest asked for each time `active` turns on (the search
 * field is focused), so a provider, server or schedule added on a page is found by its name.
 */
export function useLiveSettings(
  active: boolean,
  data: SettingsResponse | undefined,
  models: readonly ModelOption[],
): Partial<LiveData> {
  const [fetched, setFetched] = useState<Partial<Fetched>>({})
  useEffect(() => {
    if (!active) return
    let live = true
    void fetchLive().then((f) => live && setFetched(f))
    return () => {
      live = false
    }
  }, [active])
  return useMemo(
    () => ({
      ...fetched,
      models,
      modelProviders: modelGroups(models, data?.settings.models.hidden ?? []),
      themes: themeItems(data?.settings.appearance?.imported ?? []),
      accessGroups: ACCESS_INFO,
      ...(data ? { providers: data.providers, rules: data.settings.permissions.rules } : {}),
    }),
    [fetched, models, data],
  )
}
