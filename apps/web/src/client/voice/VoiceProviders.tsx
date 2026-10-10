import { ExternalLink, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, send } from '../api.ts'
import { copy } from '../copy.ts'
import { baseUrlError, providerNameError } from '../settings-forms.ts'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { ProviderLogo } from '../ui/ProviderGlyph.tsx'
import { Badge, Button, Card, Dot, Field, SectionHeader, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { plainHttp, type VoiceEndpointView, type VoiceProviderView } from './providers.ts'

interface VoiceProvidersData {
  providers: VoiceProviderView[]
  endpoints: VoiceEndpointView[]
}

/**
 * Settings → Models & providers → Providers, its voice part: each voice provider with what it does (speech to text,
 * voices, realtime), where its key comes from, a key form (two fields for AWS) and its region where it needs one; and
 * the person's own OpenAI-compatible speech services. `focus`: scrolled to, from Settings → Voice's "Add a voice
 * provider".
 */
export function VoiceProviders(props: { focus?: boolean }) {
  const t = copy.settings.voiceProviders
  const toast = useToast()
  const [data, setData] = useState<VoiceProvidersData>()
  const [editing, setEditing] = useState<string>()
  const [adding, setAdding] = useState(false)
  const top = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded once; each change answers with the new list
  useEffect(() => {
    api<Partial<VoiceProvidersData>>('/api/voice')
      .then((r) => setData({ providers: r.providers ?? [], endpoints: r.endpoints ?? [] }))
      .catch((err: Error) => toast(err.message, 'error'))
  }, [])
  useEffect(() => {
    if (props.focus && data) top.current?.scrollIntoView?.({ block: 'start' })
  }, [props.focus, data])
  const act = async (run: Promise<VoiceProvidersData>, done: string) => {
    try {
      setData(await run)
      toast(done, 'success')
      return true
    } catch (err) {
      toast((err as Error).message, 'error')
      return false
    }
  }
  if (!data) return null
  const ready = data.providers.filter((p) => p.configured).length
  return (
    <div ref={top} id="voice-providers" className="mt-10 scroll-mt-6">
      <SectionHeader
        icon={<FEATURE_ICONS.voiceProviders className="size-4 text-muted" />}
        title={t.heading}
        note={copy.settings.providers.readyCount(ready, data.providers.length)}
      />
      <p className="mb-3 mt-1 text-callout text-muted">{t.intro}</p>
      <Card>
        {data.providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            open={editing === p.id}
            onToggle={() => setEditing(editing === p.id ? undefined : p.id)}
            onKey={async (body) => {
              if (await act(send('PUT', `/api/voice/providers/${p.id}/key`, body), t.savedKey(p.label)))
                setEditing(undefined)
            }}
            onRegion={(region) =>
              void act(send('PUT', `/api/voice/providers/${p.id}/region`, { region }), t.regionSaved(p.label))
            }
            onRemove={() =>
              void act(send('DELETE', `/api/voice/providers/${p.id}/key`), t.removedKey(p.label))
            }
          />
        ))}
      </Card>

      <div className="mt-8 flex items-center justify-between">
        <SectionHeader title={t.endpoints.heading} />
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
            {t.endpoints.add}
          </Button>
        )}
      </div>
      <p className="mb-3 mt-1 text-callout text-muted">{t.endpoints.note}</p>
      {adding && (
        <EndpointForm
          existing={data.endpoints.map((e) => e.id)}
          onCancel={() => setAdding(false)}
          onSave={async (body) => {
            if (await act(send('POST', '/api/voice/endpoints', body), t.endpoints.added(body.id)))
              setAdding(false)
          }}
        />
      )}
      {data.endpoints.length > 0 && (
        <Card>
          {data.endpoints.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
              <Dot status="ready" />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-body">{e.id}</span>
                <div className="truncate font-mono text-footnote text-muted">
                  {e.baseUrl}
                  {!e.hasKey && ` · ${t.endpoints.noKey}`}
                </div>
              </div>
              <ConfirmButton
                icon
                label={t.endpoints.remove(e.id)}
                confirm={t.endpoints.confirmRemove}
                onConfirm={() =>
                  void act(send('DELETE', `/api/voice/endpoints/${e.id}`), t.endpoints.removed(e.id))
                }
              />
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

function ProviderRow(props: {
  provider: VoiceProviderView
  open: boolean
  onToggle(): void
  onKey(body: Record<string, string>): Promise<void>
  onRegion(region: string): void
  onRemove(): void
}) {
  const t = copy.settings.voiceProviders
  const p = props.provider
  const keyText =
    p.key === 'shared' ? t.key.shared(p.sharedWith ?? p.label) : t.key[p.key as 'stored' | 'env' | 'missing']
  const tags = [
    p.stt && `${t.tags.stt}${p.stt.streaming ? ` · ${t.streams}` : ''}`,
    p.tts && `${t.tags.tts}${p.tts.streaming ? ` · ${t.streams}` : ''}`,
    p.realtime && t.tags.realtime,
  ].filter((x): x is string => !!x)
  const needsRegion = !!p.region?.required && !p.region.value && !p.region.default
  return (
    <div className="px-4 py-2.5" data-voice-provider={p.id}>
      <div className="flex items-center gap-3">
        <Dot status={p.configured ? 'ready' : 'idle'} />
        <ProviderLogo provider={p.id} size={16} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-body font-medium">{p.label}</span>
            {tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
          <div className="text-footnote text-muted">
            {keyText}
            {needsRegion && ` · ${copy.settings.voice.needsRegion(p.label)}`}
          </div>
        </div>
        <a
          href={p.keysUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-footnote text-muted hover:text-fg"
        >
          <ExternalLink className="size-3" />
          {t.getKey}
        </a>
        <Button size="sm" variant="borderless" onClick={props.onToggle}>
          {p.key === 'missing' ? t.addKey : t.replaceKey}
        </Button>
        {p.key === 'stored' && (
          <ConfirmButton
            icon
            label={t.remove(p.label)}
            confirm={t.confirmRemove}
            onConfirm={props.onRemove}
          />
        )}
      </div>
      {props.open && <KeyForm provider={p} onSave={props.onKey} />}
      {p.region && (props.open || needsRegion) && <RegionField provider={p} onSave={props.onRegion} />}
    </div>
  )
}

function KeyForm(props: {
  provider: VoiceProviderView
  onSave(body: Record<string, string>): Promise<void>
}) {
  const t = copy.settings.voiceProviders
  const [key, setKey] = useState('')
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const aws = !!props.provider.aws
  const ready = aws ? !!id.trim() && !!secret.trim() : !!key.trim()
  return (
    <form
      className="mt-2 flex flex-wrap gap-2 pl-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        void props.onSave(
          aws ? { accessKeyId: id.trim(), secretAccessKey: secret.trim() } : { apiKey: key.trim() },
        )
      }}
    >
      {aws ? (
        <>
          <TextInput
            autoComplete="off"
            autoFocus
            placeholder={t.accessKeyId}
            aria-label={t.accessKeyId}
            value={id}
            onChange={(e) => setId(e.target.value)}
            className="min-w-48 flex-1 font-mono"
          />
          <TextInput
            type="password"
            autoComplete="off"
            placeholder={t.secretAccessKey}
            aria-label={t.secretAccessKey}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="min-w-48 flex-1 font-mono"
          />
        </>
      ) : (
        <TextInput
          type="password"
          autoComplete="off"
          autoFocus
          placeholder={copy.settings.providers.apiKeyFor(props.provider.label)}
          aria-label={copy.settings.providers.apiKeyFor(props.provider.label)}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="flex-1 font-mono"
        />
      )}
      <Button type="submit" variant="primary" disabled={!ready}>
        {copy.settings.shared.save}
      </Button>
      {props.provider.sharedWith && (
        <p className="w-full text-footnote text-muted">{t.sharedKeyHint(props.provider.sharedWith)}</p>
      )}
    </form>
  )
}

function RegionField(props: { provider: VoiceProviderView; onSave(region: string): void }) {
  const t = copy.settings.voiceProviders
  const region = props.provider.region
  const listId = `regions-${props.provider.id}`
  return (
    <div className="mt-2 pl-5">
      <Field label={t.region} hint={t.regionHint} inline>
        <TextInput
          defaultValue={region?.value ?? ''}
          placeholder={region?.default ?? 'westeurope'}
          list={region?.options ? listId : undefined}
          aria-label={`${t.region}: ${props.provider.label}`}
          onBlur={(e) => {
            const value = e.target.value.trim()
            if (value !== (region?.value ?? '')) props.onSave(value)
          }}
          className="w-44 font-mono"
        />
      </Field>
      {region?.options && (
        <datalist id={listId}>
          {region.options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
  )
}

function EndpointForm(props: {
  existing: string[]
  onCancel(): void
  onSave(body: { id: string; baseUrl: string; apiKey?: string }): Promise<void>
}) {
  const t = copy.settings.voiceProviders.endpoints
  const [id, setId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const errors = { id: providerNameError(id, props.existing), baseUrl: baseUrlError(baseUrl) }
  return (
    <Card className="mb-3 border-accent/30">
      <div className="grid gap-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.name} hint={t.nameHint} error={tried ? errors.id : undefined}>
            <TextInput
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase())}
              placeholder="kokoro"
            />
          </Field>
          <Field
            label={t.baseUrl}
            hint={plainHttp(baseUrl.trim()) ? copy.settings.voice.hints.plainHttp : undefined}
            error={tried ? errors.baseUrl : undefined}
          >
            <TextInput
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:8880/v1"
              className="font-mono"
            />
          </Field>
        </div>
        <Field label={t.key}>
          <TextInput
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="font-mono"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="borderless" onClick={props.onCancel}>
            {copy.settings.shared.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (errors.id || errors.baseUrl) return setTried(true)
              setBusy(true)
              await props.onSave({
                id,
                baseUrl: baseUrl.trim(),
                ...(key.trim() ? { apiKey: key.trim() } : {}),
              })
              setBusy(false)
            }}
          >
            {t.connect}
          </Button>
        </div>
      </div>
    </Card>
  )
}
