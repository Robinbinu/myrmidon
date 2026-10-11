import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { HASHLINE_POLICY, STR_REPLACE_MODELS } from './config.ts'
import { classifyModel } from './omp/catalog.ts'
import {
  type EditPolicy,
  EditSession,
  EditStore,
  editInspect,
  hashlineFormatHeader,
  hashlineFormatNumberedLines,
} from './omp/natives.ts'
import { prompts } from './prompts.ts'

/**
 * Hashline edits, omp's edit model (pi-edit, in the native addon): fs_read shows a text file as a `[path#TAG]` header,
 * TAG a 4-hex hash of the whole file, and `N:line` rows; fs_edit names the lines to change by those numbers under that
 * header. The engine keeps every snapshot an agent was shown, so an edit after its own earlier edit is carried over,
 * one after a change made elsewhere is remapped when the lines it touches are unchanged and refused otherwise, and an
 * edit on lines no read showed in full is refused with what they hold.
 */

/** `hashline`: line anchors under a file tag. `replace`: exact old text replaced, for models that do worse with anchors. */
export type EditMode = 'hashline' | 'replace'

/**
 * The edit mode for a model, as omp's resolveEditMode picks it with its defaults (edit.mode hashline): hashline unless
 * the model is one omp falls back to replace for (STR_REPLACE_MODELS).
 */
export function editModeFor(model: string): EditMode {
  const id = classifyModel('', model, { lenient: true })
  const replace = STR_REPLACE_MODELS.some(
    (m) =>
      (m.class === '*' || m.class === id.class) &&
      (m.family === undefined || m.family === id.family) &&
      (m.revision === undefined || m.revision === id.revision),
  )
  return replace ? 'replace' : 'hashline'
}

interface AgentEdits {
  mode: EditMode
  readonly store: EditStore
}

/** Each agent's edit mode and the snapshots it was shown, per round. */
const edits = new WeakMap<object, Map<string, AgentEdits>>()

function editsOf(host: object, agent: string): AgentEdits {
  const byAgent = edits.get(host) ?? new Map<string, AgentEdits>()
  edits.set(host, byAgent)
  const found = byAgent.get(agent)
  if (found) return found
  const made = { mode: 'replace' as EditMode, store: new EditStore() }
  byAgent.set(agent, made)
  return made
}

/** Fixes the agent's edit mode when its tools are built (its fs_edit parameters follow it). */
export function setEditMode(host: object, agent: string, mode: EditMode): void {
  editsOf(host, agent).mode = mode
}

/** The agent's edit mode: `replace` unless its tools were built for a hashline model. */
export function editModeOf(host: object, agent: string): EditMode {
  return edits.get(host)?.get(agent)?.mode ?? 'replace'
}

/** The `[path#TAG]` header for `text`, recorded as the snapshot of `file` with `seen` the lines shown in full. */
export function snapshotHeader(
  host: object,
  agent: string,
  file: string,
  shown: string,
  text: string,
  seen: readonly number[],
): string {
  const tag = editsOf(host, agent).store.recordSnapshot(file, text, [...seen])
  return hashlineFormatHeader(shown, tag)
}

/** `N:line` rows for `lines`, the first numbered `first`. */
export function numberedRows(lines: readonly string[], first: number): string {
  return hashlineFormatNumberedLines(lines.join('\n'), first)
}

const HEADER = /^\[(.+)#([0-9A-Fa-f]{4})\][ \t]*$/

/** What a hashline edit changed, as the lines around it before and after (for the person's diff). */
export interface LineChange {
  readonly before: string
  readonly after: string
}

/**
 * Applies a hashline `input` to one file (`file`, absolute and real) through the engine. `sameFile` says whether the
 * header's path names that file; `write` asks for and writes the new content and returns what it wrote (the person
 * may have rewritten it). Throws what the engine or `write` refused, the engine's text being what the model reads.
 */
export async function applyHashline(options: {
  readonly host: object
  readonly agent: string
  readonly cwd: string
  readonly file: string
  readonly shown: string
  readonly input: string
  readonly sameFile: (path: string) => boolean
  readonly write: (content: string) => Promise<string>
}): Promise<{ text: string; change?: LineChange }> {
  const t = prompts.toolResults
  const lines = options.input.split('\n')
  const headers = lines.flatMap((l, i) => {
    const m = HEADER.exec(l.trim())
    return m ? [{ index: i, path: m[1] as string, tag: m[2] as string }] : []
  })
  const header = headers[0]
  if (!header) throw new Error(t.hashlineNoHeader(options.shown))
  if (headers.some((h) => h.path !== header.path)) throw new Error(t.hashlineOneFile)
  if (!options.sameFile(header.path)) throw new Error(t.hashlineOtherFile(header.path, options.shown))
  // The engine resolves the header against cwd; naming the file the way it was resolved keeps one snapshot key.
  const inside = relative(options.cwd, options.file)
  const named = inside && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? inside : options.file
  for (const h of headers) lines[h.index] = `[${named}#${h.tag.toUpperCase()}]`
  const args = JSON.stringify({ input: lines.join('\n') })
  if (editInspect('hashline', args).fileOps.length > 0) throw new Error(t.hashlineFileOps)

  const policy: EditPolicy = {
    cwd: options.cwd,
    mode: 'hashline',
    ...HASHLINE_POLICY,
    planActive: false,
    urlSchemes: [],
    urlAliasSchemes: [],
    planWritableRoots: [],
    homeDir: homedir(),
    rawInput: false,
  }
  const session = new EditSession(editsOf(options.host, options.agent).store, policy)
  // The engine turns a failed write into its own error text; the original (a denial, a decline) is what the agent sees.
  let refused: unknown
  try {
    session.setArgsJson(args)
    session.finish()
    const outcome = await session.apply({ lspFlush: false }, async (_err, request) => {
      const target = request.path === options.file || options.sameFile(request.path)
      if (request.op !== 'update' || request.content === undefined || !target)
        throw new Error(t.hashlineFileOps)
      try {
        return { written: await options.write(request.content) }
      } catch (err) {
        refused = err
        throw err
      }
    })
    if (refused !== undefined) throw refused
    if (outcome.isError) throw new Error(outcome.text)
    const diff = outcome.files[0]?.diff
    return { text: outcome.text, ...(diff ? { change: lineChange(diff) } : {}) }
  } finally {
    session.close()
  }
}

/** The engine's numbered diff (` N|same`, `-N|old`, `+N|new`) as before and after text, `…` between its hunks. */
export function lineChange(diff: string): LineChange {
  const before: string[] = []
  const after: string[] = []
  let last: number | undefined
  for (const row of diff.split('\n')) {
    const m = /^([ +-])(\d+)\|(.*)$/.exec(row)
    if (!m) continue
    const [, mark, num, text = ''] = m
    const line = Number(num)
    if (mark !== '+' && last !== undefined && line > last + 1) {
      before.push('…')
      after.push('…')
    }
    if (mark !== '+') last = line
    if (mark !== '+') before.push(text)
    if (mark !== '-') after.push(text)
  }
  return { before: before.join('\n'), after: after.join('\n') }
}
