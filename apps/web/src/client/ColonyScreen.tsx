import { colonyMetrics } from '@myrmidon/protocol'
import { useState } from 'react'
import { ColonyMap } from './ColonyMap.tsx'
import { Inspector } from './Inspector.tsx'
import { Panels } from './Panels.tsx'
import { Timeline } from './Timeline.tsx'
import { useColony } from './use-colony.ts'

/** Full colony view: map, panels or agent inspector, and the replay timeline. */
export function ColonyScreen({ id, compact = false }: { id: string; compact?: boolean }) {
  const colony = useColony(id)
  const [agent, setAgent] = useState<string>()
  const { state } = colony
  const m = colonyMetrics(state)
  if (colony.error) return <div className="banner error">{colony.error}</div>
  return (
    <main className={compact ? 'colony compact' : 'colony'}>
      <section className="summary">
        <div>
          <h1>{state.name}</h1>
          {!compact && <p className="mission">{state.mission}</p>}
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

export function Kpi(props: { label: string; value: string; className?: string }) {
  return (
    <div className={`kpi ${props.className ?? ''}`}>
      <span className="kpi-label">{props.label}</span>
      <span className="kpi-value">{props.value}</span>
    </div>
  )
}
