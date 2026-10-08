import { KeyRound } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { pairDevice, whoami } from './api.ts'
import { copy } from './copy.ts'
import { Logo } from './ui/Logo.tsx'
import { Button, Field, TextInput } from './ui/primitives.tsx'

/** A name the person will recognise in Settings → Devices: what this is and which browser. */
function guessName(): string {
  const ua = navigator.userAgent
  const what = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows PC'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ''
  return browser ? `${what} · ${browser}` : what
}

const pairCode = () => new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined

/**
 * Before the app: on a remote gateway, a device that is not paired yet pairs here, with the link (or code) from
 * `myrmidon pair` or Settings → Devices. On this machine, and for a paired device, the app opens straight away.
 */
export function DeviceGate(props: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'pair'>(pairCode() ? 'pair' : 'checking')
  useEffect(() => {
    if (state !== 'checking') return
    whoami()
      .then((r) => setState(!r.ok && r.remote ? 'pair' : 'open'))
      // Unreachable: let the app show its own error.
      .catch(() => setState('open'))
  }, [state])
  if (state === 'checking') return null
  if (state === 'open') return <>{props.children}</>
  return <PairScreen onPaired={() => setState('open')} />
}

function PairScreen(props: { onPaired(): void }) {
  const t = copy.pairing
  const [code, setCode] = useState(pairCode() ?? '')
  // A pairing link opened in a tab already on this page only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const next = pairCode()
      if (next) setCode(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [name, setName] = useState(guessName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pair = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await pairDevice(code.trim(), name.trim())
      // The code is spent; keep it out of the address bar and history.
      history.replaceState(null, '', location.pathname)
      props.onPaired()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-line bg-surface p-6 shadow-pop"
        onSubmit={(e) => {
          e.preventDefault()
          void pair()
        }}
      >
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight">{t.title}</h1>
            <p className="text-[12.5px] text-muted">{location.host}</p>
          </div>
        </div>
        <p className="text-[13.5px] leading-relaxed text-fg-2">
          {t.introBefore}
          <code className="rounded bg-fill px-1 font-mono text-[12.5px]">myrmidon pair</code>
          {t.introAfter}
        </p>
        <Field label={t.code} hint={t.codeHint}>
          <TextInput
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCDEFGHJK"
            aria-label={t.code}
            className="font-mono tracking-[0.12em]"
            autoComplete="one-time-code"
          />
        </Field>
        <Field label={t.name} hint={t.nameHint}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            aria-label={t.name}
          />
        </Field>
        {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad-ink">{error}</p>}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !code.trim()}
          icon={<KeyRound className="size-4" />}
        >
          {t.pair}
        </Button>
      </form>
    </div>
  )
}
