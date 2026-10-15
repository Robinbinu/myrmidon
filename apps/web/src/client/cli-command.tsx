import { useCallback, useEffect, useRef, useState } from 'react'
import { api, send } from './api.ts'
import { copy } from './copy.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import { Button, cn } from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'

/** What /api/cli-command says about the myrmidon command (packages/runtime/src/cli-command.ts CliCommandStatus). */
export interface CliCommandView {
  state: 'unavailable' | 'missing' | 'installed' | 'broken' | 'elsewhere' | 'taken'
  link: string
  target?: string
  reason?: string
  profileBlock: boolean
}

const t = copy.cliCommand

/** The status line for a state: where it is installed, what is wrong with the link, or why it cannot be. */
export function cliCommandText(view: CliCommandView): string {
  switch (view.state) {
    case 'unavailable':
      return view.reason ?? ''
    case 'missing':
      return t.status.missing
    case 'installed':
      return t.status.installed(view.link)
    case 'broken':
      return t.status.broken(view.link)
    case 'elsewhere':
      return t.status.elsewhere(view.link, view.target ?? '')
    case 'taken':
      return t.status.taken(view.link)
  }
}

/** The command's status, and installing or removing it; `onChange` hears each status the server returns. */
export function useCliCommand(onChange?: (view: CliCommandView) => void) {
  const toast = useToast()
  const [view, setView] = useState<CliCommandView>()
  const [busy, setBusy] = useState<'install' | 'remove'>()
  // The latest listener, so a parent passing a new function each render does not ask the server again.
  const heard = useRef(onChange)
  heard.current = onChange
  const take = useCallback((next: CliCommandView) => {
    setView(next)
    heard.current?.(next)
  }, [])
  const refresh = useCallback(() => {
    api<CliCommandView>('/api/cli-command')
      .then(take)
      .catch(() => {})
  }, [take])
  useEffect(refresh, [refresh])
  const act = async (kind: 'install' | 'remove') => {
    setBusy(kind)
    const before = view
    try {
      const next = await send<CliCommandView>(kind === 'install' ? 'POST' : 'DELETE', '/api/cli-command')
      take(next)
      if (kind === 'remove') toast(t.removed, 'success')
      else toast(next.profileBlock && !before?.profileBlock ? t.profileAdded : t.installed, 'success')
      return true
    } catch (err) {
      toast((err as Error).message, 'error')
      refresh()
      return false
    } finally {
      setBusy(undefined)
    }
  }
  return { view, busy, install: () => act('install'), remove: () => act('remove') }
}

/** The status line and its Install, Repair or Remove buttons, as Settings → General and the setup step show them. */
export function CliCommandControls(props: { command: ReturnType<typeof useCliCommand> }) {
  const { view, busy, install, remove } = props.command
  const ours = view?.state === 'installed' || view?.state === 'broken' || view?.state === 'elsewhere'
  const installLabel =
    view?.state === 'broken' ? t.repair : view?.state === 'elsewhere' ? t.replace : t.install
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p
        role="status"
        data-state={view?.state}
        className={cn(
          'min-w-0 flex-1 text-callout break-words',
          view?.state === 'broken' || view?.state === 'taken' ? 'text-bad-ink' : 'text-muted',
        )}
      >
        {view ? cliCommandText(view) : t.checking}
      </p>
      {(!view || view.state === 'missing' || view.state === 'broken' || view.state === 'elsewhere') && (
        <Button
          size="sm"
          disabled={!view || !!busy}
          loading={busy === 'install'}
          icon={<FEATURE_ICONS.cliCommand className="size-3.5" />}
          onClick={() => void install()}
        >
          {installLabel}
        </Button>
      )}
      {ours && (
        <Button size="sm" disabled={!!busy} loading={busy === 'remove'} onClick={() => void remove()}>
          {t.remove}
        </Button>
      )}
    </div>
  )
}
