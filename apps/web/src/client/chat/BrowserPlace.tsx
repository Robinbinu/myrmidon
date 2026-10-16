import type { MyrEvent } from '@myrmidon/protocol'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { AgentAvatar } from '../ui/pixel.tsx'
import { cn, Empty } from '../ui/primitives.tsx'
import { browsingNow, siteOf } from './activity.ts'
import { BrowserView } from './BrowserView.tsx'
import { keyframesOf, LiveTab } from './Computer.tsx'

interface AgentTab {
  agent: string
  url: string
  title: string
  controlledBy: 'agent' | 'person'
}

/**
 * The one place for browsers in the chat: the tabs of the agents browsing here, each the agent's own tab live (take
 * control, hand back), and, for a full-access device, the person's own browser (BrowserView). An agent busy in its
 * browser shows so on its tab.
 */
export function BrowserPlace(props: {
  colonyId: string
  live: boolean
  events: readonly MyrEvent[]
  fullAccess: boolean
  /** An agent whose tab to show first, e.g. one waiting for the person to sign in. */
  focus?: string
  /** A link to open in the person's own browser. */
  open?: { url: string; at: number }
}) {
  const keyframes = useMemo(() => keyframesOf(props.events), [props.events])
  const busy = useMemo(() => browsingNow(props.events, props.live), [props.events, props.live])
  const [tabs, setTabs] = useState<AgentTab[]>([])
  const [shown, setShown] = useState<string | undefined>(props.focus)
  useEffect(() => {
    if (props.focus) setShown(props.focus)
  }, [props.focus])
  useEffect(() => {
    if (props.open) setShown('')
  }, [props.open])
  useEffect(() => {
    let stop = false
    const load = () =>
      api<{ tabs: AgentTab[] }>(`/api/colonies/${props.colonyId}/browsers`)
        .then((r) => !stop && setTabs(r.tabs))
        .catch(() => {})
    void load()
    const t = props.live ? setInterval(load, 2500) : undefined
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [props.colonyId, props.live])
  // Agents with a tab open now, then any whose tab closed but left a recording.
  const agents = [
    ...tabs.map((t) => t.agent),
    ...[...keyframes.keys()].filter((a) => !tabs.some((t) => t.agent === a)),
  ]
  // '' is the person's own browser.
  const current =
    shown === '' && props.fullAccess
      ? ''
      : (agents.find((a) => a === shown) ?? agents[0] ?? (props.fullAccess ? '' : undefined))
  return (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label={copy.computer.place.label}
        className="flex flex-wrap gap-1.5 border-b border-line p-2"
      >
        {agents.map((a) => {
          const tab = tabs.find((t) => t.agent === a)
          const site = busy.get(a) ?? (tab?.url ? siteOf(tab.url) : '')
          return (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={current === a}
              onClick={() => setShown(a)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-small font-medium',
                current === a ? 'border-fg bg-fill' : 'border-line text-fg-2 hover:bg-fill',
              )}
            >
              <AgentAvatar name={a} status={busy.has(a) ? 'working' : 'idle'} size={20} awake />
              <span>{a}</span>
              <span className="text-muted">
                {busy.has(a) ? copy.computer.place.browsing(site) : tab ? copy.computer.place.idle : ''}
              </span>
              {busy.has(a) && (
                <span className="inline-flex items-center gap-1 text-caption text-accent-fg">
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
                  {copy.computer.place.live}
                </span>
              )}
            </button>
          )
        })}
        {props.fullAccess && (
          <button
            type="button"
            role="tab"
            aria-selected={current === ''}
            onClick={() => setShown('')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-small font-medium',
              current === '' ? 'border-fg bg-fill' : 'border-line text-fg-2 hover:bg-fill',
            )}
          >
            <FEATURE_ICONS.browser className="size-3.5" />
            {copy.computer.place.mine}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {current === undefined && (
          <Empty icon={<FEATURE_ICONS.browser className="size-5" />} title={copy.workspace.views.browser}>
            {copy.computer.place.empty}
          </Empty>
        )}
        {current === '' && <BrowserView {...(props.open ? { open: props.open } : {})} />}
        {current && (
          <div className="p-4">
            <LiveTab
              key={current}
              colonyId={props.colonyId}
              agent={current}
              live={props.live && tabs.some((t) => t.agent === current)}
              frames={keyframes.get(current) ?? []}
            />
          </div>
        )}
      </div>
    </div>
  )
}
