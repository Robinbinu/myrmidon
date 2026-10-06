import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ChatSummary, type ColonySummary, type ModelOption, post, type TeamConfig } from './api.ts'
import { ColonyScreen } from './ColonyScreen.tsx'
import { Compare } from './Compare.tsx'
import { Composer } from './chat/Composer.tsx'
import { RoundView } from './chat/RoundView.tsx'

const CONFIG_KEY = 'myr-team-config'
const EXAMPLES = [
  'Research the three most popular Rust web frameworks this year and write a comparison report with sources.',
  'Build a single-file HTML snake game with keyboard controls and a high score.',
  'Write a Python CLI that converts CSV files to Parquet, with tests.',
]

function usePoll<T>(path: string, initial: T, ms: number): [T, () => void, string | undefined] {
  const [data, setData] = useState<T>(initial)
  const [error, setError] = useState<string>()
  const load = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d)
        setError(undefined)
      })
      .catch((err) => setError(String(err.message ?? err)))
  }, [path])
  useEffect(() => {
    load()
    const t = setInterval(load, ms)
    return () => clearInterval(t)
  }, [load, ms])
  return [data, load, error]
}

function loadConfig(fallback: string): TeamConfig {
  const base: TeamConfig = {
    mode: 'auto',
    leadModel: fallback,
    workerModel: fallback,
    workers: 3,
    judgeModel: fallback,
  }
  try {
    const saved = localStorage.getItem(CONFIG_KEY)
    return saved ? { ...base, ...(JSON.parse(saved) as Partial<TeamConfig>) } : base
  } catch {
    return base
  }
}

export function App() {
  const [chats, refreshChats, chatsError] = usePoll<ChatSummary[]>('/api/chats', [], 2500)
  const [models, setModels] = useState<ModelOption[]>([])
  const [config, setConfig] = useState<TeamConfig>()
  const [view, setView] = useState<'chat' | 'colonies' | 'compare'>('chat')
  const [activeChat, setActiveChat] = useState<string>()
  const [drawer, setDrawer] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string>()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    api<{ models: ModelOption[]; default?: string }>('/api/models')
      .then((r) => {
        setModels(r.models)
        setConfig(loadConfig(r.default ?? r.models[0]?.ref ?? ''))
      })
      .catch((err) => setSendError(String(err.message ?? err)))
  }, [])

  const updateConfig = (c: TeamConfig) => {
    setConfig(c)
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
    } catch {
      // Preferences are a convenience; private mode simply forgets them.
    }
  }

  const chat = chats.find((c) => c.chatId === activeChat)
  const running = chat?.status === 'running' || chat?.status === 'created'

  const send = async (text: string) => {
    if (!config) return
    setBusy(true)
    setSendError(undefined)
    try {
      const r = await post<{ chatId: string; colonyId: string }>('/api/chats', {
        text,
        config,
        chatId: activeChat,
      })
      setActiveChat(r.chatId)
      refreshChats()
    } catch (err) {
      setSendError(String((err as Error).message ?? err))
      throw err
    } finally {
      setBusy(false)
    }
  }

  const stop = () => {
    if (activeChat) void post(`/api/chats/${activeChat}/stop`, {}).then(refreshChats)
  }

  return (
    <div className={sidebarOpen ? 'shell sidebar-open' : 'shell'}>
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ⬡
          </span>
          Myrmidon
        </div>
        <button
          type="button"
          className="new-chat"
          onClick={() => {
            setActiveChat(undefined)
            setView('chat')
            setSidebarOpen(false)
          }}
        >
          ＋ New task
        </button>
        <nav className="chat-list" aria-label="Conversations">
          {chats.length === 0 && <div className="muted small pad">No conversations yet.</div>}
          {chats.map((c) => (
            <button
              key={c.chatId}
              type="button"
              className={c.chatId === activeChat && view === 'chat' ? 'chat-item on' : 'chat-item'}
              onClick={() => {
                setActiveChat(c.chatId)
                setView('chat')
                setSidebarOpen(false)
              }}
            >
              <span className={`dot status-${c.status === 'running' ? 'working' : c.status}`} />
              <span className="chat-title">{c.title}</span>
              {c.rounds.length > 1 && <span className="muted small">{c.rounds.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className={view === 'colonies' ? 'on' : ''}
            onClick={() => setView('colonies')}
          >
            Colonies
          </button>
          <button type="button" className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}>
            Compare runs
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="main-head">
          <button
            type="button"
            className="menu"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <span className="main-title">
            {view === 'chat'
              ? (chat?.title ?? 'New task')
              : view === 'colonies'
                ? 'Colonies'
                : 'Compare runs'}
          </span>
          {view === 'chat' && chat && (
            <span className={`pill status-${running ? 'running' : chat.status}`}>
              {running ? 'working' : chat.status}
            </span>
          )}
        </header>
        {(chatsError || sendError) && <div className="banner error">{sendError ?? chatsError}</div>}
        {view === 'chat' && (
          <ChatPane chat={chat} onOpenColony={setDrawer} onExample={(t) => void send(t).catch(() => {})} />
        )}
        {view === 'chat' && config && (
          <Composer
            models={models}
            config={config}
            onConfig={updateConfig}
            running={running}
            busy={busy}
            placeholder={
              chat
                ? running
                  ? 'Message the lead…'
                  : 'Ask for changes or a follow-up…'
                : 'What should the colony do?'
            }
            onSend={send}
            onStop={stop}
          />
        )}
        {view === 'colonies' && <ColoniesPane />}
        {view === 'compare' && <ComparePane onOpen={(id) => setDrawer(id)} />}
      </div>
      {drawer && (
        <div className="drawer" role="dialog" aria-label="Colony details">
          <div className="drawer-head">
            <strong>Colony</strong>
            <span className="muted small mono">{drawer}</span>
            <button
              type="button"
              className="close"
              onClick={() => setDrawer(undefined)}
              aria-label="Close colony"
            >
              ✕
            </button>
          </div>
          <ColonyScreen key={drawer} id={drawer} compact />
        </div>
      )}
    </div>
  )
}

function ChatPane(props: {
  chat?: ChatSummary
  onOpenColony(id: string): void
  onExample(text: string): void
}) {
  const end = useRef<HTMLDivElement>(null)
  const rounds = props.chat?.rounds ?? []
  // Keep the newest activity in view as rounds stream in.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  })
  if (!props.chat) {
    return (
      <div className="welcome">
        <div className="welcome-mark" aria-hidden>
          ⬡
        </div>
        <h1>What should the colony do?</h1>
        <p className="muted">
          Describe the outcome you want. A lead agent plans it, brings in workers when they help, researches
          the web, builds the result, and an independent judge verifies it before it is called done.
        </p>
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => props.onExample(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="transcript-pane">
      <div className="transcript-col">
        {rounds.map((r) => (
          <RoundView key={r.colonyId} colonyId={r.colonyId} onOpenColony={props.onOpenColony} />
        ))}
        <div ref={end} />
      </div>
    </div>
  )
}

function ColoniesPane() {
  const [colonies] = usePoll<ColonySummary[]>('/api/colonies', [], 4000)
  const [selected, setSelected] = useState<string>()
  const active = selected ?? colonies[0]?.id
  if (!active) return <div className="empty big">No colonies yet.</div>
  return (
    <div className="colonies-pane">
      <div className="row pad">
        <select value={active} onChange={(e) => setSelected(e.target.value)} aria-label="Colony">
          {colonies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.status} · {c.createdAt?.slice(0, 16).replace('T', ' ')}
            </option>
          ))}
        </select>
      </div>
      <ColonyScreen key={active} id={active} />
    </div>
  )
}

function ComparePane(props: { onOpen(id: string): void }) {
  const [colonies] = usePoll<ColonySummary[]>('/api/colonies', [], 5000)
  return <Compare colonies={colonies} onOpen={props.onOpen} />
}
