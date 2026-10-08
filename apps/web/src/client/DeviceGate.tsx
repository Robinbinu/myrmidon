import { KeyRound, Laptop, RefreshCw } from 'lucide-react'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import {
  activeGateway,
  type GatewayInfo,
  listGateways,
  pairDevice,
  SIGNED_OUT,
  switchGateway,
  type WhoAmI,
  whoami,
} from './api.ts'
import { copy } from './copy.ts'
import { Logo } from './ui/Logo.tsx'
import { isMac } from './ui/platform.ts'
import { Button, Field, TextInput } from './ui/primitives.tsx'
import { SIGNED_OUT_RECHECK_MS } from './ui-config.ts'

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

export const ScopeContext = createContext<WhoAmI['scope']>('full')

/**
 * What this window may do on the gateway it shows: everything, or chats only (a device paired that way). The server
 * enforces it; the page uses it to leave out what would only be refused.
 */
export const useScope = () => useContext(ScopeContext)

/**
 * Before the app: on a remote gateway, a device that is not paired yet pairs here, with the link (or code) from
 * `myrmidon pair` or Settings → Devices. On this machine, and for a paired device, the app opens straight away. A
 * device whose pairing ends while the app is open (revoked, or the gateway forgot it) comes back here.
 */
export function DeviceGate(props: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'pair'>(pairCode() ? 'pair' : 'checking')
  const [scope, setScope] = useState<WhoAmI['scope']>('full')
  useEffect(() => {
    if (state !== 'checking') return
    whoami()
      .then((r) => {
        if (r.ok) setScope(r.me.scope)
        setState(!r.ok && r.remote ? 'pair' : 'open')
      })
      // Unreachable: let the app show its own error.
      .catch(() => setState('open'))
  }, [state])
  useEffect(() => {
    if (state !== 'open') return
    // Every poll that gets a 401 says so; one question at a time, and not again soon after, is enough.
    let asking = false
    let askedAt = 0
    const recheck = () => {
      if (asking || Date.now() - askedAt < SIGNED_OUT_RECHECK_MS) return
      asking = true
      askedAt = Date.now()
      whoami()
        .then((r) => !r.ok && r.remote && setState('pair'))
        .catch(() => {})
        .finally(() => {
          asking = false
        })
    }
    window.addEventListener(SIGNED_OUT, recheck)
    return () => window.removeEventListener(SIGNED_OUT, recheck)
  }, [state])
  if (state === 'checking') return null
  if (state === 'open') {
    if (activeGateway()) return <GatewayGate>{props.children}</GatewayGate>
    return <ScopeContext.Provider value={scope}>{props.children}</ScopeContext.Provider>
  }
  return <PairScreen onPaired={() => setState('checking')} />
}

/**
 * With another gateway shown, the app opens once that gateway answers; otherwise the window says why, with a way back
 * to this machine. A gateway removed meanwhile sends the window back by itself.
 */
function GatewayGate(props: { children: ReactNode }) {
  const t = copy.gateways
  const [gateway, setGateway] = useState<GatewayInfo | 'checking'>('checking')
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the check
  useEffect(() => {
    let alive = true
    listGateways()
      .then((list) => {
        const found = list.find((g) => g.id === activeGateway())
        if (!found) switchGateway(undefined)
        else if (alive) setGateway(found)
      })
      .catch(() => alive && switchGateway(undefined))
    return () => {
      alive = false
    }
  }, [attempt])
  if (gateway !== 'checking' && gateway.health.ok)
    return <ScopeContext.Provider value={gateway.scope}>{props.children}</ScopeContext.Provider>
  const local = t.local(isMac)
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-pop">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold tracking-tight">
              {gateway === 'checking' ? t.down.checking('…') : t.down.title(gateway.name)}
            </h1>
            {gateway !== 'checking' && (
              <p className="truncate text-callout text-muted">{new URL(gateway.url).host}</p>
            )}
          </div>
        </div>
        {gateway !== 'checking' && (
          <>
            <p className="rounded-lg bg-bad-soft px-3 py-2 text-callout text-bad-ink">
              {gateway.health.error ?? t.unreachable}
            </p>
            <div className="flex gap-2">
              <Button
                variant="primary"
                icon={<Laptop className="size-4" />}
                onClick={() => switchGateway(undefined)}
              >
                {t.down.back(local)}
              </Button>
              <Button
                variant="ghost"
                icon={<RefreshCw className="size-4" />}
                onClick={() => {
                  setGateway('checking')
                  setAttempt((n) => n + 1)
                }}
              >
                {t.down.retry}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
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
            <p className="text-callout text-muted">{location.host}</p>
          </div>
        </div>
        <p className="text-reading leading-relaxed text-fg-2">
          {t.introBefore}
          <code className="rounded bg-fill px-1 font-mono text-callout">myrmidon pair</code>
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
        {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-callout text-bad-ink">{error}</p>}
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
