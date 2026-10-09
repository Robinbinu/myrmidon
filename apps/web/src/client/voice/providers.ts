import { copy } from '../copy.ts'

/** A model or a voice a provider offers. */
export interface VoiceOptionView {
  id: string
  label: string
}

/** A cloud voice provider as GET /api/voice describes it (packages/runtime voice/hub.ts VoiceProviderStatus). */
export interface VoiceProviderView {
  id: string
  label: string
  keysUrl: string
  key: 'stored' | 'shared' | 'env' | 'missing'
  sharedWith?: string
  aws?: true
  region?: { required: boolean; default?: string; options?: string[]; value?: string }
  configured: boolean
  stt?: { models: VoiceOptionView[]; streaming: boolean }
  tts?: { models: VoiceOptionView[]; voices: VoiceOptionView[]; streaming: boolean; voiceList: boolean }
  realtime?: { models: VoiceOptionView[]; voices: VoiceOptionView[] }
}

/** One of the person's OpenAI-compatible speech services. */
export interface VoiceEndpointView {
  id: string
  baseUrl: string
  keyless?: boolean
  hasKey: boolean
}

export interface EngineGroup {
  label: string
  options: { value: string; label: string; disabled?: boolean }[]
}

/**
 * What Settings → Voice offers for speech to text or text to speech: the engines on this computer, omp's speech
 * models, the voice providers set up in Models & providers, those still missing a key (shown, not chosen), and the
 * person's own services. A choice no longer on offer is kept at the top, so the picker shows what is saved.
 */
export function engineGroups(
  kind: 'stt' | 'tts',
  current: string,
  providers: readonly VoiceProviderView[],
  endpoints: readonly VoiceEndpointView[],
): EngineGroup[] {
  const t = copy.settings.voice
  const offering = providers.filter((p) => p[kind])
  const groups: EngineGroup[] = [
    {
      label: t.groups.local,
      options: [
        kind === 'stt'
          ? { value: 'phonon', label: t.providers.phonon }
          : { value: 'kitten', label: t.providers.kitten },
      ],
    },
    { label: t.groups.omp, options: [{ value: 'omp', label: t.providers.omp }] },
  ]
  const ready = offering.filter((p) => p.configured)
  if (ready.length)
    groups.push({ label: t.groups.cloud, options: ready.map((p) => ({ value: p.id, label: p.label })) })
  const missing = offering.filter((p) => !p.configured)
  if (missing.length)
    groups.push({
      label: t.groups.missing,
      options: missing.map((p) => ({
        value: p.id,
        label: p.key === 'missing' ? t.needsKey(p.label) : t.needsRegion(p.label),
        disabled: true,
      })),
    })
  if (endpoints.length)
    groups.push({
      label: t.groups.yours,
      options: endpoints.map((e) => ({ value: `endpoint:${e.id}`, label: `${e.id} · ${hostOf(e.baseUrl)}` })),
    })
  const offered = groups.some((g) => g.options.some((o) => o.value === current && !o.disabled))
  if (!offered) {
    const named = providers.find((p) => p.id === current)
    groups.unshift({ label: '', options: [{ value: current, label: named?.label ?? current }] })
  }
  return groups
}

/** An address's host, to tell services apart in a list. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A plain http address to another machine, where a key and audio would travel unencrypted. */
export function plainHttp(url: string | undefined): boolean {
  if (!url?.startsWith('http://')) return false
  try {
    return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}
