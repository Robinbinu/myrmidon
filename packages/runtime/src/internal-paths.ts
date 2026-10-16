import type { ColonyState } from '@myrmidon/protocol'
import { type ConflictEntry, type ConflictHistory, type Conflicts, loadConflicts } from './omp/conflicts.ts'
import { prompts } from './prompts.ts'

/**
 * Internal paths the file tools take beside file paths, after omp's internal URLs (internal-urls/): `pr://N` and
 * `issue://N` read GitHub through `gh` (read-only), `conflict://N` reads one merge-conflict block and fs_write
 * resolves it (`conflict://*` resolves them all), `skill://name[/file]` reads a skill, `agent://name` what a crewmate
 * has done. Each is read through the tool that would read it anyway (github, use_skill, the round's state), so the
 * permission model and the workspace's checks decide it as they decide that tool.
 */

export const INTERNAL_SCHEMES = ['pr', 'issue', 'conflict', 'skill', 'agent'] as const
export type InternalScheme = (typeof INTERNAL_SCHEMES)[number]

const INTERNAL = /^(pr|issue|conflict|skill|agent):\/\/(.*)$/s

/** The internal path `path` names, or undefined for a file path. */
export function internalPath(path: string): { scheme: InternalScheme; rest: string } | undefined {
  const m = INTERNAL.exec(path.trim())
  return m ? { scheme: m[1] as InternalScheme, rest: m[2] ?? '' } : undefined
}

/** What each scheme reads with, given by the tool that holds the round (tools.ts). */
export interface InternalReaders {
  /** `gh pr view` / `gh pr diff` / `gh issue view`, decided as the github tool's reads. */
  github(
    op: 'pr_view' | 'pr_diff' | 'issue_view',
    ref: { pr?: string; issue?: string; repo?: string },
  ): Promise<string>
  /** A skill's instructions or one of its files, as use_skill reads them; with no name, the skills on offer. */
  skill(name?: string, file?: string): Promise<string>
  /** The round's state, for agent://. */
  state(): ColonyState
  /** The agent reading, which agent:// answers for. */
  agent: string
  conflicts: ConflictHistory
}

/** `owner/repo/N`, `N` or `N/diff`: the repo, the number, and whether the pull request's diff is wanted. */
function githubRef(rest: string): { repo?: string; number: string; diff: boolean } {
  const parts = rest.replace(/\/+$/, '').split('/')
  const diff = parts.at(-1) === 'diff'
  if (diff) parts.pop()
  const number = parts.pop() ?? ''
  if (!/^\d+$/.test(number)) throw new Error(prompts.internalPaths.githubShape)
  const repo = parts.length === 2 ? parts.join('/') : undefined
  if (parts.length && !repo) throw new Error(prompts.internalPaths.githubShape)
  return { ...(repo ? { repo } : {}), number, diff }
}

/** The text an internal path reads as. */
export async function readInternal(path: string, readers: InternalReaders): Promise<string> {
  const target = internalPath(path)
  if (!target) throw new Error(`not an internal path: ${path}`)
  switch (target.scheme) {
    case 'pr': {
      const ref = githubRef(target.rest)
      return readers.github(ref.diff ? 'pr_diff' : 'pr_view', {
        pr: ref.number,
        ...(ref.repo ? { repo: ref.repo } : {}),
      })
    }
    case 'issue': {
      const ref = githubRef(target.rest)
      if (ref.diff) throw new Error(prompts.internalPaths.githubShape)
      return readers.github('issue_view', { issue: ref.number, ...(ref.repo ? { repo: ref.repo } : {}) })
    }
    case 'skill': {
      const [name, ...file] = target.rest.split('/').filter(Boolean)
      return readers.skill(name, file.length ? file.join('/') : undefined)
    }
    case 'agent':
      return agentReport(readers.state(), readers.agent, target.rest.replace(/\/+$/, ''))
    case 'conflict': {
      const c = await loadConflicts()
      const parsed = c.parseConflictUri(path.trim())
      if (!parsed) throw new Error(prompts.internalPaths.conflictShape)
      if (parsed.id === '*') throw new Error(prompts.internalPaths.conflictWildcardRead)
      const entry = readers.conflicts.get(parsed.id)
      if (!entry) throw new Error(prompts.internalPaths.conflictUnknown(parsed.id))
      const { lines, startLine } = conflictRegion(entry, parsed.scope)
      return lines.map((line, i) => `${String(startLine + i).padStart(5)}\t${line}`).join('\n')
    }
  }
}

/**
 * A conflict block as read (its markers and sides), or one side's body, with the file line its first line is on;
 * after omp's renderConflictRegion (pi-tui tools/conflict-detect.ts).
 */
function conflictRegion(
  entry: ConflictEntry,
  scope?: 'ours' | 'theirs' | 'base',
): { lines: string[]; startLine: number } {
  if (scope === 'ours') return { lines: [...entry.oursLines], startLine: entry.startLine + 1 }
  if (scope === 'theirs') return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 }
  if (scope === 'base') {
    if (!entry.baseLines || entry.baseLine === undefined)
      throw new Error(prompts.internalPaths.noBase(entry.id))
    return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 }
  }
  const marker = (prefix: string, label?: string) => (label ? `${prefix} ${label}` : prefix)
  return {
    lines: [
      marker('<<<<<<<', entry.oursLabel),
      ...entry.oursLines,
      ...(entry.baseLines ? [marker('|||||||', entry.baseLabel), ...entry.baseLines] : []),
      '=======',
      ...entry.theirsLines,
      marker('>>>>>>>', entry.theirsLabel),
    ],
    startLine: entry.startLine,
  }
}

/** What a crewmate has done this round, as `agent://name` reads it; with no name, who there is. */
function agentReport(state: ColonyState, reader: string, name: string): string {
  const say = prompts.internalPaths
  if (!name) {
    const rows = Object.values(state.agents).map((a) => say.agentRow(a.info.name, a.info.role, a.status))
    return rows.length ? say.agents(rows) : say.noAgents
  }
  const view = state.agents[name]
  if (!view) throw new Error(say.agentUnknown(name, Object.keys(state.agents)))
  const tasks = Object.values(state.tasks)
    .filter((t) => t.owner === name || t.assignee === name)
    .map((t) => say.agentTask(t.id, t.subject, t.status, t.artifacts))
  const notes = state.notes
    .filter((n) => n.agent === name)
    .slice(-5)
    .map((n) => say.agentNote(n.text))
  // Only what the reader could see anyway: what it was sent, and what went to the whole team.
  const sent = state.mail
    .filter((m) => m.from === name && (m.to === reader || m.to === 'team' || m.members?.includes(reader)))
    .slice(-5)
    .map((m) => say.agentMail(m.to, m.subject, m.body))
  return say.agent({
    name,
    role: view.info.role,
    model: view.info.model,
    status: view.status,
    ...(view.detail ? { detail: view.detail } : {}),
    tasks,
    notes,
    sent,
  })
}

/**
 * The conflict blocks in the lines a read shows (`window`, starting at file line `first`), numbered in the agent's
 * registry, and omp's footer naming them; '' when there are none. `total` is how many the whole file holds.
 */
export async function noteConflicts(
  conflicts: ConflictHistory,
  absolutePath: string,
  displayPath: string,
  text: string,
  window?: { first: number; count?: number },
): Promise<string> {
  if (!text.includes('<<<<<<<')) return ''
  const c = await loadConflicts()
  const lines = text.split('\n')
  const all = c.scanConflictLines(lines, 1)
  if (!all.length) return ''
  const first = window?.first ?? 1
  const last = window?.count === undefined ? lines.length : first + window.count - 1
  const shown = all
    .filter((b) => b.startLine >= first && b.endLine <= last)
    .map((b) => conflicts.register({ ...b, absolutePath, displayPath }))
  if (!shown.length) return prompts.internalPaths.conflictsOutside(all.length)
  return omp(c.formatConflictWarning(shown, { totalInFile: all.length, displayPath }))
}

/** omp's wording names its own tools; here they are fs_read and fs_write. */
function omp(text: string): string {
  return text
    .replaceAll('`write({', '`fs_write({')
    .replaceAll('issuing multiple `write` calls', 'issuing multiple `fs_write` calls')
    .replaceAll('(read `', '(fs_read `')
    .replaceAll('by reading `conflict://', 'with fs_read `conflict://')
    .replaceAll(' `<path>:conflicts` read selector', ' fs_read of the whole file')
}

/** Per-id directives of a `conflict://*` write (`3: @ours`), after omp's parseBulkDirectives; undefined for uniform. */
function directives(content: string): Map<number, string> | undefined {
  const map = new Map<number, string>()
  const stray: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/.exec(line)
    if (!m) {
      stray.push(line)
      continue
    }
    const id = Number(m[1])
    if (map.has(id)) throw new Error(prompts.internalPaths.directiveTwice(id))
    map.set(id, m[2] as string)
  }
  if (!map.size) return undefined
  if (stray.length) throw new Error(prompts.internalPaths.directivesMixed(stray.length, stray[0] ?? ''))
  return map
}

/** One file's new text after conflicts are resolved, with the ids it resolved. */
export interface ConflictWrite {
  readonly absolutePath: string
  readonly displayPath: string
  readonly before: string
  readonly after: string
  readonly ids: readonly number[]
}

/**
 * What an fs_write to `conflict://N` or `conflict://*` changes, per file, without writing: each block is spliced with
 * its tokens expanded per block (omp's spliceConflict and expandContentTokens), bottom-up so earlier anchors hold.
 * `read` gives a file's current text; a file whose splices fail is reported and left out.
 */
export async function planConflictWrite(
  path: string,
  content: string,
  conflicts: ConflictHistory,
  read: (absolutePath: string) => string,
): Promise<{ writes: ConflictWrite[]; failed: string[] }> {
  const c: Conflicts = await loadConflicts()
  const parsed = c.parseConflictUri(path.trim())
  if (!parsed) throw new Error(prompts.internalPaths.conflictShape)
  if (parsed.scope) throw new Error(prompts.internalPaths.conflictScopeWrite(String(parsed.id), parsed.scope))
  let chosen: { entry: ConflictEntry; content: string }[]
  if (parsed.id === '*') {
    const per = directives(content)
    const entries = conflicts.entries()
    if (!entries.length) throw new Error(prompts.internalPaths.noConflicts)
    if (per) {
      const unknown = [...per.keys()].filter((id) => !conflicts.get(id))
      if (unknown.length) throw new Error(prompts.internalPaths.conflictUnknown(unknown[0] ?? 0))
    }
    chosen = per
      ? entries.filter((e) => per.has(e.id)).map((e) => ({ entry: e, content: per.get(e.id) ?? '' }))
      : entries.map((e) => ({ entry: e, content }))
  } else {
    const entry = conflicts.get(parsed.id)
    if (!entry) throw new Error(prompts.internalPaths.conflictUnknown(parsed.id))
    chosen = [{ entry, content }]
  }
  const byFile = Map.groupBy(chosen, (x) => x.entry.absolutePath)
  const writes: ConflictWrite[] = []
  const failed: string[] = []
  for (const [absolutePath, items] of byFile) {
    const displayPath = items[0]?.entry.displayPath ?? absolutePath
    try {
      const before = read(absolutePath)
      let after = before
      for (const { entry, content: text } of items.sort((a, b) => b.entry.startLine - a.entry.startLine))
        after = c.spliceConflict(after, entry, c.expandContentTokens(text, entry)).text
      writes.push({
        absolutePath,
        displayPath,
        before,
        after,
        ids: items.map((x) => x.entry.id).sort((a, b) => a - b),
      })
    } catch (err) {
      failed.push(`${displayPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { writes, failed }
}
