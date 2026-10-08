import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  RefreshCw,
  Settings2,
  WifiOff,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { send } from './api.ts'
import { copy } from './copy.ts'
import { type GatewayStatus, useStatus } from './status.tsx'
import { ChannelLogo } from './ui/ChannelLogo.tsx'
import { ago, day, useCopy } from './ui/hooks.ts'
import { Button, cn, Dot, Skeleton } from './ui/primitives.tsx'
import { runPhase } from './ui/status.ts'
import { useToast } from './ui/Toast.tsx'

/** A path under a home folder as people write it (`~/.myrmidon`); the page cannot ask the server's home directly. */
export function shortPath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, '~')
}

/** Channels set up on this gateway, on or off. A status without `configured` already lists only those. */
export function setUpChannels<T extends { enabled: boolean; configured?: boolean }>(channels: T[]): T[] {
  return channels.filter((c) => c.enabled || c.configured !== false)
}

function Section(props: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-body font-semibold">{props.title}</h2>
        {props.action}
      </header>
      <div className="divide-y divide-line">{props.children}</div>
    </section>
  )
}

const Line = (props: { children: ReactNode; className?: string }) => (
  <div className={cn('flex items-center gap-3 px-4 py-2.5 text-body', props.className)}>{props.children}</div>
)

/**
 * How this gateway is doing, in one place (Hermes's System panel, OpenClaw's Connection and Channels pages): the
 * gateway itself, models and the sandbox, what is running, each channel's health, and recent activity.
 */
export function SystemPage(props: { onManageChannels(): void; onOpenChat(chatId: string): void }) {
  const t = copy.system
  const { status, offline, error, ping, refresh } = useStatus()
  const [copied, copyText] = useCopy()
  if (!status && !offline && error)
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 px-6 py-8" role="alert">
          <h1 className="text-heading font-semibold tracking-tight">{t.title}</h1>
          <p className="text-body text-muted">{error}</p>
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={refresh}>
            {t.tryAgain}
          </Button>
        </div>
      </div>
    )
  if (!status && !offline)
    return (
      <div className="min-h-0 flex-1 overflow-auto" aria-busy="true">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
          <p className="text-body text-muted">{t.loading}</p>
          <Skeleton className="h-28" />
          <Skeleton className="h-20" />
        </div>
      </div>
    )
  const channels = status?.channels && setUpChannels(status.channels)
  const headline = offline ? t.offline : status?.overall === 'degraded' ? t.degraded : t.ok
  const HeadIcon = offline ? WifiOff : status?.overall === 'degraded' ? CircleAlert : CircleCheck
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
        <div className="flex items-center gap-3">
          <HeadIcon
            className={cn(
              'size-6',
              offline ? 'text-bad-ink' : status?.overall === 'degraded' ? 'text-warn-ink' : 'text-ok-ink',
            )}
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-heading font-semibold tracking-tight">{t.title}</h1>
            <p className="text-body text-muted">{headline}</p>
          </div>
          <Button size="sm" variant="borderless" icon={<RefreshCw className="size-3.5" />} onClick={refresh}>
            {t.refresh}
          </Button>
        </div>

        {!!status?.problems.length && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-warn-soft px-4 py-3 text-body text-warn-ink">
            {status.problems.map((p) => (
              <div key={p.kind === 'channel' ? p.channel : p.kind}>
                {p.kind === 'no-models' ? t.problems.noModels : t.problems.channel(p.label)}
              </div>
            ))}
          </div>
        )}

        {status?.startedAt && (
          <Section title={t.gateway}>
            <Line>
              <span className="flex-1">{status.remote ? t.remote(status.publicUrl) : t.local}</span>
              {ping !== undefined && !offline && <span className="text-muted">{t.ping(ping)}</span>}
            </Line>
            <Line>
              <span className="flex-1 text-muted">{t.up(day(status.startedAt, true))}</span>
            </Line>
            {status.home && (
              <Line>
                <span className="text-muted">{t.home}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-small" title={status.home}>
                  {shortPath(status.home)}
                </code>
                <Button
                  size="sm"
                  variant="borderless"
                  icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  onClick={() => status.home && copyText(status.home)}
                >
                  {copied ? t.copied : t.copyPath}
                </Button>
              </Line>
            )}
            <Line>
              <span className="flex-1">{t.models(status.models ?? 0)}</span>
            </Line>
            <Line>
              <span className="flex-1">{t.sandbox(status.sandbox)}</span>
            </Line>
          </Section>
        )}

        {status?.running && (
          <Section title={t.running}>
            {status.running.length === 0 ? (
              <Line className="text-muted">{t.nothingRunning}</Line>
            ) : (
              status.running.map((r) => (
                <button
                  key={r.chatId}
                  type="button"
                  onClick={() => props.onOpenChat(r.chatId)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-body transition-colors hover:bg-fill"
                >
                  <Dot status={runPhase({ status: 'running' })} />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                </button>
              ))
            )}
          </Section>
        )}

        {channels && (
          <Section
            title={t.channels}
            action={
              <Button
                size="sm"
                variant="borderless"
                icon={<Settings2 className="size-3.5" />}
                onClick={props.onManageChannels}
              >
                {t.manage}
              </Button>
            }
          >
            {channels.length === 0 ? (
              <Line className="text-muted">{t.noChannels}</Line>
            ) : (
              channels.map((c) => <ChannelRow key={c.id} channel={c} onRestarted={refresh} />)
            )}
          </Section>
        )}

        {status?.activity && (
          <Section title={t.activity}>
            {status.activity.length === 0 ? (
              <Line className="text-muted">{t.noActivity}</Line>
            ) : (
              status.activity.map((e) => (
                <Line key={`${e.at}-${e.channel}-${e.text}`}>
                  <ChannelLogo id={e.channel} size={18} />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      e.kind === 'failed' || e.kind === 'trouble' ? 'text-bad-ink' : '',
                    )}
                  >
                    {e.text}
                  </span>
                  <span className="shrink-0 text-small text-muted">{ago(e.at)}</span>
                </Line>
              ))
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

type ChannelStatus = NonNullable<GatewayStatus['channels']>[number]

/**
 * Turns a channel off and on again. Switching back on is tried twice, so a passing hiccup does not leave it off;
 * `off` says it went off and stayed that way, `failed` that it never went off.
 */
export async function restartChannel(
  put: (enabled: boolean) => Promise<unknown>,
): Promise<{ outcome: 'restarted' } | { outcome: 'failed' | 'off'; error: Error }> {
  try {
    await put(false)
  } catch (err) {
    return { outcome: 'failed', error: err as Error }
  }
  try {
    await put(true).catch(() => put(true))
    return { outcome: 'restarted' }
  } catch (err) {
    return { outcome: 'off', error: err as Error }
  }
}

/** One channel's health in plain words, its own reason behind Show details, and Restart. */
function ChannelRow(props: { channel: ChannelStatus; onRestarted(): void }) {
  const t = copy.system
  const h = copy.settings.channels.health
  const c = props.channel
  const toast = useToast()
  const [restarting, setRestarting] = useState(false)
  const state = c.enabled ? c.status.state : 'off'
  const words =
    state === 'on'
      ? c.status.account
        ? copy.settings.channels.status.on(c.status.account)
        : t.channelState.on
      : state === 'retrying' || state === 'error'
        ? t.channelState[state]
        : state === 'connecting' || state === 'linking'
          ? copy.settings.channels.status[state]
          : copy.settings.channels.status.off
  // The last error is often the one the status already gives.
  const lastError = state !== 'on' && c.health.lastError !== c.status.error ? c.health.lastError : undefined
  const details = [c.status.error, lastError && h.lastError(lastError)].filter(Boolean).join('\n')
  const put = (enabled: boolean) => send('PUT', `/api/channels/${c.id}`, { enabled })
  // Left off, the row loses its Restart button, so the toast carries the way back on.
  const leftOff = (error: Error) =>
    toast(t.leftOff(c.label, error.message), 'error', {
      label: t.turnOn,
      run: () =>
        void put(true).then(() => {
          toast(t.turnedOn(c.label), 'success')
          props.onRestarted()
        }, leftOff),
    })
  const restart = async () => {
    setRestarting(true)
    const result = await restartChannel(put)
    setRestarting(false)
    props.onRestarted()
    if (result.outcome === 'restarted') toast(t.restarted(c.label), 'success')
    else if (result.outcome === 'failed') toast(t.restartFailed(c.label, result.error.message), 'error')
    else leftOff(result.error)
  }
  return (
    <div className="flex items-start gap-3 px-4 py-3 text-body">
      <ChannelLogo id={c.id} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{c.label}</span>
          <Dot status={state} />
          <span className={cn('truncate text-muted', state === 'error' && 'text-bad-ink')}>{words}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-small text-muted">
          <span>{h.lastIn(c.health.lastIn ? ago(c.health.lastIn) : h.never)}</span>
          <span>{h.lastOut(c.health.lastOut ? ago(c.health.lastOut) : h.never)}</span>
          {c.health.reconnects > 0 && <span>{h.reconnects(c.health.reconnects)}</span>}
          {c.health.owed > 0 && <span className="text-warn-ink">{h.owed(c.health.owed)}</span>}
        </div>
        {details && (
          <details className="group mt-1">
            <summary className="cursor-default list-none text-small text-muted hover:text-fg-2">
              <ChevronDown className="mr-0.5 inline size-3 -rotate-90 transition-transform group-open:rotate-0" />
              {t.showDetails}
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-small text-muted">
              {details}
            </pre>
          </details>
        )}
      </div>
      {c.enabled && (
        <Button size="sm" variant="borderless" disabled={restarting} onClick={() => void restart()}>
          {restarting ? t.restarting : t.restart}
        </Button>
      )}
    </div>
  )
}
