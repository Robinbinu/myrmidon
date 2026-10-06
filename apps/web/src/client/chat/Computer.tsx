import { Globe, Hand, Maximize2, Minimize2, MonitorSmartphone, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, browserSocket } from '../api.ts'
import { CrewCursor } from '../ui/cursor.tsx'
import { AgentAvatar, agentColor, inkOn } from '../ui/pixel.tsx'
import { Button, cn, Empty, IconButton, Pill } from '../ui/primitives.tsx'

interface TabInfo {
  agent: string
  url: string
  title: string
  controlledBy: 'agent' | 'person'
  /** The tab closed (the round ended); its last screen stays on show. */
  closed?: boolean
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
const KEYS = new Set([
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

/**
 * The agents' computers, like Manus: pick an agent with a browser open and watch its tab live, with its cursor
 * flying to what it clicks. Take control to drive the page yourself; hand it back and the agent carries on.
 */
export function Computer({ colonyId, live }: { colonyId: string; live: boolean }) {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [agent, setAgent] = useState<string>()

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

  const current = tabs.find((t) => t.agent === agent) ?? tabs[0]
  if (!current)
    return (
      <Empty icon={<MonitorSmartphone className="size-5" />} title="No browser in use">
        When an agent opens a web page you can watch it here, follow its cursor, and take control.
      </Empty>
    )
  return (
    <div className="flex flex-col gap-3 p-4">
      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.agent}
              type="button"
              onClick={() => setAgent(t.agent)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[12px] font-medium',
                t.agent === current.agent
                  ? 'border-fg bg-surface-2'
                  : 'border-line text-fg-2 hover:bg-surface-2',
              )}
            >
              <AgentAvatar name={t.agent} status="working" size={20} awake />
              {t.agent}
            </button>
          ))}
        </div>
      )}
      <LiveTab key={current.agent} colonyId={colonyId} agent={current.agent} live={live && !current.closed} />
    </div>
  )
}

function LiveTab({ colonyId, agent, live }: { colonyId: string; agent: string; live: boolean }) {
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
    ws.onclose = (e) => setError(e.reason || 'The session ended. This is the last screen.')
    return () => {
      clearTimeout(clickTimer)
      ws.close()
    }
  }, [colonyId, agent])

  // Frames come in CSS pixels of the agent's viewport; the screen scales them to fit the panel.
  const frameWidth = frame?.width
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
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !controlling && setFull(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
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
          <div className="text-[13px] font-semibold">{agent}’s computer</div>
          <div className="flex items-center gap-1 truncate text-[11.5px] text-muted">
            <Globe className="size-3 shrink-0" /> {page.title || page.url || 'blank page'}
          </div>
        </div>
        {controlling ? (
          <Pill tone="warn">you have control</Pill>
        ) : live ? (
          <Pill tone="work">agent browsing</Pill>
        ) : (
          <Pill>ended</Pill>
        )}
        {live && (
          <Button
            size="sm"
            variant={controlling ? 'primary' : 'secondary'}
            onClick={() => send({ type: 'control', by: controlling ? 'agent' : 'person' })}
            icon={controlling ? <Undo2 className="size-3.5" /> : <Hand className="size-3.5" />}
          >
            {controlling ? `Hand back to ${agent}` : 'Take control'}
          </Button>
        )}
        <IconButton
          label={full ? 'Exit full screen' : 'Full screen'}
          size="sm"
          onClick={() => setFull(!full)}
        >
          {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconButton>
      </div>
      <div className="truncate rounded-lg border border-line bg-surface-2 px-2.5 py-1 font-mono text-[11.5px] text-fg-2">
        {page.url || 'about:blank'}
      </div>
      <div
        ref={screen}
        tabIndex={controlling ? 0 : -1}
        role="img"
        aria-label={`${agent}'s browser: ${page.title || page.url}`}
        className={cn(
          'relative mx-auto w-full overflow-hidden rounded-xl border bg-black outline-none',
          full && 'max-w-[calc((100dvh-140px)*1.6)]',
          controlling ? 'cursor-default border-warn/60 ring-2 ring-warn/25' : 'border-line',
        )}
        style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : '16 / 10' }}
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
          e.preventDefault()
          if (KEYS.has(e.key)) send({ type: 'key', key: e.key })
          else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) send({ type: 'text', text: e.key })
        }}
      >
        {frame ? (
          <img
            alt=""
            draggable={false}
            src={`data:image/jpeg;base64,${frame.data}`}
            className="pointer-events-none absolute inset-0 size-full select-none object-contain"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-[12.5px] text-white/50">
            {error ?? 'Connecting to the browser…'}
          </div>
        )}
        {!controlling && frame && highlight && (
          <div
            className="pointer-events-none absolute rounded-[4px] border-2 transition-all duration-200"
            style={{
              left: highlight.x * scale - 3,
              top: highlight.y * scale - 3,
              width: highlight.width * scale + 6,
              height: highlight.height * scale + 6,
              borderColor: agentColor(agent),
              background: `${agentColor(agent)}1a`,
            }}
          >
            {highlight.label && (
              <span
                className="absolute -top-5 left-0 max-w-[240px] truncate rounded px-1.5 py-px text-[10.5px] font-medium"
                style={{ background: agentColor(agent), color: inkOn(agentColor(agent)) }}
              >
                {highlight.label}
              </span>
            )}
          </div>
        )}
        {!controlling && frame && (
          <div className="pointer-events-none absolute inset-0">
            <CrewCursor
              name={agent}
              color={agentColor(agent)}
              x={cursor.x * scale}
              y={cursor.y * scale}
              clicking={cursor.clicking}
            />
          </div>
        )}
      </div>
      {controlling && (
        <p className="text-[12px] text-muted">
          Click and type in the page as usual. {agent} waits until you hand it back.
        </p>
      )}
      {error && frame && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  )
}
