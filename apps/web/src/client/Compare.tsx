import type { ColonySummary } from './api.ts'

const secs = (ms: number) => `${Math.round(ms / 1000)}s`

/** Side-by-side run metrics for research comparisons. */
export function Compare(props: { colonies: ColonySummary[]; onOpen(id: string): void }) {
  if (props.colonies.length === 0)
    return <div className="empty">No colonies yet. Run one with `myrmidon run`.</div>
  return (
    <div className="compare">
      <table>
        <thead>
          <tr>
            <th>Colony</th>
            <th>Status</th>
            <th>Pattern</th>
            <th>Models</th>
            <th className="num">Wall</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th className="num">Turns</th>
            <th className="num">Tool calls</th>
            <th className="num">Messages</th>
            <th className="num">Artifact versions</th>
            <th className="num">Rejections</th>
            <th className="num">Best score</th>
          </tr>
        </thead>
        <tbody>
          {props.colonies.map((c) => (
            <tr key={c.id}>
              <td>
                <button type="button" className="link" onClick={() => props.onOpen(c.id)}>
                  {c.name}
                </button>
                <div className="muted small mono">{c.id}</div>
              </td>
              <td>
                <span className={`pill status-${c.status}`}>{c.status}</span>
                {c.statusReason && <div className="muted small">{c.statusReason}</div>}
              </td>
              <td>{c.pattern}</td>
              <td className="small">{[...new Set(c.agents.map((a) => a.model))].join(', ')}</td>
              <td className="num">{secs(c.metrics.wallMs)}</td>
              <td className="num">{c.metrics.tokens.toLocaleString()}</td>
              <td className="num">{c.metrics.cost === undefined ? '—' : `$${c.metrics.cost.toFixed(3)}`}</td>
              <td className="num">{c.metrics.turns}</td>
              <td className="num">{c.metrics.toolCalls}</td>
              <td className="num">{c.metrics.messages}</td>
              <td className="num">{c.metrics.artifactVersions}</td>
              <td className="num">{c.metrics.rejections}</td>
              <td className="num">
                {c.metrics.bestScore === undefined ? '—' : c.metrics.bestScore.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
