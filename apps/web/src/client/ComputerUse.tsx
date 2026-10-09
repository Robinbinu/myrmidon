import type { ComputerApp } from '@myrmidon/protocol'
import { CircleStop, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, post, send } from './api.ts'
import { formatSize } from './chat/Attachments.tsx'
import { copy } from './copy.ts'
import { ConfirmButton } from './ui/ConfirmButton.tsx'
import { DESKTOP_COMPUTER_STOP, DESKTOP_SHORTCUT_EVENT, desktop } from './ui/desktop.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import {
  Badge,
  Button,
  Card,
  CardRow,
  cn,
  PageHeader,
  SectionHeader,
  Segmented,
  Switch,
} from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'
import { COMPUTER_IDLE_POLL_MS, COMPUTER_POLL_MS, COMPUTER_SETTINGS_POLL_MS } from './ui-config.ts'

const t = copy.computerUse

/** Opens Settings at a section (its id as the event's detail) from anywhere in the page, e.g. a chat's step. */
export const OPEN_SETTINGS_EVENT = 'myr:open-settings'

/** What the server says about computer use (GET /api/computer). */
export interface ComputerStatus {
  supported: boolean
  enabled: boolean
  engine: 'cua' | 'omp'
  state: { state: string; received?: number; total?: number; error?: string }
  driver?: { path: string; version?: string; own: boolean }
  version: string
  downloadBytes: number
  grants: { accessibility: boolean; screenRecording: boolean } | null
  controls: { colonyId: string; agent: string; app: string; since: number }[]
}

/** GET /api/computer, again every `everyMs` (every `idleMs` while computer use is off). */
export function useComputerStatus(everyMs: number, idleMs = everyMs) {
  const [status, setStatus] = useState<ComputerStatus>()
  const [tick, setTick] = useState(0)
  const wait = status && !status.enabled ? idleMs : everyMs
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick asks again
  useEffect(() => {
    let stop = false
    api<ComputerStatus>('/api/computer')
      .then((s) => !stop && setStatus(s))
      .catch(() => {})
    const timer = setTimeout(() => setTick((n) => n + 1), wait)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [wait, tick])
  return [status, setStatus] as const
}

interface ChatApps {
  chatId: string
  title: string
  computerApps?: ComputerApp[]
}

/** Settings → Computer use: its switch, its engine, the driver, macOS's grants, the tiers, and apps chats allowed. */
export function ComputerSection(props: {
  enabled: boolean
  setEnabled(enabled: boolean): void
  engine: 'cua' | 'omp'
  setEngine(engine: 'cua' | 'omp'): void
}) {
  const toast = useToast()
  const [status, setStatus] = useComputerStatus(COMPUTER_SETTINGS_POLL_MS)
  const [chats, setChats] = useState<ChatApps[]>([])
  const loadChats = () =>
    api<ChatApps[]>('/api/chats')
      .then((list) => setChats(list.filter((c) => c.computerApps?.length)))
      .catch(() => {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: once when the section opens; a revoke loads again itself
  useEffect(() => {
    void loadChats()
  }, [])
  const act = (work: Promise<ComputerStatus>, done?: string) =>
    work.then(
      (s) => {
        setStatus(s)
        if (done) toast(done, 'success')
      },
      (err: Error) => toast(err.message, 'error'),
    )
  const revoke = (chat: ChatApps, app: ComputerApp) =>
    send('PUT', `/api/chats/${chat.chatId}/computer-apps`, {
      keep: (chat.computerApps ?? []).filter((a) => a.bundleId !== app.bundleId).map((a) => a.bundleId),
    }).then(
      () => {
        toast(t.revoked(app.name), 'success')
        void loadChats()
      },
      (err: Error) => toast(err.message, 'error'),
    )

  if (status && !status.supported)
    return (
      <>
        <PageHeader title={t.title}>{t.intro}</PageHeader>
        <p className="text-body text-muted">{t.unsupported}</p>
      </>
    )
  const state = status?.state.state ?? 'missing'
  const size = formatSize(status?.downloadBytes ?? 0)
  const cua = props.engine === 'cua'
  return (
    <>
      <PageHeader title={t.title}>{t.intro}</PageHeader>
      <Card>
        <CardRow>
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-fill text-fg-2">
              <FEATURE_ICONS.computerUse className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-reading font-medium">{t.switchLabel}</div>
              <div className="text-callout text-muted">{t.switchHint}</div>
            </div>
            {props.enabled ? (
              <Switch checked label={t.switchLabel} onChange={() => props.setEnabled(false)} />
            ) : (
              <ConfirmButton
                label={t.turnOn}
                name={t.turnOnName}
                confirm={t.confirmOn}
                warning={t.warning}
                onConfirm={() => props.setEnabled(true)}
              />
            )}
          </div>
        </CardRow>
      </Card>

      <SectionHeader className="mb-2 mt-8" title={t.engineTitle} note={t.engineNote} />
      <Card>
        <CardRow>
          <div className="flex flex-col gap-2">
            <Segmented
              id="computer-engine"
              value={props.engine}
              options={(['cua', 'omp'] as const).map((value) => ({ value, label: t.engines[value].label }))}
              onChange={props.setEngine}
            />
            <p className="text-callout text-muted">{t.engines[props.engine].hint}</p>
          </div>
        </CardRow>
      </Card>

      {cua && <SectionHeader className="mb-2 mt-8" title={t.driverTitle} note={t.driverNote} />}
      {cua && (
        <Card>
          <CardRow>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-body">
                <div className="font-medium">
                  {t.driverStates[state] ?? state}
                  {state === 'installing' && status?.state.received !== undefined && (
                    <span className="text-muted">
                      {' '}
                      · {t.progress(formatSize(status.state.received), formatSize(status.state.total ?? 0))}
                    </span>
                  )}
                </div>
                <div className="truncate text-callout text-muted" title={status?.driver?.path}>
                  {status?.driver
                    ? t.installedAt(status.driver.version, status.driver.own)
                    : t.installHint(status?.version ?? '', size)}
                </div>
                {state === 'error' && status?.state.error && (
                  <div className="mt-1 text-callout text-bad-ink">{status.state.error}</div>
                )}
              </div>
              {state === 'installing' || state === 'starting' ? (
                <LoaderCircle className="size-4 animate-spin text-muted" />
              ) : (
                (state === 'missing' || state === 'error' || status?.driver?.own) && (
                  <Button
                    size="sm"
                    variant="push"
                    onClick={() => void act(post<ComputerStatus>('/api/computer/install', {}))}
                  >
                    {status?.driver ? t.reinstall : t.install(size)}
                  </Button>
                )
              )}
            </div>
          </CardRow>
        </Card>
      )}

      <SectionHeader className="mb-2 mt-8" title={t.grantsTitle} note={t.grantsNote} />
      <Card>
        {(['screenRecording', 'accessibility'] as const).map((grant) => {
          const given = status?.grants?.[grant]
          return (
            <CardRow key={grant}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-reading font-medium">{t.grants[grant].label}</div>
                  <div className="text-callout text-muted">{t.grants[grant].hint}</div>
                </div>
                {status?.grants ? (
                  <Badge tone={given ? 'ok' : 'warn'}>{given ? t.granted : t.notGranted}</Badge>
                ) : (
                  <span className="text-callout text-muted">{t.unknownGrants}</span>
                )}
                {status?.grants && !given && (
                  <Button
                    size="sm"
                    variant="push"
                    onClick={() => void act(post<ComputerStatus>('/api/computer/grants', { grant }))}
                  >
                    {t.grant}
                  </Button>
                )}
              </div>
            </CardRow>
          )
        })}
        {cua && (
          <CardRow>
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-callout text-muted">{t.restartNote}</p>
              <Button
                size="sm"
                variant="push"
                onClick={() => void act(post<ComputerStatus>('/api/computer/restart', {}), t.restarted)}
              >
                {t.restart}
              </Button>
            </div>
          </CardRow>
        )}
      </Card>

      <SectionHeader className="mb-2 mt-8" title={t.tiersTitle} />
      <Card>
        <CardRow>
          <ul className="list-disc space-y-1 pl-5 text-body text-fg-2">
            {(cua ? t.tiers : t.ompTiers).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </CardRow>
      </Card>

      <SectionHeader className="mb-2 mt-8" title={t.appsTitle} note={t.appsNote} />
      <Card>
        {chats.length === 0 ? (
          <CardRow>
            <span className="text-body text-muted">{t.noApps}</span>
          </CardRow>
        ) : (
          chats.flatMap((chat) =>
            (chat.computerApps ?? []).map((app) => (
              <CardRow key={`${chat.chatId}:${app.bundleId}`}>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-reading font-medium">{app.name}</div>
                    <div className="truncate text-callout text-muted">{chat.title}</div>
                  </div>
                  <Badge tone={app.tier === 'full' ? 'warn' : 'neutral'}>{t.tier[app.tier]}</Badge>
                  <Button size="sm" variant="push" onClick={() => void revoke(chat, app)}>
                    {t.revoke}
                  </Button>
                </div>
              </CardRow>
            )),
          )
        )}
      </Card>
    </>
  )
}

/**
 * While an agent controls the person's Mac: a bar across the app saying who and where, with Stop. In the desktop app
 * Esc stops it too, from anywhere (the shell holds Esc only while an agent is in control), and a notification says so
 * once each time control starts.
 */
export function ComputerBanner() {
  const toast = useToast()
  const [status, setStatus] = useComputerStatus(COMPUTER_POLL_MS, COMPUTER_IDLE_POLL_MS)
  const controls = status?.enabled ? status.controls : []
  const active = controls.length > 0
  const was = useRef(false)
  useEffect(() => {
    if (active === was.current) return
    was.current = active
    const shell = desktop()
    void shell?.computerControl?.(active).catch(() => {})
    if (active) void shell?.notify(t.notifyTitle, t.notifyBody).catch(() => {})
  }, [active])
  const stop = () =>
    post<ComputerStatus>('/api/computer/stop', {}).then(
      (s) => {
        setStatus(s)
        toast(t.stopped, 'success')
      },
      (err: Error) => toast(err.message, 'error'),
    )
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    const onShortcut = (e: Event) => {
      if ((e as CustomEvent<string>).detail === DESKTOP_COMPUTER_STOP) void stopRef.current()
    }
    window.addEventListener(DESKTOP_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(DESKTOP_SHORTCUT_EVENT, onShortcut)
  }, [])
  // Leave the shell's Esc free when the page goes away.
  useEffect(
    () => () =>
      void desktop()
        ?.computerControl?.(false)
        .catch(() => {}),
    [],
  )
  if (!active) return null
  const first = controls[0]
  return (
    <div
      role="status"
      className={cn(
        'fixed left-1/2 top-3 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full border border-warn/30',
        'bg-warn-soft py-1.5 pl-3 pr-1.5 text-body text-warn-ink shadow-lg',
      )}
    >
      <FEATURE_ICONS.computerUse className="size-4 shrink-0" />
      <span className="font-medium">
        {controls.length > 1 ? t.bannerMany(controls.length) : first && t.banner(first.agent, first.app)}
      </span>
      {desktop() && <span className="text-callout opacity-80">{t.escHint}</span>}
      <Button size="sm" variant="push" icon={<CircleStop className="size-3.5" />} onClick={() => void stop()}>
        {t.stop}
      </Button>
    </div>
  )
}
