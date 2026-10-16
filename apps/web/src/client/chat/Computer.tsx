import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { ChevronLeft, ChevronRight, Hand, Maximize2, Minimize2, Radio, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, browserSocket, keyframeImage } from '../api.ts'
import { copy } from '../copy.ts'
import { CrewCursor } from '../ui/cursor.tsx'
import { clock } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { AgentAvatar, agentColor, inkOn } from '../ui/pixel.tsx'
import { isMac } from '../ui/platform.ts'
import { Badge, Button, cn, Empty, IconButton } from '../ui/primitives.tsx'
import { comboLabel, matchCombo } from '../ui/shortcuts.ts'
import { type Activity, activityOf } from './activity.ts'

interface TabInfo {
  agent: string
  url: string
  title: string
  controlledBy: 'agent' | 'person'
  /** The tab closed (the round ended); its last screen stays on show. */
  closed?: boolean
  /** The agent has used only its terminal and files. */
  noBrowser?: boolean
}

type LiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'cursor'; x: number; y: number; action: 'move' | 'click' | 'type' }
  | { type: 'page'; url: string; title: string }
  | { type: 'control'; by: 'agent' | 'person' }
  | { type: 'error'; message: string }
  | { type: 'highlight'; box: Box | null }

interface Box {
  x: number
  y: number
  width: number
  height: number
  label: string
}

/** Keys sent as key presses; anything else that is one character is typed as text. */
export const KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/** While the person drives the page every other key goes to it, so this one leaves it (Apple's "cancel" chord). */
export const LEAVE_PAGE = 'mod+.'

/**
 * The agents' computers, like Manus: pick an agent with a browser open and watch its tab live, with its cursor
 * flying to what it clicks. Take control to drive the page yourself; hand it back and the agent carries on.
 */
export type Keyframe = EventPayloads['browser/keyframe'] & { seq: number; time: string }

/** Every browser keyframe in the log, per agent, oldest first. */
export function keyframesOf(events: readonly MyrEvent[]): Map<string, Keyframe[]> {
  const out = new Map<string, Keyframe[]>()
  for (const e of events) {
    if (e.type !== 'browser/keyframe') continue
    const p = e.payload as EventPayloads['browser/keyframe']
    const list = out.get(p.agent) ?? []
    list.push({ ...p, seq: e.seq, time: e.time })
    out.set(p.agent, list)
  }
  return out
}

/** The view an agent's computer is showing: one of its kinds of activity, or whatever it did last. */
type Mode = 'follow' | Activity['kind']

const MODE_LABEL: Record<Activity['kind'], string> = {
  browser: copy.computer.modes.browser,
  terminal: copy.computer.modes.terminal,
  editor: copy.computer.modes.editor,
}

export function Computer({
  colonyId,
  live,
  events,
  focus,
}: {
  colonyId: string
  live: boolean
  events: readonly MyrEvent[]
  /** An agent to show first, e.g. one waiting for the person to sign in. */
  focus?: string
}) {
  const keyframes = useMemo(() => keyframesOf(events), [events])
  const activity = useMemo(() => activityOf(events), [events])
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [agent, setAgent] = useState<string>()
  useEffect(() => {
    if (focus) setAgent(focus)
  }, [focus])

  useEffect(() => {
    let stop = false
    const load = () =>
      api<{ tabs: TabInfo[] }>(`/api/colonies/${colonyId}/browsers`)
        // Tabs close when the round ends; keep showing the last ones instead of an empty panel.
        .then(
          (r) =>
            !stop && setTabs((prev) => (r.tabs.length ? r.tabs : prev.map((t) => ({ ...t, closed: true })))),
        )
        .catch(() => {})
    void load()
    const t = live ? setInterval(load, 2500) : undefined
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [colonyId, live])

  // Agents with a live tab, plus any whose tab has closed but left a recording.
  const known: TabInfo[] = [
    ...tabs,
    ...[...keyframes.keys()]
      .filter((a) => !tabs.some((t) => t.agent === a))
      .map((a) => ({ agent: a, url: '', title: '', controlledBy: 'agent' as const, closed: true })),
  ]
  for (const a of activity.keys())
    if (!known.some((t) => t.agent === a))
      known.push({ agent: a, url: '', title: '', controlledBy: 'agent', closed: true, noBrowser: true })
  const current = known.find((t) => t.agent === agent) ?? known[0]
  if (!current)
    return (
      <Empty icon={<FEATURE_ICONS.computer className="size-5" />} title={copy.computer.emptyTitle}>
        {copy.computer.emptyBody}
      </Empty>
    )
  return (
    <div className="flex flex-col gap-3 p-4">
      {known.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {known.map((t) => (
            <button
              key={t.agent}
              type="button"
              onClick={() => setAgent(t.agent)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-small font-medium',
                t.agent === current.agent ? 'border-fg bg-fill' : 'border-line text-fg-2 hover:bg-fill',
              )}
            >
              <AgentAvatar name={t.agent} status="working" size={20} awake />
              {t.agent}
            </button>
          ))}
        </div>
      )}
      <AgentScreen
        key={current.agent}
        colonyId={colonyId}
        tab={current}
        live={live}
        frames={keyframes.get(current.agent) ?? []}
        activity={activity.get(current.agent) ?? []}
      />
    </div>
  )
}

/** One agent's computer: its browser, terminal, or editor, following whichever it used last unless pinned. */
function AgentScreen(props: {
  colonyId: string
  tab: TabInfo
  live: boolean
  frames: readonly Keyframe[]
  activity: readonly Activity[]
}) {
  const [mode, setMode] = useState<Mode>('follow')
  const hasBrowser = !props.tab.noBrowser || props.frames.length > 0
  const kinds = (['browser', 'terminal', 'editor'] as const).filter((k) =>
    k === 'browser' ? hasBrowser : props.activity.some((a) => a.kind === k),
  )
  const latest = props.activity.at(-1)?.kind ?? (hasBrowser ? 'browser' : undefined)
  const shown = mode === 'follow' ? latest : mode
  return (
    <div className="flex flex-col gap-2">
      {kinds.length > 1 && (
        <div className="flex items-center gap-1 rounded-xl border border-line p-0.5 text-small">
          {(['follow', ...kinds] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded-md px-2 py-1 font-medium transition-colors',
                mode === m
                  ? 'bg-segment-on text-fg shadow-[0_0.5px_2px_rgb(0_0_0/0.25)]'
                  : 'text-muted hover:text-fg',
              )}
            >
              {m === 'follow'
                ? `${copy.computer.follow}${latest ? ` · ${MODE_LABEL[latest]}` : ''}`
                : MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      {shown === 'browser' && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="push"
            icon={<FEATURE_ICONS.browser className="size-3.5" />}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('myr:open-view', { detail: { view: 'browser', agent: props.tab.agent } }),
              )
            }
          >
            {copy.computer.place.openInBrowser}
          </Button>
        </div>
      )}
      {shown === 'browser' && (
        <LiveTab
          colonyId={props.colonyId}
          agent={props.tab.agent}
          live={props.live && !props.tab.closed}
          frames={props.frames}
        />
      )}
      {shown === 'terminal' && (
        <TerminalScreen agent={props.tab.agent} activity={props.activity} live={props.live} />
      )}
      {shown === 'editor' && <EditorScreen agent={props.tab.agent} activity={props.activity} />}
    </div>
  )
}

/** The agent's recent shell commands and their output, newest at the bottom, like a terminal window. */
function TerminalScreen(props: { agent: string; activity: readonly Activity[]; live: boolean }) {
  const runs = props.activity
    .filter((a): a is Extract<Activity, { kind: 'terminal' }> => a.kind === 'terminal')
    .slice(-20)
  const end = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new output as it lands
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [runs.length, runs.at(-1)?.output])
  return (
    <div className="flex flex-col gap-1.5">
      <ScreenTitle agent={props.agent} what={copy.computer.terminal} />
      <div className="max-h-[60vh] min-h-48 overflow-auto rounded-lg border border-line bg-[color:var(--terminal-bg)] p-3 font-mono text-footnote leading-relaxed text-[color:var(--terminal-text)]">
        {runs.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and append-only
          <div key={i} className="mb-2">
            <div className="text-[color:var(--terminal-command)]">
              <span className="select-none text-[color:var(--terminal-muted)]">$ </span>
              {r.command}
            </div>
            {r.output === undefined ? (
              props.live &&
              i === runs.length - 1 && (
                <div className="text-[color:var(--terminal-muted)]">{copy.computer.running}</div>
              )
            ) : (
              <pre
                className={cn(
                  'm-0 whitespace-pre-wrap break-words',
                  r.ok === false && 'text-[color:var(--terminal-error)]',
                )}
              >
                {r.output.length > 4_000
                  ? `${r.output.slice(0, 4_000)}
…`
                  : r.output}
              </pre>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  )
}

/** The file the agent last wrote or edited; an edit shows what it replaced. */
function EditorScreen(props: { agent: string; activity: readonly Activity[] }) {
  const last = props.activity
    .filter((a): a is Extract<Activity, { kind: 'editor' }> => a.kind === 'editor')
    .at(-1)
  if (!last) return null
  const lines = last.edit
    ? [
        ...last.edit.old.split('\n').map((t) => ({ t, kind: 'del' as const })),
        ...last.edit.new.split('\n').map((t) => ({ t, kind: 'add' as const })),
      ]
    : (last.content ?? copy.computer.publishedFromScratch)
        .split('\n')
        .map((t) => ({ t, kind: 'same' as const }))
  return (
    <div className="flex flex-col gap-1.5">
      <ScreenTitle
        agent={props.agent}
        what={`${copy.computer.editor(last.path)}${last.edit ? copy.computer.edited : ''}`}
      />
      <pre className="m-0 max-h-[60vh] min-h-48 overflow-auto rounded-lg border border-line bg-code py-2 font-mono text-footnote leading-[1.6]">
        {lines.slice(0, 600).map((l, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            key={i}
            className={cn('flex', l.kind === 'add' && 'bg-ok-soft', l.kind === 'del' && 'bg-bad-soft')}
          >
            <span className="w-10 shrink-0 select-none pr-3 text-right text-muted/70">
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : i + 1}
            </span>
            <span className="whitespace-pre pr-4">{l.t}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

function ScreenTitle(props: { agent: string; what: string }) {
  return (
    <div className="flex items-center gap-2">
      <AgentAvatar name={props.agent} status="working" size={26} awake />
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold">{copy.computer.agentsComputer(props.agent)}</div>
        <div className="truncate text-footnote text-muted">{props.what}</div>
      </div>
    </div>
  )
}

export function LiveTab({
  colonyId,
  agent,
  live,
  frames,
}: {
  colonyId: string
  agent: string
  live: boolean
  frames: readonly Keyframe[]
}) {
  // 'live' follows the agent; a number replays that keyframe. A finished session opens on its last step.
  const [at, setAt] = useState<number | 'live'>(live ? 'live' : Math.max(0, frames.length - 1))
  const [still, setStill] = useState<string>()
  const replaying = at !== 'live' ? frames[at] : undefined
  useEffect(() => {
    if (!live && at === 'live' && frames.length > 0) setAt(frames.length - 1)
  }, [live, at, frames.length])
  const stillBlob = replaying?.blob
  useEffect(() => {
    if (!stillBlob) return
    let url: string | undefined
    let stop = false
    keyframeImage(colonyId, stillBlob)
      .then((u) => {
        if (stop) URL.revokeObjectURL(u)
        else {
          url = u
          setStill(u)
        }
      })
      .catch(() => {})
    return () => {
      stop = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [colonyId, stillBlob])
  const [frame, setFrame] = useState<{ data: string; width: number; height: number }>()
  const [page, setPage] = useState({ url: '', title: '' })
  const [cursor, setCursor] = useState({ x: 640, y: 400, clicking: false })
  const [by, setBy] = useState<'agent' | 'person'>('agent')
  const [error, setError] = useState<string>()
  const [scale, setScale] = useState(1)
  const [highlight, setHighlight] = useState<Box | null>(null)
  const [full, setFull] = useState(false)
  const socket = useRef<WebSocket>(undefined)
  const screen = useRef<HTMLDivElement>(null)
  const handBack = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const ws = browserSocket(colonyId, agent)
    socket.current = ws
    let clickTimer: ReturnType<typeof setTimeout> | undefined
    ws.onmessage = (msg) => {
      const e = JSON.parse(String(msg.data)) as LiveEvent
      if (e.type === 'frame') setFrame(e)
      else if (e.type === 'page') setPage(e)
      else if (e.type === 'control') setBy(e.by)
      else if (e.type === 'error') setError(e.message)
      else if (e.type === 'highlight') setHighlight(e.box)
      else if (e.type === 'cursor') {
        setCursor({ x: e.x, y: e.y, clicking: e.action === 'click' })
        clearTimeout(clickTimer)
        if (e.action === 'click')
          clickTimer = setTimeout(() => setCursor((c) => ({ ...c, clicking: false })), 450)
      }
    }
    ws.onclose = (e) => setError(e.reason || copy.computer.sessionEnded)
    return () => {
      clearTimeout(clickTimer)
      ws.close()
    }
  }, [colonyId, agent])

  // Frames come in CSS pixels of the agent's viewport; the screen scales them to fit the panel.
  const frameWidth = replaying?.width ?? frame?.width
  useEffect(() => {
    const el = screen.current
    if (!el || !frameWidth) return
    const fit = () => setScale(el.clientWidth / frameWidth)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [frameWidth])

  useEffect(() => {
    if (!full) return
    // Escape typed into the page is the page's; anywhere else it leaves full screen.
    const esc = (e: KeyboardEvent) =>
      e.key === 'Escape' && !screen.current?.contains(e.target as Node) && setFull(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  })

  const shownBox = replaying ? replaying.box : highlight
  const shownLabel = replaying ? replaying.label : highlight?.label
  const step = (d: number) =>
    setAt((cur) => {
      const i = cur === 'live' ? frames.length - 1 + (d < 0 ? 1 : 0) : cur
      const next = i + d
      if (next >= frames.length) return live ? 'live' : frames.length - 1
      return Math.max(0, next)
    })

  const send = (msg: object) => socket.current?.readyState === 1 && socket.current.send(JSON.stringify(msg))
  const controlling = by === 'person'
  const point = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        full && 'fixed inset-0 z-[60] overflow-auto bg-surface px-[max(16px,4vw)] py-4',
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={agent} status={controlling ? 'idle' : 'working'} size={26} awake />
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold">{copy.computer.agentsComputer(agent)}</div>
          <div className="flex items-center gap-1 truncate text-footnote text-muted">
            <FEATURE_ICONS.web className="size-3 shrink-0" />{' '}
            {(replaying ? replaying.title || replaying.url : page.title || page.url) ||
              copy.computer.blankPage}
          </div>
        </div>
        {controlling ? (
          <Badge tone="warn">{copy.computer.youHaveControl}</Badge>
        ) : live ? (
          <Badge tone="work">{copy.computer.agentBrowsing}</Badge>
        ) : (
          <Badge>{copy.computer.ended}</Badge>
        )}
        {live && (
          <Button
            ref={handBack}
            size="sm"
            variant={controlling ? 'primary' : 'push'}
            onClick={() => send({ type: 'control', by: controlling ? 'agent' : 'person' })}
            icon={controlling ? <Undo2 className="size-3.5" /> : <Hand className="size-3.5" />}
          >
            {controlling ? copy.computer.handBack(agent) : copy.computer.takeControl}
          </Button>
        )}
        <IconButton
          label={full ? copy.computer.exitFullScreen : copy.computer.fullScreen}
          size="sm"
          onClick={() => setFull(!full)}
        >
          {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconButton>
      </div>
      <div className="truncate rounded-xl border border-line bg-fill px-2.5 py-1 font-mono text-footnote text-fg-2">
        {(replaying ? replaying.url : page.url) || 'about:blank'}
      </div>
      <p className="text-footnote text-muted">{copy.computer.ownBrowser}</p>
      <div
        ref={screen}
        tabIndex={controlling ? 0 : -1}
        role="img"
        aria-label={copy.computer.browserLabel(agent, page.title || page.url)}
        className={cn(
          'relative mx-auto w-full overflow-hidden rounded-lg border bg-black outline-none',
          full && 'max-w-[calc((100dvh-140px)*1.6)]',
          controlling ? 'cursor-default border-warn/60 ring-2 ring-warn/25' : 'border-line',
        )}
        style={{
          aspectRatio: replaying
            ? `${replaying.width} / ${replaying.height}`
            : frame
              ? `${frame.width} / ${frame.height}`
              : '16 / 10',
        }}
        onMouseMove={(e) => controlling && send({ type: 'mouse', action: 'move', ...point(e) })}
        onMouseDown={(e) => {
          if (!controlling) return
          e.currentTarget.focus()
          send({ type: 'mouse', action: 'down', ...point(e), button: e.button === 2 ? 'right' : 'left' })
        }}
        onMouseUp={(e) =>
          controlling &&
          send({ type: 'mouse', action: 'up', ...point(e), button: e.button === 2 ? 'right' : 'left' })
        }
        onWheel={(e) =>
          controlling && send({ type: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })
        }
        onKeyDown={(e) => {
          if (!controlling) return
          if (matchCombo(LEAVE_PAGE, e)) {
            e.preventDefault()
            handBack.current?.focus()
            return
          }
          // ⌘ and Ctrl shortcuts stay this app's and the browser's: paste (below), copy, a password manager's.
          // AltGr reports Ctrl too on Windows, but it types a character ("@", "{"), which goes to the page.
          if ((e.metaKey || e.ctrlKey) && !e.getModifierState('AltGraph')) return
          e.preventDefault()
          if (KEYS.has(e.key)) send({ type: 'key', key: e.key })
          else if (e.key.length === 1) send({ type: 'text', text: e.key })
        }}
        onPaste={(e) => {
          if (!controlling) return
          e.preventDefault()
          const text = e.clipboardData.getData('text/plain')
          if (text) send({ type: 'paste', text })
        }}
      >
        {replaying ? (
          still && (
            <img
              alt=""
              draggable={false}
              src={still}
              className="pointer-events-none absolute inset-0 size-full select-none object-contain"
            />
          )
        ) : frame ? (
          <img
            alt=""
            draggable={false}
            src={`data:image/jpeg;base64,${frame.data}`}
            className="pointer-events-none absolute inset-0 size-full select-none object-contain"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-callout text-white/50">
            {error ?? copy.computer.connecting}
          </div>
        )}
        {!controlling && (replaying || frame) && (replaying ? replaying.box : highlight) && (
          <div
            className="pointer-events-none absolute rounded-sm border-2 transition-all duration-200"
            style={{
              left: (shownBox?.x ?? 0) * scale - 3,
              top: (shownBox?.y ?? 0) * scale - 3,
              width: (shownBox?.width ?? 0) * scale + 6,
              height: (shownBox?.height ?? 0) * scale + 6,
              borderColor: agentColor(agent),
              background: `${agentColor(agent)}1a`,
            }}
          >
            {shownLabel && (
              <span
                className="absolute -top-5 left-0 max-w-[240px] truncate rounded-sm px-1.5 py-px text-caption font-medium"
                style={{ background: agentColor(agent), color: inkOn(agentColor(agent)) }}
              >
                {shownLabel}
              </span>
            )}
          </div>
        )}
        {!controlling && (replaying || frame) && (
          <div className="pointer-events-none absolute inset-0">
            <CrewCursor
              name={agent}
              color={agentColor(agent)}
              x={(replaying?.cursor?.x ?? cursor.x) * scale}
              y={(replaying?.cursor?.y ?? cursor.y) * scale}
              clicking={cursor.clicking}
              avatar={<AgentAvatar name={agent} status="working" size={16} awake />}
            />
          </div>
        )}
      </div>
      {frames.length > 0 && !controlling && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <IconButton
              label={copy.computer.previousStep}
              size="sm"
              onClick={() => step(-1)}
              disabled={at === 0}
            >
              <ChevronLeft className="size-3.5" />
            </IconButton>
            <div className="flex h-6 min-w-0 flex-1 items-center gap-[3px] overflow-x-auto">
              {frames.map((f, i) => (
                <button
                  key={f.seq}
                  type="button"
                  onClick={() => setAt(i)}
                  title={`${copy.computer.actions[f.action]}${f.label ? ` · ${f.label}` : ''} · ${clock(f.time, true)}`}
                  aria-label={copy.computer.stepLabel(i + 1, copy.computer.actions[f.action])}
                  // The full row's height is the target; the bar drawn inside stays 16px.
                  className="group flex h-6 min-w-[6px] flex-1 items-center"
                >
                  <span
                    className={cn(
                      'h-4 w-full rounded-md transition-colors',
                      at === i
                        ? 'bg-fg'
                        : f.action === 'open'
                          ? 'bg-fg-2/50 group-hover:bg-fg-2'
                          : 'bg-fill-strong group-hover:bg-fg-2/60',
                    )}
                  />
                </button>
              ))}
            </div>
            <IconButton
              label={copy.computer.nextStep}
              size="sm"
              onClick={() => step(1)}
              disabled={at === 'live' || (!live && at === frames.length - 1)}
            >
              <ChevronRight className="size-3.5" />
            </IconButton>
            {live && (
              <Button
                size="sm"
                variant={at === 'live' ? 'primary' : 'push'}
                onClick={() => setAt('live')}
                icon={<Radio className="size-3.5" />}
              >
                {copy.computer.live}
              </Button>
            )}
          </div>
          <div className="truncate text-footnote text-muted">
            {replaying
              ? `${copy.computer.stepOf((at as number) + 1, frames.length)} · ${copy.computer.actions[replaying.action]}${replaying.label ? ` · ${replaying.label}` : ''} · ${clock(replaying.time, true)}`
              : copy.computer.recorded(frames.length, agent)}
          </div>
        </div>
      )}
      {controlling && (
        <p className="text-small text-muted">
          {copy.computer.controlHint(agent, comboLabel('mod+v', isMac), comboLabel(LEAVE_PAGE, isMac))}
        </p>
      )}
      {error && frame && <p className="text-small text-bad-ink">{error}</p>}
    </div>
  )
}
