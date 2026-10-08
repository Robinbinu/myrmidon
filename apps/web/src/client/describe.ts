import { DELIVERED_VERIFIER, type EventPayloads, type MyrEvent } from '@myrmidon/protocol'
import { copy } from './copy.ts'

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** One-line human summary of an event, used by the timeline and the event feed. */
export function describeEvent(e: MyrEvent): string {
  const p = e.payload as never
  switch (e.type) {
    case 'colony/created':
      return copy.events.colonyCreated((p as EventPayloads['colony/created']).name)
    case 'colony/started':
      return copy.events.crewStarted
    case 'colony/stopped':
      return copy.events.colonyStopped((p as EventPayloads['colony/stopped']).reason)
    case 'colony/completed':
      return copy.events.crewCompleted
    case 'agent/status': {
      const s = p as EventPayloads['agent/status']
      return `${s.agent} → ${copy.status.agent[s.status === 'completed' ? 'done' : s.status]}${s.detail ? ` (${short(s.detail, 50)})` : ''}`
    }
    case 'agent/turn': {
      const s = p as EventPayloads['agent/turn']
      return copy.events.turn(s.agent, s.turn, s.phase, s.trigger)
    }
    case 'llm/response': {
      const s = p as EventPayloads['llm/response']
      return `${s.agent} ⇠ ${s.model}: ${s.toolCalls.length ? s.toolCalls.map((t) => t.name).join(', ') : short(s.text || s.stopReason)}`
    }
    case 'tool/call': {
      const s = p as EventPayloads['tool/call']
      return `${s.agent} ▸ ${s.tool}`
    }
    case 'tool/result': {
      const s = p as EventPayloads['tool/result']
      return `${s.agent} ◂ ${s.tool} ${s.ok ? copy.events.ok : copy.events.error}: ${short(s.output, 70)}`
    }
    case 'board/posted': {
      const s = p as EventPayloads['board/posted']
      return copy.events.onBoard(s.agent, short(s.text))
    }
    case 'note/appended': {
      const s = p as EventPayloads['note/appended']
      return copy.events.noted(s.agent, short(s.text))
    }
    case 'mail/sent': {
      const s = p as EventPayloads['mail/sent']
      return `${s.from} ✉ ${s.to}: ${short(s.subject || s.body, 60)}`
    }
    case 'mail/delivered':
      return copy.events.mailDelivered((p as EventPayloads['mail/delivered']).to)
    case 'task/changed': {
      const s = p as EventPayloads['task/changed']
      return `${s.task.id} → ${copy.workspace.taskStatus[s.task.status]}${s.task.owner ? ` (${s.task.owner})` : ''}: ${short(s.task.subject, 50)}`
    }
    case 'artifact/versioned': {
      const s = p as EventPayloads['artifact/versioned']
      return copy.events.published(s.author, s.name, s.version)
    }
    case 'observer/signal': {
      const s = p as EventPayloads['observer/signal']
      return copy.events.observer(
        copy.checkIn.kinds[s.kind] ?? s.kind,
        copy.checkIn.severities[s.severity] ?? s.severity,
        short(s.facts),
      )
    }
    case 'verifier/requested':
      return copy.events.verificationRequested((p as EventPayloads['verifier/requested']).by)
    case 'verifier/verdict': {
      const s = p as EventPayloads['verifier/verdict']
      if (s.verifierId === DELIVERED_VERIFIER) return copy.events.notReviewed
      return copy.events.verdict(s.verifierId, copy.reviewTarget(s.target), s.pass)
    }
    default:
      return e.type
  }
}
