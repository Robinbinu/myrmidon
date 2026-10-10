import { DELIVERED_VERIFIER, type EventPayloads, type MyrEvent } from '@myrmidon/protocol'
import { copy } from '../copy.ts'

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
  | 'computer'
  | 'computerSetup'

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
  /** The file the step edited or wrote, as the agent named it. */
  readonly file?: string
  /** What it put in the file: the text replaced and its replacement, or a whole new content. */
  readonly change?: { readonly before?: string; readonly after: string }
  /** A desktop step's screenshot (computer use), stored with the round. */
  readonly shot?: { readonly colony: string; readonly blob: string }
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
  const edits = new Map<string, Record<string, unknown>>()
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
          lead: copy.steps.thought,
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
            lead: copy.steps.searched,
            strong: cut(String(args.query ?? ''), 90),
          })
        } else if (p.tool === 'web_fetch') {
          out.push({
            ...base,
            kind: 'fetch',
            agent: p.agent,
            lead: copy.steps.read,
            strong: hostPath(String(args.url ?? '')),
          })
        } else if (p.tool === 'fs_edit' || p.tool === 'fs_write') {
          // Shown once it went through: an edit can still wait for the person, be denied, or fail.
          edits.set(p.callId, args)
        } else if (p.tool === 'shell') {
          out.push({
            ...base,
            kind: 'shell',
            agent: p.agent,
            lead: copy.steps.ran,
            strong: cut(String(args.command ?? ''), 80),
          })
        }
        break
      }
      case 'tool/result': {
        const p = e.payload as EventPayloads['tool/result']
        const args = edits.get(p.callId)
        if (p.ok && args) {
          const file = String(args.path ?? '')
          const edit = p.tool === 'fs_edit'
          out.push({
            ...base,
            kind: 'file',
            agent: p.agent,
            lead: edit ? copy.steps.edited : copy.steps.wrote,
            strong: file,
            file,
            change: edit
              ? { before: String(args.old ?? ''), after: String(args.new ?? '') }
              : { after: String(args.content ?? '') },
          })
        }
        if (!p.ok)
          out.push({
            ...base,
            kind: 'error',
            agent: p.agent,
            lead: copy.steps.toolFailed(p.tool),
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
          lead: p.version === 1 ? copy.steps.created : copy.steps.updated,
          strong: p.name,
          tail: p.version === 1 ? undefined : `v${p.version}`,
        })
        break
      }
      case 'task/changed': {
        const p = e.payload as EventPayloads['task/changed']
        if (p.task.revision === 1)
          out.push({
            ...base,
            kind: 'task',
            agent: p.by,
            lead: copy.steps.planned,
            strong: cut(p.task.subject, 90),
          })
        else if (p.task.status === 'verified')
          out.push({
            ...base,
            kind: 'verdict',
            agent: p.by,
            lead: copy.steps.taskDone,
            strong: cut(p.task.subject, 90),
          })
        else if (p.task.status === 'rejected')
          out.push({
            ...base,
            kind: 'error',
            agent: p.by,
            lead: p.reason ? copy.steps.sentBack(p.task.id) : copy.steps.needsRework,
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
          lead: copy.steps.broughtIn,
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
          lead: copy.steps.promptInjection,
          tail: cut(copy.steps.injectionSource(p.reason, p.source), 160),
        })
        break
      }
      case 'server/started': {
        const p = e.payload as EventPayloads['server/started']
        out.push({
          ...base,
          kind: 'shell',
          agent: p.agent,
          lead: copy.steps.startedServer(p.name),
          strong: p.url,
          tail: cut(p.command, 80),
        })
        break
      }
      case 'server/stopped': {
        const p = e.payload as EventPayloads['server/stopped']
        out.push({
          ...base,
          kind: 'shell',
          agent: 'system',
          lead: copy.steps.stoppedServer(p.name),
          tail: p.reason,
        })
        break
      }
      case 'colony/escalated': {
        const p = e.payload as EventPayloads['colony/escalated']
        out.push({
          ...base,
          kind: 'team',
          agent: p.by,
          lead: copy.steps.handedTo(p.to === 'team'),
          tail: cut(p.reason, 140),
        })
        break
      }
      case 'hook/ran': {
        const p = e.payload as EventPayloads['hook/ran']
        // Hooks that simply passed stay out of the way; the ones that acted are worth seeing.
        if (p.outcome === 'ok') break
        out.push({
          ...base,
          kind: p.outcome === 'feedback' ? 'signal' : 'error',
          agent: p.agent ?? 'system',
          lead:
            p.outcome === 'blocked'
              ? copy.steps.hookBlocked(p.tool)
              : p.outcome === 'asked'
                ? copy.steps.hookAsked(p.tool)
                : p.outcome === 'feedback'
                  ? copy.steps.hookFlagged(p.tool)
                  : copy.steps.hookFailed(p.event, p.code),
          tail: cut(p.message ?? p.command, 140),
        })
        break
      }
      case 'skill/used': {
        const p = e.payload as EventPayloads['skill/used']
        out.push({
          ...base,
          kind: 'search',
          agent: p.agent,
          lead: p.file ? copy.steps.readSkillFile(p.file) : copy.steps.usedSkill,
          strong: p.name,
        })
        break
      }
      case 'memory/proposed': {
        const p = e.payload as EventPayloads['memory/proposed']
        out.push({
          ...base,
          kind: 'signal',
          agent: p.agent,
          lead: copy.steps.proposedMemory,
          tail: cut(p.text, 140),
        })
        break
      }
      case 'worktree/created': {
        const p = e.payload as EventPayloads['worktree/created']
        out.push({ ...base, kind: 'file', agent: p.agent, lead: copy.steps.ownBranch, strong: p.branch })
        break
      }
      case 'worktree/merged': {
        const p = e.payload as EventPayloads['worktree/merged']
        out.push({
          ...base,
          kind: 'file',
          agent: p.agent,
          lead: copy.steps.merged(p.files.length),
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
          lead: copy.steps.broughtChanges(p.files.length),
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
          lead: copy.steps.mergeConflict,
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
            lead: copy.steps.keptBranch,
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
          lead: copy.steps.askedApproval,
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
          lead: p.approved
            ? copy.steps.approved
            : p.by === 'timeout'
              ? copy.steps.notApprovedInTime
              : copy.steps.denied,
          tail: cut(req?.summary ?? '', 120),
        })
        break
      }
      case 'agent/compacted': {
        const p = e.payload as EventPayloads['agent/compacted']
        const method = p.methods?.at(-1) ?? 'summary'
        const kTokens = Math.round(p.tokens / 1000)
        out.push({
          ...base,
          kind: 'think',
          agent: p.agent,
          lead: copy.steps.compacted[method],
          tail:
            method === 'shake'
              ? copy.steps.shakenTail(p.elided ?? 0, kTokens)
              : copy.steps.compactedTail(p.messages, kTokens),
        })
        break
      }
      case 'agent/model': {
        const p = e.payload as EventPayloads['agent/model']
        out.push({
          ...base,
          kind: 'team',
          agent: p.agent,
          lead: copy.steps.switchedTo,
          strong: p.model.split('/').pop() ?? p.model,
          tail: copy.steps.switchedFrom(p.previous.split('/').pop()),
        })
        break
      }
      case 'agent/fallback': {
        const p = e.payload as EventPayloads['agent/fallback']
        out.push({
          ...base,
          kind: 'error',
          agent: p.agent,
          lead: copy.steps.fellBackTo,
          strong: p.model.split('/').pop() ?? p.model,
          tail: copy.steps.fellBackFrom(p.previous.split('/').pop()),
          detail: p.message,
        })
        break
      }
      case 'verifier/requested': {
        const p = e.payload as EventPayloads['verifier/requested']
        out.push({ ...base, kind: 'verdict', agent: p.by, lead: copy.steps.askedJudge })
        break
      }
      case 'verifier/verdict': {
        const p = e.payload as EventPayloads['verifier/verdict']
        // A round nobody reviews records its delivery as a verdict; no judge looked at it.
        if (p.target !== 'colony' || p.verifierId === DELIVERED_VERIFIER) break
        out.push({
          ...base,
          kind: p.pass ? 'verdict' : 'error',
          agent: 'judge',
          lead: p.pass ? copy.steps.judgeApproved : copy.steps.judgeRejected,
          strong: p.score !== undefined ? copy.steps.score(p.score.toFixed(2)) : undefined,
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
          lead: copy.steps.messaged(p.to),
          tail: cut(p.subject || p.body, 100),
        })
        break
      }
      case 'board/posted': {
        const p = e.payload as EventPayloads['board/posted']
        out.push({ ...base, kind: 'talk', agent: p.agent, lead: copy.steps.posted, tail: cut(p.text, 120) })
        break
      }
      case 'computer/keyframe': {
        const p = e.payload as EventPayloads['computer/keyframe']
        out.push({
          ...base,
          kind: 'computer',
          agent: p.agent,
          lead: copy.steps.onMac(p.app),
          strong: p.action.replace(/_/g, ' '),
          ...(p.label ? { tail: cut(p.label, 60) } : {}),
          shot: { colony: e.colonyId, blob: p.blob },
        })
        break
      }
      case 'computer/blocked': {
        const p = e.payload as EventPayloads['computer/blocked']
        const missing = (p.missing ?? [])
          .map((m) =>
            m === 'screen-recording'
              ? copy.computerUse.grants.screenRecording.label
              : copy.computerUse.grants.accessibility.label,
          )
          .join(' & ')
        out.push({
          ...base,
          kind: 'computerSetup',
          agent: p.agent,
          lead: copy.steps.computerSetup,
          tail:
            p.reason === 'install'
              ? copy.computerUse.blocked.install
              : copy.computerUse.blocked.grants(missing),
        })
        break
      }
      case 'observer/signal': {
        const p = e.payload as EventPayloads['observer/signal']
        if (p.severity !== 'info')
          out.push({
            ...base,
            kind: 'signal',
            agent: copy.colonyScreen.agents.observer,
            lead: copy.steps.observer(copy.checkIn.kinds[p.kind] ?? p.kind),
            tail: cut(p.facts, 120),
          })
        break
      }
    }
  }
  return out
}

/** The files agents edited or wrote in these events (the calls that went through), newest first, each once. */
export function editedFiles(events: readonly MyrEvent[]): string[] {
  const asked = new Map<string, string>()
  const done: string[] = []
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      if (p.tool === 'fs_edit' || p.tool === 'fs_write')
        asked.set(p.callId, String((p.args as { path?: unknown } | undefined)?.path ?? ''))
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const path = asked.get(p.callId)
      if (p.ok && path) done.push(path)
    }
  }
  return [...new Set(done.reverse())]
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
        web_search: copy.steps.now.searching(cut(String(args.query ?? ''), 50)),
        web_fetch: copy.steps.now.reading(hostPath(String(args.url ?? ''))),
        publish_artifact: copy.steps.now.writing(args.name),
        fs_write: copy.steps.now.drafting(args.path),
        fs_edit: copy.steps.now.editing(args.path),
        shell: copy.steps.now.runningCommand,
        request_final_verification: copy.steps.now.waitingForJudge,
        // Chats from before the crewmate tools still show their old calls by name.
        spawn_worker: copy.steps.now.bringingIn(args.specialist ?? args.role),
        add_crewmate: copy.steps.now.bringingIn(args.specialist ?? args.role),
        ask_crewmate: copy.steps.now.askingCrewmate(args.to),
        create_task: copy.steps.now.planningTasks,
        reply_user: copy.steps.now.writingReply,
        computer: copy.steps.now.usingMac,
        open_app: copy.steps.now.usingMac,
        list_apps: copy.steps.now.usingMac,
      }
      return copy.steps.now.doing(p.agent, what[p.tool] ?? copy.steps.now.using(p.tool))
    }
    if (e.type === 'agent/turn') {
      const p = e.payload as EventPayloads['agent/turn']
      if (p.phase === 'start') return copy.steps.now.thinking(p.agent)
    }
  }
  return undefined
}
