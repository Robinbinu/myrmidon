import type { ColonyState, MyrEvent } from '@myrmidon/protocol'
import { colonyMetrics } from '@myrmidon/protocol'
import { previewUrl } from '../api.ts'
import { describeEvent } from '../describe.ts'
import { useColony } from '../use-colony.ts'
import { Markdown } from './Markdown.tsx'

const ACTIVITY_TYPES = new Set([
  'tool/call',
  'board/posted',
  'task/changed',
  'artifact/versioned',
  'agent/joined',
  'verifier/verdict',
  'mail/sent',
])

function lastActivity(events: readonly MyrEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && ACTIVITY_TYPES.has(e.type)) return describeEvent(e)
  }
  return undefined
}

/** One round of a conversation: the user's message, the colony's replies, and a live activity card. */
export function RoundView(props: { colonyId: string; onOpenColony(id: string): void }) {
  const colony = useColony(props.colonyId)
  const { state, events } = colony
  if (colony.error) return <div className="banner error">{colony.error}</div>
  const user = state.chatMessages.filter((m) => m.from === 'user')
  const firstUser = user[0]
  const items = state.chatMessages.filter((m) => m !== firstUser)
  return (
    <section className="round">
      {firstUser && (
        <div className="msg user">
          <div className="bubble">
            <Markdown text={firstUser.text} />
          </div>
        </div>
      )}
      <ActivityCard
        state={state}
        events={events}
        onOpen={() => props.onOpenColony(props.colonyId)}
        colonyId={props.colonyId}
      />
      {items.map((m) =>
        m.from === 'user' ? (
          <div key={m.id} className="msg user">
            <div className="bubble">
              <Markdown text={m.text} />
            </div>
          </div>
        ) : (
          <div key={m.id} className={m.final ? 'msg agent final' : 'msg agent'}>
            <div className="avatar" aria-hidden>
              ⬡
            </div>
            <div className="msg-body">
              <div className="msg-from">
                {m.from}
                {m.final && <span className="tag">final answer</span>}
              </div>
              <Markdown text={m.text} />
            </div>
          </div>
        ),
      )}
      <Outcome state={state} />
    </section>
  )
}

function ActivityCard(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  colonyId: string
  onOpen(): void
}) {
  const { state } = props
  const agents = Object.values(state.agents)
  const tasks = Object.values(state.tasks).filter((t) => t.status !== 'deleted')
  const done = tasks.filter((t) => t.status === 'verified').length
  const running = state.status === 'running' || state.status === 'created'
  const m = colonyMetrics(state)
  const artifacts = Object.entries(state.artifacts).filter(([, v]) =>
    v.some((x) => x.author !== 'previous-round'),
  )
  return (
    <div className={running ? 'activity live' : 'activity'}>
      <div className="activity-head">
        <span className={`dot status-${running ? 'working' : state.status}`} />
        <strong>
          {running
            ? 'Colony working'
            : state.statusReason === 'awaiting your reply'
              ? 'Waiting for you'
              : `Colony ${state.status}`}
        </strong>
        <span className="muted small">
          {Math.round(m.wallMs / 1000)}s · {m.tokens.toLocaleString()} tokens
          {tasks.length > 0 && ` · ${done}/${tasks.length} tasks verified`}
        </span>
        <button type="button" className="link small" onClick={props.onOpen}>
          Open colony ↗
        </button>
      </div>
      <div className="team-chips">
        {agents.map((a) => (
          <span
            key={a.info.name}
            className={`agent-chip status-${a.status}`}
            title={`${a.info.model} · ${a.status}`}
          >
            <span className={`dot status-${a.status}`} />
            {a.info.name}
            <span className="muted">{a.info.model.split('/').pop()}</span>
          </span>
        ))}
      </div>
      {running && <div className="activity-now mono small">{lastActivity(props.events) ?? 'starting…'}</div>}
      {artifacts.length > 0 && (
        <div className="artifact-chips">
          {artifacts.map(([name, versions]) => {
            const latest = versions.at(-1)
            return (
              <span key={name} className="artifact-chip">
                📄 {name}
                <span className="muted small">v{latest?.version}</span>
                {latest?.mediaType === 'text/html' && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => {
                      void previewUrl(props.colonyId, name).then((url) =>
                        window.open(url, '_blank', 'noopener'),
                      )
                    }}
                  >
                    preview
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Outcome({ state }: { state: ColonyState }) {
  const finals = state.verdicts.filter((v) => v.target === 'colony')
  if (state.status === 'completed') {
    const judge = finals.filter((v) => v.score !== undefined).at(-1)
    return (
      <div className="outcome ok">
        ✓ Verified{judge?.score !== undefined ? ` · judge score ${judge.score.toFixed(2)}` : ''}
      </div>
    )
  }
  if (state.status === 'stopped' && state.statusReason === 'awaiting your reply') {
    return <div className="outcome wait">Waiting for your reply</div>
  }
  if (state.status === 'stopped' || state.status === 'failed') {
    const last = finals.at(-1)
    return (
      <div className="outcome bad">
        {state.status === 'failed' ? 'Failed' : 'Stopped'}: {state.statusReason}
        {last && !last.pass && (
          <div className="muted small">Last verification: {last.evidence.slice(0, 300)}</div>
        )}
      </div>
    )
  }
  const failing = finals.at(-1)
  return failing && !failing.pass ? (
    <div className="outcome warn">
      Verification failed, the colony is fixing it: {failing.evidence.slice(0, 240)}
    </div>
  ) : null
}
