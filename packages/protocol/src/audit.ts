import type { MyrEvent } from './event.ts'
import type { EventPayloads } from './payloads.ts'

/**
 * What each agent touched, read from the event log: every file, URL and command, plus the calls the person or a
 * hook stopped and the actions flagged as possibly injected. Any client can build its audit view from this.
 */

export type AuditKind = 'file' | 'url' | 'command' | 'search' | 'other'

export interface AuditEntry {
  readonly id: string
  readonly time: string
  readonly agent: string
  readonly tool: string
  readonly kind: AuditKind
  /** What the call did to its target: read, write, edit, list, fetch, open, run, search or call. */
  readonly action: string
  /** The file path, URL, command or query; for other tools, their arguments in short. */
  readonly target: string
  /** Undefined while the call is still running. */
  readonly ok?: boolean
  /** An MCP tool its server marks read-only. */
  readonly readOnly?: boolean
}

export interface AuditTarget {
  readonly kind: AuditKind
  readonly target: string
  readonly actions: string[]
  readonly agents: string[]
  readonly count: number
  readonly failed: number
  readonly last: string
}

export interface AuditStop {
  readonly time: string
  readonly agent: string
  readonly tool: string
  readonly why: string
  readonly by: 'person' | 'timeout' | 'hook' | 'safety'
}

export interface Audit {
  readonly entries: AuditEntry[]
  /** Entries grouped by what they touched, most recent first. */
  readonly targets: AuditTarget[]
  readonly stops: AuditStop[]
}

const FILE_ACTIONS: Record<string, string> = {
  fs_read: 'read',
  fs_write: 'write',
  fs_edit: 'edit',
  fs_list: 'list',
  glob: 'list',
  grep: 'search',
  find: 'search',
  ast_grep: 'search',
  ast_edit: 'edit',
  browser_upload: 'upload',
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

function short(args: unknown): string {
  const text = JSON.stringify(args ?? {})
  return text === '{}' ? '' : text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/** Classifies one tool call by what it touches. */
export function auditCall(tool: string, args: unknown): Pick<AuditEntry, 'kind' | 'action' | 'target'> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const file = FILE_ACTIONS[tool]
  if (file) {
    const path = str(a.path) ?? '.'
    const pattern = str(a.pattern)
    return {
      kind: 'file',
      action: file,
      target: pattern && tool !== 'fs_list' ? `${path} · ${pattern}` : path,
    }
  }
  // Published files, named the way browser_open takes them.
  if (tool === 'publish_artifact' || tool === 'read_artifact')
    return {
      kind: 'file',
      action: tool === 'publish_artifact' ? 'publish' : 'read',
      target: `artifact:${str(a.name) ?? ''}`,
    }
  if (tool === 'shell') return { kind: 'command', action: 'run', target: str(a.command) ?? '' }
  if (tool === 'start_server') return { kind: 'command', action: 'serve', target: str(a.command) ?? '' }
  if (tool === 'web_fetch') return { kind: 'url', action: 'fetch', target: str(a.url) ?? '' }
  if (tool === 'browser_open') return { kind: 'url', action: 'open', target: str(a.url) ?? '' }
  if (tool === 'request_login')
    return { kind: 'url', action: 'sign in', target: str(a.url) ?? str(a.site) ?? '' }
  if (tool === 'web_search') return { kind: 'search', action: 'search', target: str(a.query) ?? '' }
  return { kind: 'other', action: 'call', target: `${tool} ${short(args)}`.trim() }
}

export function auditOf(events: readonly MyrEvent[]): Audit {
  const entries = new Map<string, AuditEntry>()
  const stops: AuditStop[] = []
  const asked = new Map<string, EventPayloads['approval/requested']>()
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      entries.set(p.callId, {
        id: e.id,
        time: e.time,
        agent: p.agent,
        tool: p.tool,
        ...auditCall(p.tool, p.args),
        ...(p.readOnly ? { readOnly: true } : {}),
      })
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const entry = entries.get(p.callId)
      if (entry) entries.set(p.callId, { ...entry, ok: p.ok })
    } else if (e.type === 'approval/requested') {
      const p = e.payload as EventPayloads['approval/requested']
      asked.set(p.id, p)
    } else if (e.type === 'approval/decided') {
      const p = e.payload as EventPayloads['approval/decided']
      const req = asked.get(p.id)
      if (req && !p.approved && p.by !== 'stopped')
        stops.push({ time: e.time, agent: req.agent, tool: req.tool, why: req.summary, by: p.by })
    } else if (e.type === 'hook/ran') {
      const p = e.payload as EventPayloads['hook/ran']
      if (p.outcome === 'blocked')
        stops.push({
          time: e.time,
          agent: p.agent ?? '',
          tool: p.tool ?? '',
          why: p.message ?? p.command,
          by: 'hook',
        })
    } else if (e.type === 'safety/flagged') {
      const p = e.payload as EventPayloads['safety/flagged']
      stops.push({ time: e.time, agent: p.agent, tool: p.tool, why: p.reason, by: 'safety' })
    }
  }
  const list = [...entries.values()]
  const grouped = new Map<string, AuditTarget>()
  for (const entry of list) {
    if (!entry.target) continue
    const key = `${entry.kind}\0${entry.target}`
    const g = grouped.get(key)
    const failed = entry.ok === false ? 1 : 0
    grouped.set(
      key,
      g
        ? {
            ...g,
            actions: g.actions.includes(entry.action) ? g.actions : [...g.actions, entry.action],
            agents: g.agents.includes(entry.agent) ? g.agents : [...g.agents, entry.agent],
            count: g.count + 1,
            failed: g.failed + failed,
            last: entry.time,
          }
        : {
            kind: entry.kind,
            target: entry.target,
            actions: [entry.action],
            agents: [entry.agent],
            count: 1,
            failed,
            last: entry.time,
          },
    )
  }
  const targets = [...grouped.values()].sort((a, b) => b.last.localeCompare(a.last))
  return { entries: list, targets, stops }
}

/** Browser actions that act on a page (a click can submit a form, typing can fill one), unlike reading it. */
const BROWSER_ACTS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_upload',
  'browser_eval',
])

/**
 * Calls that may have changed something outside Myrmidon and cannot be rewound: commands, MCP tools, and actions
 * on web pages. A round that stopped part way shows them before it resumes, and its agents are told about them, so
 * nothing is done twice by accident. Edits to project files are not listed: the round's changes and rewind cover
 * those. Calls that failed outright are left out; ones still running when it stopped are kept.
 */
export function outsideEffects(events: readonly MyrEvent[]): AuditEntry[] {
  return auditOf(events).entries.filter(
    (e) =>
      e.ok !== false &&
      !e.readOnly &&
      (e.kind === 'command' ||
        e.tool.startsWith('mcp__') ||
        BROWSER_ACTS.has(e.tool) ||
        e.tool === 'request_login'),
  )
}

/** One line per effect, for agents and the person: "ran `npm publish`", "called mcp__github_create_issue {…}". */
export function describeEffect(e: AuditEntry): string {
  const what =
    e.kind === 'command'
      ? `${e.action === 'serve' ? 'started' : 'ran'} \`${e.target}\``
      : e.tool.startsWith('browser_') || e.tool === 'request_login'
        ? `${e.tool.replace(/^browser_/, '')} on a web page ${e.target.replace(/^\S+\s*/, '')}`.trim()
        : `called ${e.target}`
  return `${what}${e.ok === undefined ? ' (still running when it stopped)' : ''}`
}
