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

/** The changed lines alone, without the context a hashline edit's change carries around them. */
function changedLines(change: { before: string; after: string }): { old: string; new: string } {
  const before = change.before.split('\n')
  const after = change.after.split('\n')
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  return {
    old: before.slice(head, before.length - tail).join('\n'),
    new: after.slice(head, after.length - tail).join('\n'),
  }
}

/** Each agent's browser, terminal, and editor activity, oldest first. */
export function activityOf(events: readonly MyrEvent[]): Map<string, Activity[]> {
  const out = new Map<string, Activity[]>()
  const pending = new Map<string, Extract<Activity, { kind: 'terminal' }>>()
  const edits = new Map<string, Extract<Activity, { kind: 'editor' }>>()
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
        if (p.tool === 'fs_edit') {
          const edit = {
            kind: 'editor' as const,
            time: e.time,
            path,
            edit: { old: str('old') ?? '', new: str('new') ?? '' },
          }
          edits.set(`${p.agent}/${p.callId}`, edit)
          push(p.agent, edit)
        } else {
          const content = str('content')
          push(p.agent, { kind: 'editor', time: e.time, path, ...(content !== undefined ? { content } : {}) })
        }
      }
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      // A hashline edit's arguments name line numbers; what it changed comes with its result.
      const edit = edits.get(`${p.agent}/${p.callId}`)
      if (edit && p.change) edit.edit = changedLines(p.change)
      edits.delete(`${p.agent}/${p.callId}`)
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

const BROWSING = (tool: string) =>
  tool.startsWith('browser_') || tool === 'request_takeover' || tool === 'request_login'

/** The host of a URL, or the text as it is when it is not one. */
export function siteOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * The agents using their browser now, by name, with the site they are on: those whose latest tool call is a browser
 * one, while the round runs. The site is the latest page their browser showed (a keyframe), else the URL they opened.
 */
export function browsingNow(events: readonly MyrEvent[], running: boolean): Map<string, string> {
  const last = new Map<string, string>()
  const site = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      last.set(p.agent, p.tool)
      const url = (p.args as { url?: unknown } | undefined)?.url
      if (BROWSING(p.tool) && typeof url === 'string' && /^https?:/.test(url)) site.set(p.agent, siteOf(url))
    } else if (e.type === 'browser/keyframe') {
      const p = e.payload as EventPayloads['browser/keyframe']
      if (p.url) site.set(p.agent, siteOf(p.url))
    }
  }
  const out = new Map<string, string>()
  if (!running) return out
  for (const [agent, tool] of last) if (BROWSING(tool)) out.set(agent, site.get(agent) ?? '')
  return out
}
