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
  const asked = new Map<string, EventPayloads['approval/requested']>()
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
            lead: p.reason ? `Sent ${p.task.id} back:` : 'Task needs rework:',
            strong: cut(p.task.subject, 90),
            ...(p.reason ? { tail: cut(p.reason, 140) } : {}),
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
      case 'safety/flagged': {
        const p = e.payload as EventPayloads['safety/flagged']
        out.push({
          ...base,
          kind: 'error',
          agent: p.agent,
          lead: 'Possible prompt injection:',
          tail: cut(`${p.reason} (from ${p.source})`, 160),
        })
        break
      }
      case 'server/started': {
        const p = e.payload as EventPayloads['server/started']
        out.push({
          ...base,
          kind: 'shell',
          agent: p.agent,
          lead: `Started ${p.name} at`,
          strong: p.url,
          tail: cut(p.command, 80),
        })
        break
      }
      case 'server/stopped': {
        const p = e.payload as EventPayloads['server/stopped']
        out.push({ ...base, kind: 'shell', agent: 'system', lead: `Stopped ${p.name}`, tail: p.reason })
        break
      }
      case 'colony/escalated': {
        const p = e.payload as EventPayloads['colony/escalated']
        out.push({
          ...base,
          kind: 'team',
          agent: p.by,
          lead: `Handed the request to ${p.to === 'team' ? 'a team' : 'one agent with every tool'}:`,
          tail: cut(p.reason, 140),
        })
        break
      }
      case 'memory/proposed': {
        const p = e.payload as EventPayloads['memory/proposed']
        out.push({
          ...base,
          kind: 'signal',
          agent: p.agent,
          lead: 'Proposed to remember:',
          tail: cut(p.text, 140),
        })
        break
      }
      case 'worktree/created': {
        const p = e.payload as EventPayloads['worktree/created']
        out.push({ ...base, kind: 'file', agent: p.agent, lead: 'Works on its own branch', strong: p.branch })
        break
      }
      case 'worktree/merged': {
        const p = e.payload as EventPayloads['worktree/merged']
        out.push({
          ...base,
          kind: 'file',
          agent: p.agent,
          lead: `Merged ${p.files.length} file${p.files.length === 1 ? '' : 's'} into the project`,
          tail: cut(p.files.join(', '), 120),
        })
        break
      }
      case 'worktree/updated': {
        const p = e.payload as EventPayloads['worktree/updated']
        out.push({
          ...base,
          kind: 'file',
          agent: p.agent,
          lead: `Brought ${p.files.length} changed file${p.files.length === 1 ? '' : 's'} from the project into its branch`,
          tail: cut(p.files.join(', '), 120),
        })
        break
      }
      case 'worktree/conflict': {
        const p = e.payload as EventPayloads['worktree/conflict']
        out.push({
          ...base,
          kind: 'error',
          agent: p.agent,
          lead: 'Merge conflict, sent back to resolve:',
          tail: cut(p.files.join(', '), 120),
        })
        break
      }
      case 'worktree/closed': {
        const p = e.payload as EventPayloads['worktree/closed']
        if (p.kept)
          out.push({
            ...base,
            kind: 'error',
            agent: p.agent,
            lead: 'Kept its branch: it holds changes that were not merged',
          })
        break
      }
      case 'approval/requested': {
        const p = e.payload as EventPayloads['approval/requested']
        asked.set(p.id, p)
        out.push({
          ...base,
          kind: 'signal',
          agent: p.agent,
          lead: 'Asked you to approve',
          tail: cut(p.summary, 120),
        })
        break
      }
      case 'approval/decided': {
        const p = e.payload as EventPayloads['approval/decided']
        const req = asked.get(p.id)
        out.push({
          ...base,
          kind: p.approved ? 'verdict' : 'error',
          agent: req?.agent ?? 'you',
          lead: p.approved ? 'Approved' : p.by === 'timeout' ? 'Not approved in time' : 'Denied',
          tail: cut(req?.summary ?? '', 120),
        })
        break
      }
      case 'agent/compacted': {
        const p = e.payload as EventPayloads['agent/compacted']
        out.push({
          ...base,
          kind: 'think',
          agent: p.agent,
          lead: 'Compacted its context',
          tail: `summarized ${p.messages} earlier messages at ~${Math.round(p.tokens / 1000)}k tokens`,
        })
        break
      }
      case 'agent/model': {
        const p = e.payload as EventPayloads['agent/model']
        out.push({
          ...base,
          kind: 'team',
          agent: p.agent,
          lead: 'Switched to',
          strong: p.model.split('/').pop() ?? p.model,
          tail: `from ${p.previous.split('/').pop()}, by you`,
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
