import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'

export type StepKind =
  | 'search'
  | 'fetch'
  | 'file'
  | 'task'
  | 'team'
  | 'verdict'
  | 'error'
  | 'shell'
  | 'talk'
  | 'signal'
  | 'think'

export interface Step {
  readonly id: string
  readonly kind: StepKind
  readonly agent: string
  readonly lead: string
  readonly strong?: string
  readonly tail?: string
  readonly time: string
  /** Longer text the row can expand to, e.g. the model's reasoning. */
  readonly detail?: string
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function hostPath(url: string) {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname === '/' ? '' : cut(u.pathname, 40)}`
  } catch {
    return cut(url, 60)
  }
}

/** Turns raw colony events into a human-readable activity feed. Routine bookkeeping is skipped. */
export function deriveSteps(events: readonly MyrEvent[]): Step[] {
  const out: Step[] = []
  for (const e of events) {
    const base = { id: e.id, time: e.time }
    switch (e.type) {
      case 'llm/response': {
        const p = e.payload as EventPayloads['llm/response']
        const thinking = p.thinking?.trim()
        if (!thinking) break
        out.push({
          ...base,
          kind: 'think',
          agent: p.agent,
          lead: 'Thought',
          strong: cut(
            thinking
              .split('\n')
              .find((l) => l.trim())
              ?.replace(/^[#*\s]+/, '') ?? '',
            90,
          ),
          detail: thinking,
        })
        break
      }
      case 'tool/call': {
        const p = e.payload as EventPayloads['tool/call']
        const args = (p.args ?? {}) as Record<string, unknown>
        if (p.tool === 'web_search') {
          out.push({
            ...base,
            kind: 'search',
            agent: p.agent,
            lead: 'Searched the web for',
            strong: cut(String(args.query ?? ''), 90),
          })
        } else if (p.tool === 'web_fetch') {
          out.push({
            ...base,
            kind: 'fetch',
            agent: p.agent,
            lead: 'Read',
            strong: hostPath(String(args.url ?? '')),
          })
        } else if (p.tool === 'shell') {
          out.push({
            ...base,
            kind: 'shell',
            agent: p.agent,
            lead: 'Ran',
            strong: cut(String(args.command ?? ''), 80),
          })
        }
        break
      }
      case 'tool/result': {
        const p = e.payload as EventPayloads['tool/result']
        if (!p.ok)
          out.push({
            ...base,
            kind: 'error',
            agent: p.agent,
            lead: `${p.tool} failed:`,
            tail: cut(p.output.replace(/^ERROR:\s*/, ''), 140),
          })
        break
      }
      case 'artifact/versioned': {
        const p = e.payload as EventPayloads['artifact/versioned']
        if (p.author === 'previous-round') break
        out.push({
          ...base,
          kind: 'file',
          agent: p.author,
          lead: p.version === 1 ? 'Created' : 'Updated',
          strong: p.name,
          tail: p.version === 1 ? undefined : `v${p.version}`,
        })
        break
      }
      case 'task/changed': {
        const p = e.payload as EventPayloads['task/changed']
        if (p.task.revision === 1)
          out.push({ ...base, kind: 'task', agent: p.by, lead: 'Planned', strong: cut(p.task.subject, 90) })
        else if (p.task.status === 'verified')
          out.push({
            ...base,
            kind: 'verdict',
            agent: p.by,
            lead: 'Task done:',
            strong: cut(p.task.subject, 90),
          })
        else if (p.task.status === 'rejected')
          out.push({
            ...base,
            kind: 'error',
            agent: p.by,
            lead: 'Task needs rework:',
            strong: cut(p.task.subject, 90),
          })
        break
      }
      case 'agent/joined': {
        const p = e.payload as EventPayloads['agent/joined']
        out.push({
          ...base,
          kind: 'team',
          agent: p.by,
          lead: 'Brought in',
          strong: p.agent.name,
          tail: `${p.agent.model.split('/').pop()} — ${cut(p.focus, 80)}`,
        })
        break
      }
      case 'verifier/requested': {
        const p = e.payload as EventPayloads['verifier/requested']
        out.push({ ...base, kind: 'verdict', agent: p.by, lead: 'Asked the judge to verify the result' })
        break
      }
      case 'verifier/verdict': {
        const p = e.payload as EventPayloads['verifier/verdict']
        if (p.target !== 'colony') break
        out.push({
          ...base,
          kind: p.pass ? 'verdict' : 'error',
          agent: 'judge',
          lead: p.pass ? 'Judge approved' : 'Judge rejected',
          strong: p.score !== undefined ? `score ${p.score.toFixed(2)}` : undefined,
          tail: p.pass
            ? undefined
            : cut(p.evidence.replace(/^score [\d.]+ \(threshold [\d.]+\):\s*/, ''), 160),
        })
        break
      }
      case 'mail/sent': {
        const p = e.payload as EventPayloads['mail/sent']
        out.push({
          ...base,
          kind: 'talk',
          agent: p.from,
          lead: `Messaged ${p.to}:`,
          tail: cut(p.subject || p.body, 100),
        })
        break
      }
      case 'board/posted': {
        const p = e.payload as EventPayloads['board/posted']
        out.push({ ...base, kind: 'talk', agent: p.agent, lead: 'Posted:', tail: cut(p.text, 120) })
        break
      }
      case 'observer/signal': {
        const p = e.payload as EventPayloads['observer/signal']
        if (p.severity !== 'info')
          out.push({
            ...base,
            kind: 'signal',
            agent: 'observer',
            lead: `Observer (${p.kind}):`,
            tail: cut(p.facts, 120),
          })
        break
      }
    }
  }
  return out
}

/** The step a "now doing" line should show while the colony runs. */
export function currentStep(events: readonly MyrEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e) continue
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      const args = (p.args ?? {}) as Record<string, unknown>
      const what: Record<string, string> = {
        web_search: `searching "${cut(String(args.query ?? ''), 50)}"`,
        web_fetch: `reading ${hostPath(String(args.url ?? ''))}`,
        publish_artifact: `writing ${String(args.name ?? 'a file')}`,
        fs_write: `drafting ${String(args.path ?? 'a file')}`,
        shell: 'running a command',
        request_final_verification: 'waiting for the judge',
        spawn_worker: `bringing in ${String(args.name ?? 'a worker')}`,
        create_task: 'planning tasks',
        reply_user: 'writing a reply',
      }
      return `${p.agent} is ${what[p.tool] ?? `using ${p.tool}`}`
    }
    if (e.type === 'agent/turn') {
      const p = e.payload as EventPayloads['agent/turn']
      if (p.phase === 'start') return `${p.agent} is thinking`
    }
  }
  return undefined
}
