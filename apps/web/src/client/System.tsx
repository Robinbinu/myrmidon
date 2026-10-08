import { CircleAlert, CircleCheck, RefreshCw, Settings2, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { send } from './api.ts'
import { copy } from './copy.ts'
import { useStatus } from './status.tsx'
import { ChannelLogo } from './ui/ChannelLogo.tsx'
import { ago } from './ui/hooks.ts'
import { Button, cn } from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'

/** A channel's connection state as a dot colour, after Hermes's `platformStatusTone`. */
export function stateTone(state: string): 'ok' | 'warn' | 'bad' | 'off' {
  if (state === 'on') return 'ok'
  if (state === 'error') return 'bad'
  if (state === 'off') return 'off'
  return 'warn'
}

export function StateDot(props: { state: string; className?: string }) {
  const tone = stateTone(props.state)
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : 'bg-muted/50',
        props.className,
      )}
    />
  )
}

function Section(props: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">{props.title}</h2>
        {props.action}
      </header>
      <div className="divide-y divide-line">{props.children}</div>
    </section>
  )
}

const Line = (props: { children: ReactNode; className?: string }) => (
  <div className={cn('flex items-center gap-3 px-4 py-2.5 text-[13px]', props.className)}>
    {props.children}
  </div>
)

/**
 * How this gateway is doing, in one place (Hermes's System panel, OpenClaw's Connection and Channels pages): the
 * gateway itself, models and the sandbox, what is running, each channel's health, and recent activity.
 */
export function SystemPage(props: { onManageChannels(): void; onOpenChat(chatId: string): void }) {
  const t = copy.system
  const { status, offline, ping, refresh } = useStatus()
  const toast = useToast()
  const restart = async (id: string) => {
    try {
      await send('PUT', `/api/channels/${id}`, { enabled: false })
      await send('PUT', `/api/channels/${id}`, { enabled: true })
      refresh()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
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
            <h1 className="text-[20px] font-semibold tracking-tight">{t.title}</h1>
            <p className="text-[13px] text-muted">{headline}</p>
          </div>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={refresh}>
            {t.refresh}
          </Button>
        </div>

        {!!status?.problems.length && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn-ink">
            {status.problems.map((p) => (
              <div key={p.kind === 'channel' ? p.channel : p.kind}>
                {p.kind === 'no-models' ? t.problems.noModels : t.problems.channel(p.label, p.error)}
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
              <span className="flex-1 text-muted">{t.up(new Date(status.startedAt).toLocaleString())}</span>
            </Line>
            {status.home && (
              <Line>
                <span className="text-muted">{t.home}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{status.home}</code>
              </Line>
            )}
            <Line>
              <span className="flex-1">{t.models(status.models ?? 0)}</span>
            </Line>
            <Line>
              <span className="flex-1">{t.sandbox(status.sandbox ?? 'unknown')}</span>
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
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-fill"
                >
                  <StateDot state="connecting" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                </button>
              ))
            )}
          </Section>
        )}

        {status?.channels && (
          <Section
            title={t.channels}
            action={
              <Button
                size="sm"
                variant="ghost"
                icon={<Settings2 className="size-3.5" />}
                onClick={props.onManageChannels}
              >
                {t.manage}
              </Button>
            }
          >
            {status.channels.length === 0 ? (
              <Line className="text-muted">{t.noChannels}</Line>
            ) : (
              status.channels.map((c) => {
                const h = copy.settings.channels.health
                const state = c.enabled ? c.status.state : 'off'
                return (
                  <div key={c.id} className="flex items-start gap-3 px-4 py-3 text-[13px]">
                    <ChannelLogo id={c.id} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{c.label}</span>
                        <StateDot state={state} />
                        <span className="truncate text-muted">
                          {c.status.account ?? c.status.error ?? copy.settings.channels.status.off}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-muted">
                        <span>{h.lastIn(c.health.lastIn ? ago(c.health.lastIn) : h.never)}</span>
                        <span>{h.lastOut(c.health.lastOut ? ago(c.health.lastOut) : h.never)}</span>
                        {c.health.reconnects > 0 && <span>{h.reconnects(c.health.reconnects)}</span>}
                        {c.health.owed > 0 && <span className="text-warn-ink">{h.owed(c.health.owed)}</span>}
                      </div>
                      {c.health.lastError && state !== 'on' && (
                        <div className="mt-0.5 text-[12px] text-bad-ink">
                          {h.lastError(c.health.lastError)}
                        </div>
                      )}
                    </div>
                    {c.enabled && (
                      <Button size="sm" variant="ghost" onClick={() => void restart(c.id)}>
                        {t.restart}
                      </Button>
                    )}
                  </div>
                )
              })
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
                  <span className="shrink-0 text-[12px] text-muted">{ago(e.at)}</span>
                </Line>
              ))
            )}
          </Section>
        )}
      </div>
    </div>
  )
}
