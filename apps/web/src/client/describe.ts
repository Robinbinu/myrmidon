import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** One-line human summary of an event, used by the timeline and the event feed. */
export function describeEvent(e: MyrEvent): string {
  const p = e.payload as never
  switch (e.type) {
    case 'colony/created':
      return `colony created: ${(p as EventPayloads['colony/created']).name}`
    case 'colony/started':
      return 'colony started'
    case 'colony/stopped':
      return `colony stopped: ${(p as EventPayloads['colony/stopped']).reason}`
    case 'colony/completed':
      return 'colony COMPLETED (verified)'
    case 'agent/status': {
      const s = p as EventPayloads['agent/status']
      return `${s.agent} → ${s.status}${s.detail ? ` (${short(s.detail, 50)})` : ''}`
    }
    case 'agent/turn': {
      const s = p as EventPayloads['agent/turn']
      return `${s.agent} turn ${s.turn} ${s.phase} [${s.trigger}]`
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
      return `${s.agent} ◂ ${s.tool} ${s.ok ? 'ok' : 'ERROR'}: ${short(s.output, 70)}`
    }
    case 'board/posted': {
      const s = p as EventPayloads['board/posted']
      return `${s.agent} on board: ${short(s.text)}`
    }
    case 'note/appended': {
      const s = p as EventPayloads['note/appended']
      return `${s.agent} noted: ${short(s.text)}`
    }
    case 'mail/sent': {
      const s = p as EventPayloads['mail/sent']
      return `${s.from} ✉ ${s.to}: ${short(s.subject || s.body, 60)}`
    }
    case 'mail/delivered':
      return `mail delivered to ${(p as EventPayloads['mail/delivered']).to}`
    case 'task/changed': {
      const s = p as EventPayloads['task/changed']
      return `${s.task.id} → ${s.task.status}${s.task.owner ? ` (${s.task.owner})` : ''}: ${short(s.task.subject, 50)}`
    }
    case 'artifact/versioned': {
      const s = p as EventPayloads['artifact/versioned']
      return `${s.author} published ${s.name} v${s.version}`
    }
    case 'observer/signal': {
      const s = p as EventPayloads['observer/signal']
      return `observer ${s.kind}/${s.severity}: ${short(s.facts)}`
    }
    case 'verifier/requested':
      return `${(p as EventPayloads['verifier/requested']).by} requested verification`
    case 'verifier/verdict': {
      const s = p as EventPayloads['verifier/verdict']
      return `verdict ${s.verifierId} on ${s.target}: ${s.pass ? 'PASS' : 'FAIL'}`
    }
    default:
      return e.type
  }
}
