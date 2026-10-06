import type { ColonyState, EventPayloads, MyrEvent } from '@myrmidon/protocol'

/** Full transcript of one agent up to the replay cursor: model output, tool calls, and results. */
export function Inspector(props: {
  agent: string
  state: ColonyState
  events: readonly MyrEvent[]
  cursor: number
  onClose(): void
}) {
  const view = props.state.agents[props.agent]
  if (!view) return null
  const mine = props.events.slice(0, props.cursor).filter((e) => {
    const p = e.payload as { agent?: string; from?: string; to?: string }
    return p.agent === props.agent || p.from === props.agent || p.to === props.agent
  })
  return (
    <section className="inspector">
      <header className="row">
        <h2>{view.info.name}</h2>
        <span className={`pill status-${view.status}`}>{view.status}</span>
        <button type="button" className="close" onClick={props.onClose} aria-label="Close inspector">
          ✕
        </button>
      </header>
      <dl className="stats">
        <dt>Role</dt>
        <dd>{view.info.role}</dd>
        <dt>Model</dt>
        <dd className="mono">{view.info.model}</dd>
        <dt>Turns</dt>
        <dd>{view.turns}</dd>
        <dt>Tokens</dt>
        <dd>{view.tokens.toLocaleString()}</dd>
        <dt>Cost</dt>
        <dd>{view.costKnown ? `$${view.cost.toFixed(4)}` : 'not reported'}</dd>
        <dt>Tool calls</dt>
        <dd>{view.toolCalls}</dd>
        <dt>Tools</dt>
        <dd className="small">{view.info.tools.join(', ')}</dd>
      </dl>
      <ol className="transcript">
        {mine.map((e) => (
          <TranscriptItem key={e.id} event={e} agent={props.agent} />
        ))}
      </ol>
    </section>
  )
}

function TranscriptItem({ event, agent }: { event: MyrEvent; agent: string }) {
  const time = <span className="muted mono small">{event.time.slice(11, 19)}</span>
  switch (event.type) {
    case 'llm/response': {
      const p = event.payload as EventPayloads['llm/response']
      return (
        <li className="t-llm">
          <div className="row">
            <strong>model</strong>
            {time}
            {p.usage && <span className="muted small">{p.usage.totalTokens} tok</span>}
            {p.error && <span className="error small">{p.error}</span>}
          </div>
          {p.thinking && (
            <details>
              <summary className="muted small">thinking</summary>
              <pre className="thinking">{p.thinking}</pre>
            </details>
          )}
          {p.text && <div className="text">{p.text}</div>}
        </li>
      )
    }
    case 'tool/call': {
      const p = event.payload as EventPayloads['tool/call']
      return (
        <li className="t-call">
          <div className="row">
            <strong>▸ {p.tool}</strong>
            {time}
          </div>
          <pre className="code small">{JSON.stringify(p.args, null, 2)}</pre>
        </li>
      )
    }
    case 'tool/result': {
      const p = event.payload as EventPayloads['tool/result']
      return (
        <li className={p.ok ? 't-result' : 't-result error'}>
          <div className="row">
            <strong>◂ {p.tool}</strong>
            {time}
          </div>
          <pre className="code small">{p.output}</pre>
        </li>
      )
    }
    case 'mail/sent': {
      const p = event.payload as EventPayloads['mail/sent']
      return (
        <li className="t-mail">
          <div className="row">
            <strong>{p.from === agent ? `✉ to ${p.to}` : `✉ from ${p.from}`}</strong>
            {time}
          </div>
          <div className="text">{p.body}</div>
        </li>
      )
    }
    case 'agent/turn': {
      const p = event.payload as EventPayloads['agent/turn']
      return p.phase === 'start' ? (
        <li className="t-turn">
          turn {p.turn} — woke on {p.trigger} {time}
        </li>
      ) : null
    }
    default:
      return null
  }
}
