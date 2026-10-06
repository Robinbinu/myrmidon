import type { ColonyState, MyrEvent, TaskSnapshot } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { blobText, previewUrl } from './api.ts'
import { describeEvent } from './describe.ts'
import { diffLines } from './diff.ts'

export type PanelTab = 'board' | 'tasks' | 'artifacts' | 'notes' | 'mail' | 'verdicts' | 'events'

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'notes', label: 'Notes' },
  { id: 'mail', label: 'Mail' },
  { id: 'verdicts', label: 'Verdicts' },
  { id: 'events', label: 'Events' },
]

export function Panels(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  cursor: number
  colony: string
}) {
  const [tab, setTab] = useState<PanelTab>('board')
  const { state } = props
  const counts: Partial<Record<PanelTab, number>> = {
    board: state.board.length,
    tasks: Object.keys(state.tasks).length,
    artifacts: Object.keys(state.artifacts).length,
    notes: state.notes.length,
    mail: state.mail.length,
    verdicts: state.verdicts.length,
  }
  return (
    <section className="panels">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab on' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {counts[t.id] ? <span className="count">{counts[t.id]}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'board' && (
          <Feed
            items={state.board.map((b) => ({ key: b.id, who: b.agent, text: b.text, time: b.time }))}
            empty="No board posts yet."
          />
        )}
        {tab === 'notes' && (
          <Feed
            items={state.notes.map((n) => ({
              key: n.id,
              who: n.agent,
              text: n.corrects ? `(corrects ${n.corrects.slice(-6)}) ${n.text}` : n.text,
              time: n.time,
            }))}
            empty="No notes yet. Notes are append-only."
          />
        )}
        {tab === 'mail' && (
          <Feed
            items={state.mail.map((m) => ({
              key: m.id,
              who: `${m.from} → ${m.to}${m.delivered ? '' : ' (pending)'}`,
              text: m.subject ? `[${m.subject}] ${m.body}` : m.body,
              time: m.time,
            }))}
            empty="No mail yet."
          />
        )}
        {tab === 'tasks' && <Tasks tasks={Object.values(state.tasks)} />}
        {tab === 'artifacts' && <Artifacts state={state} colony={props.colony} />}
        {tab === 'verdicts' && (
          <ul className="list">
            {state.verdicts.length === 0 && <li className="empty">No verdicts yet.</li>}
            {state.verdicts.map((v) => (
              <li key={v.id} className={v.pass ? 'verdict pass' : 'verdict fail'}>
                <div className="row">
                  <strong>{v.pass ? 'PASS' : 'FAIL'}</strong>
                  <span>{v.verifierId}</span>
                  <span className="muted">{v.target}</span>
                  {v.score !== undefined && <span>score {v.score.toFixed(2)}</span>}
                </div>
                <pre className="evidence">{v.evidence}</pre>
              </li>
            ))}
          </ul>
        )}
        {tab === 'events' && <Events events={props.events} cursor={props.cursor} />}
      </div>
    </section>
  )
}

function Feed(props: { items: { key: string; who: string; text: string; time: string }[]; empty: string }) {
  if (props.items.length === 0) return <div className="empty">{props.empty}</div>
  return (
    <ul className="list">
      {[...props.items].reverse().map((i) => (
        <li key={i.key} className="feed-item">
          <div className="row">
            <strong>{i.who}</strong>
            <span className="muted mono">{i.time.slice(11, 19)}</span>
          </div>
          <div className="text">{i.text}</div>
        </li>
      ))}
    </ul>
  )
}

const ORDER: TaskSnapshot['status'][] = [
  'in_progress',
  'submitted',
  'rejected',
  'pending',
  'verified',
  'deleted',
]

function Tasks(props: { tasks: TaskSnapshot[] }) {
  if (props.tasks.length === 0) return <div className="empty">No tasks yet.</div>
  const sorted = [...props.tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  return (
    <ul className="list">
      {sorted.map((t) => (
        <li key={t.id} className={`task status-${t.status}`}>
          <div className="row">
            <strong>{t.id}</strong>
            <span className={`pill status-${t.status}`}>{t.status}</span>
            <span className="muted">r{t.revision}</span>
            {t.owner && <span>{t.owner}</span>}
          </div>
          <div className="text">{t.subject}</div>
          {t.description && <div className="muted small">{t.description}</div>}
          {(t.blockedBy.length > 0 || t.artifacts.length > 0) && (
            <div className="muted small">
              {t.blockedBy.length > 0 && `blocked by ${t.blockedBy.join(', ')} `}
              {t.artifacts.length > 0 && `artifacts: ${t.artifacts.join(', ')}`}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function Artifacts(props: { state: ColonyState; colony: string }) {
  const names = Object.keys(props.state.artifacts).sort()
  const [name, setName] = useState<string>()
  const [version, setVersion] = useState<number>()
  const [showDiff, setShowDiff] = useState(false)
  const [content, setContent] = useState<{ text: string; prev?: string }>()
  const [error, setError] = useState<string>()
  const active = name && props.state.artifacts[name] ? name : names[0]
  const versions = active ? (props.state.artifacts[active] ?? []) : []
  const selected = versions.find((v) => v.version === version) ?? versions.at(-1)
  const previous = selected ? versions.find((v) => v.version === selected.parentVersion) : undefined

  const blob = selected?.blob
  const prevBlob = previous?.blob
  useEffect(() => {
    if (!blob) return
    let cancelled = false
    setError(undefined)
    Promise.all([blobText(props.colony, blob), prevBlob ? blobText(props.colony, prevBlob) : undefined])
      .then(([text, prev]) => !cancelled && setContent({ text, prev }))
      .catch((err) => !cancelled && setError(String(err.message ?? err)))
    return () => {
      cancelled = true
    }
  }, [props.colony, blob, prevBlob])

  if (names.length === 0)
    return <div className="empty">No artifacts yet. Agents publish all output here.</div>
  return (
    <div className="artifacts">
      <ul className="artifact-names">
        {names.map((n) => (
          <li key={n}>
            <button
              type="button"
              className={n === active ? 'on' : ''}
              onClick={() => {
                setName(n)
                setVersion(undefined)
              }}
            >
              {n} <span className="muted">v{props.state.artifacts[n]?.at(-1)?.version}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="artifact-view">
          <div className="row">
            <select
              value={selected.version}
              onChange={(e) => setVersion(Number(e.target.value))}
              aria-label="Version"
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} by {v.author}
                </option>
              ))}
            </select>
            <label className="muted small">
              <input
                type="checkbox"
                checked={showDiff}
                disabled={!previous}
                onChange={(e) => setShowDiff(e.target.checked)}
              />{' '}
              diff vs v{previous?.version ?? '–'}
            </label>
            <span className="muted small">
              {selected.size} bytes · {selected.blob.slice(0, 10)}
            </span>
            {selected.mediaType === 'text/html' && active && (
              <button
                type="button"
                className="preview-link"
                onClick={() => {
                  previewUrl(props.colony, active)
                    .then((url) => window.open(url, '_blank', 'noopener'))
                    .catch((err) => setError(String(err.message ?? err)))
                }}
              >
                Open preview ↗
              </button>
            )}
          </div>
          {error && <div className="error">{error}</div>}
          {content &&
            (showDiff && content.prev !== undefined ? (
              <pre className="code diff">
                {diffLines(content.prev, content.text).map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and have no identity
                  <div key={i} className={`diff-${l.kind}`}>
                    {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                    {l.text}
                  </div>
                ))}
              </pre>
            ) : (
              <pre className="code">{content.text}</pre>
            ))}
        </div>
      )}
    </div>
  )
}

function Events(props: { events: readonly MyrEvent[]; cursor: number }) {
  const visible = props.events.slice(Math.max(0, props.cursor - 300), props.cursor).reverse()
  return (
    <ul className="list events">
      {visible.map((e) => (
        <li key={e.id} className="mono small">
          <span className="seq">#{e.seq}</span> <span className="muted">{e.time.slice(11, 19)}</span>{' '}
          {describeEvent(e)}
        </li>
      ))}
    </ul>
  )
}
