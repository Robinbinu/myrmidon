import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  IMPORT_HISTORY_CHARS,
  IMPORT_LIST_MAX,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_TURNS,
  IMPORT_PREVIEW_CHARS,
  IMPORT_SCAN_BYTES,
  IMPORT_TOOL_ARGS_CHARS,
  IMPORT_TOOL_RESULT_CHARS,
  IMPORT_TURN_CHARS,
} from './config.ts'
import type { ImageContent, Message, TextContent } from './omp/ai.ts'
import type { ForeignSessionInfo, ForeignSessionStore, SessionEntry } from './omp/sessions.ts'
import { ClaudeSessionStore, CodexSessionStore } from './omp/sessions.ts'
import type { ProjectStore } from './projects.ts'
import { prompts } from './prompts.ts'
import { realPath, within } from './read-access.ts'
import { redactSecrets } from './secrets.ts'

/**
 * Claude Code and Codex sessions brought into Myrmidon: listed from the tools' own folders (read only), and one turned
 * into a new chat whose first round starts from its conversation, as a fork starts from another chat's. Reading and
 * converting the transcripts is omp's importer (`omp --from-claude` / `--from-codex`), used as a library; this module
 * lists them for a picker, flattens the converted conversation into what the chat shows and the round reads, and
 * keeps that (redacted and clipped) as `<home>/imports/<id>.json`.
 */

export type ImportSource = 'claude' | 'codex'

export const IMPORT_SOURCES: readonly ImportSource[] = ['claude', 'codex']

/** A session another tool keeps, as the import list shows it. */
export interface ImportableSession {
  readonly source: ImportSource
  readonly id: string
  /** The folder the session worked in. */
  readonly cwd: string
  readonly title?: string
  /** The person's first message, clipped. */
  readonly preview?: string
  /** Its last activity. */
  readonly updatedAt: string
  /** How many messages it holds, when the tool's index says (counting would read every transcript). */
  readonly messages?: number
  /** The transcript's size on disk. */
  readonly bytes: number
  /** The Myrmidon project whose folder holds `cwd`, if any. */
  readonly project?: { readonly id: string; readonly name: string }
}

/** One message of an imported conversation, flattened for the chat view and the round's context. */
export interface ImportedTurn {
  readonly role: 'user' | 'assistant' | 'tool' | 'summary'
  readonly text: string
  /** A tool call's tool. */
  readonly tool?: string
  /** A tool call's result, clipped. */
  readonly result?: string
  readonly error?: boolean
}

/** An imported session: what a new chat starts from. */
export interface ImportedSession {
  readonly id: string
  readonly source: ImportSource
  readonly sourceId: string
  readonly title: string
  readonly cwd: string
  readonly project?: { readonly id: string; readonly name: string }
  /** When the source session was last active, and when it was imported. */
  readonly updatedAt: string
  readonly importedAt: string
  /** The latest messages that fit the import's size; `omitted` earlier ones were left out. */
  readonly turns: readonly ImportedTurn[]
  readonly omitted: number
}

const IMPORT_ID = /^import-[a-z0-9-]{1,40}$/

/** Whether `id` can name an import (and so a file under `<home>/imports`). */
export const isImportId = (id: string) => IMPORT_ID.test(id)

/**
 * Text the tools put in the person's turn that the person did not write: Claude Code's slash-command echoes, hook
 * output and reminders; Codex's environment context and AGENTS.md instructions.
 */
const NOT_SAID =
  /^(?:<(?:environment_context|user_instructions|permissions instructions|local-command-[a-z]+|command-(?:name|message|args)|system-reminder|user-prompt-submit-hook)\b|# AGENTS\.md instructions|Caveat: The messages below were generated)/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
/** Redacted before clipping, so a secret cut in half is not left half in clear. */
const clean = (text: string, max: number) => clip(redactSecrets(text).trim(), max)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function said(text: string): string | undefined {
  const rest = text.replace(REMINDER, '').trim()
  return rest && !NOT_SAID.test(rest) ? rest : undefined
}

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n')
}

/** What a tool call was about, in a line: its command, file, pattern or query when it has one, else its arguments. */
function argsLine(args: Record<string, unknown>): string {
  for (const key of [
    'command',
    'cmd',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
    'input',
  ]) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return oneLine(value)
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return oneLine(value.join(' '))
  }
  const json = JSON.stringify(args)
  return json === '{}' ? '' : json
}

/**
 * A converted session's conversation along its current branch, as turns: thinking left out, each tool result joined to
 * its call. Custom messages (omp's own kinds, never made by the importers) are skipped.
 */
export function turnsOf(entries: readonly SessionEntry[]): ImportedTurn[] {
  const turns: ImportedTurn[] = []
  const calls = new Map<string, number>()
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      const text = clean(entry.summary, IMPORT_TURN_CHARS)
      if (text) turns.push({ role: 'summary', text })
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message as Message
    if (message.role === 'user') {
      const text = said(textOf(message.content))
      if (text) turns.push({ role: 'user', text: clean(text, IMPORT_TURN_CHARS) })
    } else if (message.role === 'assistant') {
      let text = ''
      const flush = () => {
        const t = clean(text, IMPORT_TURN_CHARS)
        if (t) turns.push({ role: 'assistant', text: t })
        text = ''
      }
      for (const part of message.content) {
        if (part.type === 'text') text += (text ? '\n' : '') + part.text
        else if (part.type === 'toolCall') {
          flush()
          calls.set(part.id, turns.length)
          turns.push({
            role: 'tool',
            tool: part.name,
            text: clean(argsLine(part.arguments), IMPORT_TOOL_ARGS_CHARS),
          })
        }
      }
      flush()
    } else if (message.role === 'toolResult') {
      const at = calls.get(message.toolCallId)
      const call = at === undefined ? undefined : turns[at]
      if (!call || at === undefined) continue
      const result = clean(textOf(message.content), IMPORT_TOOL_RESULT_CHARS)
      turns[at] = { ...call, ...(result ? { result } : {}), ...(message.isError ? { error: true } : {}) }
    }
  }
  return turns
}

/** One turn as the round reads it. */
function turnLine(turn: ImportedTurn): string {
  const p = prompts.imported
  if (turn.role === 'user') return p.user(turn.text)
  if (turn.role === 'assistant') return p.assistant(turn.text)
  if (turn.role === 'summary') return p.summary(turn.text)
  return p.tool(turn.tool ?? 'a tool', turn.text, turn.result, turn.error === true)
}

/** The latest turns that fit the import's size, and how many earlier ones were left out. */
export function fitTurns(turns: readonly ImportedTurn[]): { turns: ImportedTurn[]; omitted: number } {
  let size = 0
  let from = turns.length
  while (from > 0 && turns.length - from < IMPORT_MAX_TURNS) {
    const next = turnLine(turns[from - 1] as ImportedTurn).length + 2
    if (size + next > IMPORT_HISTORY_CHARS) break
    size += next
    from--
  }
  return { turns: turns.slice(from), omitted: from }
}

const TOOL_NAMES: Record<ImportSource, string> = { claude: 'Claude Code', codex: 'Codex' }

/** The imported conversation as the new chat's first round reads it (`ChatSpec.history`). */
export function importedConversation(session: ImportedSession): string {
  return [
    prompts.imported.intro(TOOL_NAMES[session.source], session.cwd, session.omitted),
    ...session.turns.map(turnLine),
  ].join('\n\n')
}

interface Scanned {
  title?: string
  preview?: string
}

function records(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value))
        out.push(value as Record<string, unknown>)
    } catch {
      // The slices cut lines at both ends, and a tool may be writing the last one.
    }
  }
  return out
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

/** A user record's own words (Claude Code), or undefined for tool results, commands and reminders. */
function claudePrompt(r: Record<string, unknown>): string | undefined {
  if (r.type !== 'user' || r.isMeta === true || r.isSidechain === true) return undefined
  const content = (r.message as { content?: unknown } | undefined)?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string',
            )
            .map((b) => b.text)
            .join('\n')
        : ''
  return said(text)
}

/** The person's first message in a Codex rollout. */
function codexPrompt(r: Record<string, unknown>): string | undefined {
  const p = r.payload as Record<string, unknown> | undefined
  if (!p) return undefined
  if (r.type === 'event_msg' && p.type === 'user_message') return said(str(p.message) ?? '')
  if (r.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content))
    return said(
      p.content
        .filter((c): c is { text: string } => typeof c?.text === 'string')
        .map((c) => c.text)
        .join('\n'),
    )
  return undefined
}

/** Reads a transcript's start and end for its title and first message, never the whole file. */
async function scan(source: ImportSource, path: string, bytes: number): Promise<Scanned> {
  const file = Bun.file(path)
  const head = records(await file.slice(0, IMPORT_SCAN_BYTES).text())
  const tail = bytes > IMPORT_SCAN_BYTES ? records(await file.slice(bytes - IMPORT_SCAN_BYTES).text()) : []
  const out: Scanned = {}
  if (source === 'claude') {
    // A title the person gave beats Claude's own, which beats a summary; the latest of each kind wins.
    let custom: string | undefined
    let ai: string | undefined
    let summary: string | undefined
    for (const r of [...head, ...tail]) {
      if (r.type === 'custom-title') custom = str(r.customTitle) ?? custom
      else if (r.type === 'ai-title') ai = str(r.aiTitle) ?? ai
      else if (r.type === 'summary') summary = str(r.summary) ?? summary
    }
    const title = custom ?? ai ?? summary
    if (title) out.title = title
    for (const r of head) {
      const text = claudePrompt(r)
      if (text) {
        out.preview = text
        break
      }
    }
    return out
  }
  for (const r of head) {
    const text = codexPrompt(r)
    if (text) {
      out.preview = text
      break
    }
  }
  return out
}

/** Lists and imports other tools' sessions. Roots default to where Claude Code and Codex keep theirs. */
export class SessionImports {
  private readonly _dir: string
  private readonly _stores: Record<ImportSource, ForeignSessionStore>

  constructor(
    home: string,
    private readonly _options: { projects?: ProjectStore; claudeRoot?: string; codexRoot?: string } = {},
  ) {
    this._dir = join(home, 'imports')
    const codexRoot = _options.codexRoot ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this._stores = {
      claude: _options.claudeRoot ? new ClaudeSessionStore(_options.claudeRoot) : new ClaudeSessionStore(),
      codex: new CodexSessionStore(codexRoot),
    }
  }

  /** The newest sessions of both tools, newest first. Read only: nothing in the tools' folders changes. */
  async list(): Promise<ImportableSession[]> {
    const found = await this._found()
    const projects = this._options.projects?.list() ?? []
    return Promise.all(
      found.slice(0, IMPORT_LIST_MAX).map(async ({ info, bytes }) => {
        const scanned = await scan(info.source, info.path, bytes).catch((): Scanned => ({}))
        const title = info.title ?? scanned.title
        const preview = info.firstMessage ?? scanned.preview
        const project = this._projectFor(info.cwd, projects)
        return {
          source: info.source,
          id: info.id,
          cwd: info.cwd,
          ...(title ? { title: clean(oneLine(title), IMPORT_PREVIEW_CHARS) } : {}),
          ...(preview ? { preview: clean(oneLine(preview), IMPORT_PREVIEW_CHARS) } : {}),
          updatedAt: info.modified.toISOString(),
          ...(info.messageCount ? { messages: info.messageCount } : {}),
          bytes,
          ...(project ? { project } : {}),
        }
      }),
    )
  }

  /** Converts one session into an import a new chat can start from, and keeps it. */
  async import(source: ImportSource, id: string, now = new Date()): Promise<ImportedSession> {
    const store = this._stores[source]
    if (!store) throw new Error('import from claude or codex')
    const found = (await this._found(source)).find((f) => f.info.id === id)
    if (!found) throw new Error('no such session')
    if (found.bytes > IMPORT_MAX_BYTES)
      throw new Error(
        `that session is ${Math.round(found.bytes / 1024 / 1024)} MB; the largest that can be imported is ${IMPORT_MAX_BYTES / 1024 / 1024} MB`,
      )
    const manager = await store.load(found.info)
    const { turns, omitted } = fitTurns(turnsOf(manager.getBranch()))
    if (!turns.length) throw new Error('that session has no messages to import')
    const scanned = found.info.title
      ? {}
      : await scan(source, found.info.path, found.bytes).catch(() => ({}) as Scanned)
    const firstSaid = turns.find((t) => t.role === 'user')?.text
    const title =
      manager.getSessionName() ?? found.info.title ?? scanned.title ?? found.info.firstMessage ?? firstSaid
    const cwd = manager.getCwd() || found.info.cwd
    const project = this._projectFor(cwd, this._options.projects?.list() ?? [])
    const session: ImportedSession = {
      id: `import-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      sourceId: id,
      title: clean(oneLine(title ?? TOOL_NAMES[source]), IMPORT_PREVIEW_CHARS),
      cwd,
      ...(project ? { project } : {}),
      updatedAt: found.info.modified.toISOString(),
      importedAt: now.toISOString(),
      turns,
      omitted,
    }
    mkdirSync(this._dir, { recursive: true })
    const file = join(this._dir, `${session.id}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(session))
    renameSync(tmp, file)
    return session
  }

  get(importId: string): ImportedSession | undefined {
    if (!isImportId(importId)) return undefined
    const file = join(this._dir, `${importId}.json`)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as ImportedSession
    } catch {
      return undefined
    }
  }

  /** Forgets an import, as deleting the chat that started from it does. */
  remove(importId: string): void {
    if (isImportId(importId)) rmSync(join(this._dir, `${importId}.json`), { force: true })
  }

  /** The sessions on disk, newest first, with each transcript's size. */
  private async _found(only?: ImportSource): Promise<{ info: ForeignSessionInfo; bytes: number }[]> {
    const sources = only ? [only] : IMPORT_SOURCES
    const lists = await Promise.all(
      sources.map((s) => this._stores[s].list().catch((): ForeignSessionInfo[] => [])),
    )
    const found: { info: ForeignSessionInfo; bytes: number }[] = []
    for (const info of lists.flat()) {
      try {
        found.push({ info, bytes: statSync(info.path).size })
      } catch {
        // Listed in an index but gone from disk: nothing to import.
      }
    }
    return found.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime())
  }

  /** The deepest project folder that holds `cwd`. */
  private _projectFor(
    cwd: string,
    projects: readonly { id: string; name: string; path: string }[],
  ): { id: string; name: string } | undefined {
    // Claude Code's fallback for a session without a recorded folder is a guess from its folder name.
    if (!cwd || !isAbsolute(cwd)) return undefined
    const real = realPath(cwd)
    const match = projects
      .filter((p) => within(real, p.path))
      .sort((a, b) => b.path.length - a.path.length)
      .at(0)
    return match ? { id: match.id, name: match.name } : undefined
  }
}
