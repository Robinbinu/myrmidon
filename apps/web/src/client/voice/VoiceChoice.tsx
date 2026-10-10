import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { copy } from '../copy.ts'
import { SettingField, settingRow } from '../settings/Setting.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Button, Card, Segmented, Select, TextInput } from '../ui/primitives.tsx'
import {
  type EngineGroup,
  engineGroups,
  hostOf,
  type VoiceEndpointView,
  type VoiceOptionView,
  type VoiceProviderView,
} from './providers.ts'

/** The voice settings these pickers change (Settings.tsx's ServerSettings['voice']). */
export interface VoiceChoiceSettings {
  mode?: 'pipeline' | 'realtime'
  stt: { provider: string; model?: string }
  tts: { provider: string; model?: string; voiceId?: string; speed: number }
  realtime?: { provider?: string; model?: string; voice?: string }
}

type Patch<V> = (patch: (voice: V) => V) => void

/** "Add a voice provider": opens Models & providers on its Providers tab, at Voice providers. */
export function AddVoiceProvider(props: { onClick(): void }) {
  return (
    <Button
      {...settingRow('voice.addProvider')}
      size="sm"
      variant="borderless"
      icon={<FEATURE_ICONS.voiceProviders className="size-3.5" />}
      onClick={props.onClick}
      title={copy.settings.voice.addProviderHint}
    >
      {copy.settings.voice.addProvider}
    </Button>
  )
}

/** Pipeline or Realtime. */
export function CallModeRow<V extends VoiceChoiceSettings>(props: { voice: V; set: Patch<V> }) {
  const t = copy.settings.voice
  const mode = props.voice.mode ?? 'pipeline'
  return (
    <SettingField id="voice.mode" hint={t.modeHints[mode]}>
      <Segmented
        id="call-mode"
        value={mode}
        options={[
          { value: 'pipeline', label: t.modes.pipeline },
          { value: 'realtime', label: t.modes.realtime },
        ]}
        onChange={(m) => props.set((v) => ({ ...v, mode: m }))}
      />
    </SettingField>
  )
}

/** A native select with the engine groups as option groups. */
export function EngineSelect(props: {
  label: string
  value: string
  groups: EngineGroup[]
  onChange(value: string): void
}) {
  return (
    <Select value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-label={props.label}>
      {props.groups.map((g) =>
        g.label ? (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : (
          g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))
        ),
      )}
    </Select>
  )
}

/** The engine picker for speech to text or text to speech: a new choice starts from its provider's defaults. */
export function EnginePicker<V extends VoiceChoiceSettings>(props: {
  kind: 'stt' | 'tts'
  voice: V
  providers: readonly VoiceProviderView[]
  endpoints: readonly VoiceEndpointView[]
  set: Patch<V>
  hint?: React.ReactNode
}) {
  const t = copy.settings.voice
  const current = props.voice[props.kind].provider
  const label = props.kind === 'stt' ? t.sttTitle : t.ttsTitle
  return (
    <SettingField id={props.kind === 'stt' ? 'voice.stt.engine' : 'voice.tts.engine'} hint={props.hint}>
      <EngineSelect
        label={label}
        value={current}
        groups={engineGroups(props.kind, current, props.providers, props.endpoints)}
        onChange={(provider) =>
          props.set((v) =>
            props.kind === 'stt'
              ? { ...v, stt: { provider } }
              : { ...v, tts: { ...v.tts, provider, model: undefined, voiceId: undefined } },
          )
        }
      />
    </SettingField>
  )
}

/** What a cloud choice does with the person's audio, in a line under its picker. */
export function cloudHint(
  kind: 'stt' | 'tts',
  provider: string,
  providers: readonly VoiceProviderView[],
  endpoints: readonly VoiceEndpointView[],
): string | undefined {
  const h = copy.settings.voice.cloudHints
  if (provider.startsWith('endpoint:')) {
    const e = endpoints.find((x) => `endpoint:${x.id}` === provider)
    return e ? h.endpoint(hostOf(e.baseUrl)) : undefined
  }
  const p = providers.find((x) => x.id === provider)
  if (!p) return undefined
  const line =
    kind === 'stt'
      ? p.stt?.streaming
        ? h.streams(p.label)
        : h.batch(p.label)
      : p.tts?.streaming
        ? h.speaks(p.label)
        : h.speaksWhole(p.label)
  return `${line} ${h.fallback}`
}

/** A provider's voices: fetched from it where it has a list and its key is set, else the ones it comes with. */
export function useVoices(provider?: VoiceProviderView, model?: string): VoiceOptionView[] | undefined {
  const fallback = provider?.tts?.voices
  const [voices, setVoices] = useState<VoiceOptionView[]>()
  const ask = provider?.tts?.voiceList && provider.configured ? provider.id : undefined
  useEffect(() => {
    setVoices(undefined)
    if (!ask) return
    const q = model ? `?model=${encodeURIComponent(model)}` : ''
    let live = true
    api<{ voices: VoiceOptionView[] }>(`/api/voice/providers/${encodeURIComponent(ask)}/voices${q}`)
      .then((r) => live && setVoices(r.voices))
      // A list that cannot be fetched leaves the ones the provider comes with.
      .catch(() => live && setVoices(undefined))
    return () => {
      live = false
    }
  }, [ask, model])
  return voices ?? fallback
}

/** A select of options, with the saved value kept when the list does not have it (a voice from elsewhere). */
function OptionSelect(props: {
  label: string
  value: string
  options: readonly VoiceOptionView[]
  onChange(id: string): void
}) {
  const options = props.options.some((o) => o.id === props.value)
    ? props.options
    : [{ id: props.value, label: props.value }, ...props.options]
  return (
    <Select value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-label={props.label}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}

/**
 * The model (and for text to speech the voice) of a cloud or endpoint choice: a provider's from its lists, an
 * endpoint's typed in.
 */
export function CloudRows<V extends VoiceChoiceSettings>(props: {
  kind: 'stt' | 'tts'
  voice: V
  providers: readonly VoiceProviderView[]
  set: Patch<V>
}) {
  const t = copy.settings.voice
  const choice = props.voice[props.kind]
  const provider = props.providers.find((p) => p.id === choice.provider)
  const models = provider?.[props.kind]?.models ?? []
  const model = choice.model ?? models[0]?.id ?? ''
  const voices = useVoices(props.kind === 'tts' ? provider : undefined, model)
  const setModel = (m: string | undefined) =>
    props.set((v) =>
      props.kind === 'stt' ? { ...v, stt: { ...v.stt, model: m } } : { ...v, tts: { ...v.tts, model: m } },
    )
  if (choice.provider.startsWith('endpoint:'))
    return (
      <>
        <SettingField
          id={props.kind === 'stt' ? 'voice.stt.endpointModel' : 'voice.tts.endpointModel'}
          inline
        >
          <TextInput
            defaultValue={choice.model ?? ''}
            placeholder={props.kind === 'stt' ? 'whisper-1' : 'tts-1'}
            onBlur={(e) => setModel(e.target.value.trim() || undefined)}
            aria-label={t.endpointModel}
            className="font-mono"
          />
        </SettingField>
        {props.kind === 'tts' && (
          <SettingField id="voice.tts.endpointVoice" inline>
            <TextInput
              defaultValue={props.voice.tts.voiceId ?? ''}
              placeholder="alloy"
              onBlur={(e) => {
                const voiceId = e.target.value.trim() || undefined
                props.set((v) => ({ ...v, tts: { ...v.tts, voiceId } }))
              }}
              aria-label={t.endpointVoice}
            />
          </SettingField>
        )}
      </>
    )
  if (!provider) return null
  const voice = props.voice.tts.voiceId ?? voices?.[0]?.id ?? ''
  return (
    <>
      {models.length > 1 && (
        <SettingField id={props.kind === 'stt' ? 'voice.stt.model' : 'voice.tts.model'} inline>
          <OptionSelect label={t.model} value={model} options={models} onChange={setModel} />
        </SettingField>
      )}
      {props.kind === 'tts' && (
        <SettingField id="voice.tts.voiceId" inline hint={voices ? undefined : t.voicesLoading}>
          <OptionSelect
            label={t.voice}
            value={voice}
            options={voices ?? []}
            onChange={(voiceId) => props.set((v) => ({ ...v, tts: { ...v.tts, voiceId } }))}
          />
        </SettingField>
      )}
    </>
  )
}

/** Realtime mode's model: a configured provider's, its model and its voice. */
export function RealtimeCard<V extends VoiceChoiceSettings>(props: {
  voice: V
  providers: readonly VoiceProviderView[]
  set: Patch<V>
  onAddProvider(): void
}) {
  const t = copy.settings.voice
  const offering = props.providers.filter((p) => p.realtime)
  const ready = offering.filter((p) => p.configured)
  const id = props.voice.realtime?.provider ?? ready[0]?.id ?? offering[0]?.id ?? ''
  const provider = offering.find((p) => p.id === id)
  const groups: EngineGroup[] = engineGroupsFor(offering, id)
  const model = props.voice.realtime?.model ?? provider?.realtime?.models[0]?.id ?? ''
  const voice = props.voice.realtime?.voice ?? provider?.realtime?.voices[0]?.id ?? ''
  const patch = (r: Partial<NonNullable<V['realtime']>>) =>
    props.set((v) => ({ ...v, realtime: { provider: id, ...v.realtime, ...r } }))
  return (
    <Card className="mb-6">
      <SettingField id="voice.realtime.provider" hint={ready.length ? undefined : t.noRealtime}>
        <div className="flex flex-wrap items-center gap-2">
          <EngineSelect
            label={t.realtimeTitle}
            value={id}
            groups={groups}
            onChange={(p) => props.set((v) => ({ ...v, realtime: { provider: p } }))}
          />
          <AddVoiceProvider onClick={props.onAddProvider} />
        </div>
      </SettingField>
      {provider?.configured && (
        <>
          <SettingField id="voice.realtime.model" inline>
            <OptionSelect
              label={t.realtimeModel}
              value={model}
              options={provider.realtime?.models ?? []}
              onChange={(m) => patch({ model: m } as Partial<NonNullable<V['realtime']>>)}
            />
          </SettingField>
          <SettingField id="voice.realtime.voice" inline>
            <OptionSelect
              label={t.realtimeVoice}
              value={voice}
              options={provider.realtime?.voices ?? []}
              onChange={(x) => patch({ voice: x } as Partial<NonNullable<V['realtime']>>)}
            />
          </SettingField>
        </>
      )}
    </Card>
  )
}

/** The realtime providers as picker groups: those set up, then those still missing a key. */
function engineGroupsFor(offering: readonly VoiceProviderView[], current: string): EngineGroup[] {
  const t = copy.settings.voice
  const ready = offering.filter((p) => p.configured)
  const missing = offering.filter((p) => !p.configured)
  return [
    ...(ready.length
      ? [{ label: t.groups.cloud, options: ready.map((p) => ({ value: p.id, label: p.label })) }]
      : []),
    ...(missing.length
      ? [
          {
            label: t.groups.missing,
            options: missing.map((p) => ({
              value: p.id,
              label: t.needsKey(p.label),
              // The saved choice stays selectable, so the picker shows it.
              disabled: p.id !== current,
            })),
          },
        ]
      : []),
  ]
}
