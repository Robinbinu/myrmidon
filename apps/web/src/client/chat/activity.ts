import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'

/** What an agent was doing on its computer at one moment, for the Computer view. */
export type Activity =
  | { kind: 'browser'; time: string }
  | { kind: 'terminal'; time: string; command: string; output?: string; ok?: boolean }
  | {
      kind: 'editor'
      time: string
      path: string
      /** The whole file, for a write or publish. */
      content?: string
      /** The replaced snippet, for an edit. */
      edit?: { old: string; new: string }
    }

const EDITORS = new Set(['fs_write', 'fs_edit', 'publish_artifact'])

/** Each agent's browser, terminal, and editor activity, oldest first. */
export function activityOf(events: readonly MyrEvent[]): Map<string, Activity[]> {
  const out = new Map<string, Activity[]>()
  const pending = new Map<string, Extract<Activity, { kind: 'terminal' }>>()
  const push = (agent: string, a: Activity) => {
    const list = out.get(agent) ?? []
    list.push(a)
    out.set(agent, list)
  }
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      const args = (p.args ?? {}) as Record<string, unknown>
      const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
      if (p.tool.startsWith('browser_')) push(p.agent, { kind: 'browser', time: e.time })
      else if (p.tool === 'shell') {
        const run = { kind: 'terminal' as const, time: e.time, command: str('command') ?? '' }
        pending.set(`${p.agent}/${p.callId}`, run)
        push(p.agent, run)
      } else if (EDITORS.has(p.tool)) {
        const path = str('path') ?? str('name') ?? str('fromScratch') ?? 'file'
        if (p.tool === 'fs_edit')
          push(p.agent, {
            kind: 'editor',
            time: e.time,
            path,
            edit: { old: str('old') ?? '', new: str('new') ?? '' },
          })
        else {
          const content = str('content')
          push(p.agent, { kind: 'editor', time: e.time, path, ...(content !== undefined ? { content } : {}) })
        }
      }
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const run = pending.get(`${p.agent}/${p.callId}`)
      if (run) {
        run.output = p.output
        run.ok = p.ok
        pending.delete(`${p.agent}/${p.callId}`)
      }
    }
  }
  return out
}
