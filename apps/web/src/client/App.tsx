import { colonyMetrics } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { api, type ColonySummary } from './api.ts'
import { ColonyMap } from './ColonyMap.tsx'
import { Compare } from './Compare.tsx'
import { Inspector } from './Inspector.tsx'
import { Panels } from './Panels.tsx'
import { Timeline } from './Timeline.tsx'
import { useColony } from './use-colony.ts'

function useColonies() {
  const [colonies, setColonies] = useState<ColonySummary[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    const load = () =>
      api<ColonySummary[]>('/api/colonies')
        .then((c) => {
          if (!alive) return
          setColonies(c)
          setError(undefined)
        })
        .catch((err) => alive && setError(String(err.message ?? err)))
    void load()
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  return { colonies, error }
}

export function App() {
  const { colonies, error } = useColonies()
  const [view, setView] = useState<'colony' | 'compare'>('colony')
  const [selected, setSelected] = useState<string>()
  const active = selected ?? colonies[0]?.id
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ⬡
          </span>
          Myrmidon
        </div>
        <nav className="views">
          <button type="button" className={view === 'colony' ? 'on' : ''} onClick={() => setView('colony')}>
            Colony
          </button>
          <button type="button" className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}>
            Compare runs
          </button>
        </nav>
        {view === 'colony' && colonies.length > 0 && (
          <select value={active} onChange={(e) => setSelected(e.target.value)} aria-label="Colony">
            {colonies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.status} · {c.createdAt?.slice(0, 16).replace('T', ' ')}
              </option>
            ))}
          </select>
        )}
      </header>
      {error && <div className="banner error">{error}</div>}
      {view === 'compare' ? (
        <Compare
          colonies={colonies}
          onOpen={(id) => {
            setSelected(id)
            setView('colony')
          }}
        />
      ) : active ? (
        <ColonyScreen key={active} id={active} />
      ) : (
        <div className="empty big">
          No colonies yet. Start one with `bun run myr run examples/calculator/colony.yaml`.
        </div>
      )}
    </div>
  )
}

function ColonyScreen({ id }: { id: string }) {
  const colony = useColony(id)
  const [agent, setAgent] = useState<string>()
  const { state } = colony
  const m = colonyMetrics(state)
  if (colony.error) return <div className="banner error">{colony.error}</div>
  return (
    <main className="colony">
      <section className="summary">
        <div>
          <h1>{state.name}</h1>
          <p className="mission">{state.mission}</p>
        </div>
        <div className="kpis">
          <Kpi label="Status" value={state.status} className={`status-${state.status}`} />
          <Kpi label="Wall" value={`${Math.round(m.wallMs / 1000)}s`} />
          <Kpi label="Tokens" value={m.tokens.toLocaleString()} />
          <Kpi label="Cost" value={m.cost === undefined ? 'n/a' : `$${m.cost.toFixed(3)}`} />
          <Kpi label="Artifacts" value={String(Object.keys(state.artifacts).length)} />
          <Kpi
            label="Verdicts"
            value={`${state.verdicts.filter((v) => v.pass).length}/${state.verdicts.length}`}
          />
        </div>
        {state.statusReason && <div className="muted small">{state.statusReason}</div>}
        {state.unsafeNoSandbox && (
          <div className="banner warn">This colony ran with --unsafe-no-sandbox.</div>
        )}
      </section>
      <section className="stage">
        <div className="map">
          <ColonyMap
            state={state}
            events={colony.events}
            cursor={colony.cursor}
            selected={agent}
            onSelect={setAgent}
          />
        </div>
        <div className="side">
          {agent ? (
            <Inspector
              agent={agent}
              state={state}
              events={colony.events}
              cursor={colony.cursor}
              onClose={() => setAgent(undefined)}
            />
          ) : (
            <Panels state={state} events={colony.events} cursor={colony.cursor} colony={id} />
          )}
        </div>
      </section>
      <Timeline
        events={colony.events}
        cursor={colony.cursor}
        head={colony.head}
        live={colony.live}
        setCursor={colony.setCursor}
        setLive={colony.setLive}
      />
    </main>
  )
}

function Kpi(props: { label: string; value: string; className?: string }) {
  return (
    <div className={`kpi ${props.className ?? ''}`}>
      <span className="kpi-label">{props.label}</span>
      <span className="kpi-value">{props.value}</span>
    </div>
  )
}
