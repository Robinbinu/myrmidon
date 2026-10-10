import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  LspClient,
  ServerConfig,
  SymbolInformation,
  WorkspaceEdit,
} from '@oh-my-pi/pi-coding-agent/lsp/types'
import * as natives from '@oh-my-pi/pi-natives'
import {
  AST_EDIT_MAX_FILES,
  AST_EDIT_MAX_REPLACEMENTS,
  AST_GREP_LIMIT,
  AST_TIMEOUT_MS,
  LSP_CALL_MS,
  LSP_DIAGNOSTICS_MS,
  LSP_IDLE_MS,
  LSP_LIST_LIMIT,
  MAX_READ_CHARS,
} from './config.ts'
import { prompts } from './prompts.ts'

/**
 * Code intelligence for agents: structural search and rewrite (ast-grep, through pi-natives) and language servers
 * (omp's LSP client, server discovery and edit helpers). Nothing here knows the colony: what an agent may read,
 * change, start and run comes in as a scope, so the permission model, the sandbox and read access stay in tools.ts.
 */

const say = prompts.codeIntel

/** A file's whole content before and after a change. */
export interface FileChange {
  readonly path: string
  readonly before: string
  readonly after: string
}

/** Where an agent's code tools work and what they may touch. */
export interface CodeScope {
  /** The working directory: relative paths resolve here, and results name files relative to it. */
  readonly root: string
  /** A path the agent named, for reading; throws when it is outside what the agent may read. */
  resolveRead(path: string): string
  /** Whether a file found by a search may be shown (the person's keys and other chats' data may not). */
  mayRead(path: string): boolean
  /** Whether the agent may change this file at all (inside its project, worktree or scratch). */
  mayWrite(path: string): boolean
  /**
   * Writes every change once the permission model lets them all through, asking the person first where it says to;
   * nothing is written when any is refused. Returns the files the person rewrote before approving.
   */
  write(changes: readonly FileChange[]): Promise<readonly string[]>
}

export interface LspScope extends CodeScope {
  /** The server as it may run here: in the agent's sandbox, once the permission model lets it start. Throws if not. */
  launch(server: ServerConfig): Promise<ServerConfig>
  /** Runs a project type check (a command line) where the agent's commands run. */
  check(command: string): Promise<{ ok: boolean; output: string }>
}

const shownIn = (root: string) => (path: string) => {
  const rel = relative(root, path)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel : path
}

const cut = (text: string) =>
  text.length > MAX_READ_CHARS
    ? `${text.slice(0, MAX_READ_CHARS)}\n…[truncated ${text.length - MAX_READ_CHARS} chars]`
    : text

/** Parse errors as one short list: the native message names the file and the parser's complaint. */
function parseNote(errors: readonly string[] | undefined): string[] {
  if (!errors?.length) return []
  const cleaned = errors.map((e) => /^.+: (.+: parse error.*)$/.exec(e)?.[1] ?? e)
  return [say.parseIssues(cleaned.slice(0, 5), cleaned.length)]
}

function grammarNote(missing: readonly string[] | undefined): string[] {
  return missing?.length ? [say.missingGrammars(missing)] : []
}

/** The folder a native result's paths are relative to: the folder searched, or a file's own folder. */
function baseOf(target: string): string {
  return statSync(target).isFile() ? dirname(target) : target
}

export interface AstGrepArgs {
  readonly pattern: string
  readonly path?: string
  readonly glob?: string
  readonly lang?: string
  readonly skip?: number
}

/** ast_grep: structural matches, grouped by file, with their lines and captures. */
export async function astGrep(scope: CodeScope, args: AstGrepArgs): Promise<string> {
  const target = scope.resolveRead(args.path ?? '.')
  const skip = Math.max(0, Math.floor(args.skip ?? 0))
  const shown = shownIn(scope.root)
  // Grammars omp would download on first use are reported missing instead: agents never install anything.
  const result = await natives.astGrep({
    patterns: [args.pattern],
    path: target,
    ...(args.glob ? { glob: args.glob } : {}),
    ...(args.lang ? { lang: args.lang } : {}),
    offset: skip,
    limit: AST_GREP_LIMIT,
    includeMeta: true,
    timeoutMs: AST_TIMEOUT_MS,
  })
  const base = baseOf(target)
  const all = result.matches.map((m) => ({ ...m, path: resolve(base, m.path) }))
  const matches = all.filter((m) => scope.mayRead(m.path))
  const notes = [...parseNote(result.parseErrors), ...grammarNote(result.missingGrammars)]
  if (matches.length === 0)
    return [
      say.noMatches(args.pattern),
      ...(all.length ? [say.hiddenMatches(all.length)] : []),
      ...notes,
    ].join('\n')
  // The native counts include files left out here; the agent is told about the ones it can see.
  const hiddenFiles = new Set(all.filter((m) => !matches.includes(m)).map((m) => m.path))
  for (const m of matches) hiddenFiles.delete(m.path)
  const total = result.totalMatches - (all.length - matches.length)
  const lines = [
    say.matches(total, result.filesWithMatches - hiddenFiles.size, skip + 1, skip + matches.length),
  ]
  let file = ''
  for (const m of matches) {
    if (m.path !== file) {
      file = m.path
      lines.push(`\n${shown(m.path)}`)
    }
    m.text.split('\n').forEach((line, i) => {
      lines.push(`  ${m.startLine + i}${i === 0 ? ':' : '-'} ${line}`)
    })
    const meta = Object.entries(m.metaVariables ?? {})
    if (meta.length)
      lines.push(
        `    ${meta
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `$${k}=${v}`)
          .join(', ')}`,
      )
  }
  if (matches.length < all.length) lines.push(say.hiddenMatches(all.length - matches.length))
  if (result.limitReached || skip + all.length < result.totalMatches)
    lines.push('', say.moreMatches(skip + all.length))
  if (notes.length) lines.push('', ...notes)
  return cut(lines.join('\n'))
}

export interface AstEditArgs {
  readonly pattern: string
  readonly rewrite: string
  readonly path?: string
  readonly glob?: string
  readonly lang?: string
  readonly preview?: boolean
}

/**
 * ast_edit: ast-grep works out the replacements without writing (a dry run), and the new contents are built from
 * them here, so every file goes through the same approval and write as fs_edit and the person sees the real change.
 */
export async function astEdit(scope: CodeScope, args: AstEditArgs): Promise<string> {
  const target = scope.resolveRead(args.path ?? '.')
  const shown = shownIn(scope.root)
  // One past each cap, so a result at the cap tells "exactly at it" from "over it".
  const result = await natives.astEdit({
    rewrites: { [args.pattern]: args.rewrite },
    path: target,
    ...(args.glob ? { glob: args.glob } : {}),
    ...(args.lang ? { lang: args.lang } : {}),
    dryRun: true,
    maxFiles: AST_EDIT_MAX_FILES + 1,
    maxReplacements: AST_EDIT_MAX_REPLACEMENTS + 1,
    failOnParseError: false,
    timeoutMs: AST_TIMEOUT_MS,
  })
  const notes = [...parseNote(result.parseErrors), ...grammarNote(result.missingGrammars)]
  if (result.totalReplacements === 0) return [say.noMatches(args.pattern), ...notes].join('\n')
  if (
    result.limitReached ||
    result.filesTouched > AST_EDIT_MAX_FILES ||
    result.totalReplacements > AST_EDIT_MAX_REPLACEMENTS
  )
    throw new Error(say.tooBig(result.filesTouched, result.totalReplacements))
  const base = baseOf(target)
  const byFile = new Map<string, natives.AstReplaceChange[]>()
  for (const c of result.changes) {
    const path = resolve(base, c.path)
    byFile.set(path, [...(byFile.get(path) ?? []), c])
  }
  const changes: FileChange[] = []
  for (const [path, edits] of byFile) {
    if (!scope.mayRead(path) || !scope.mayWrite(path)) throw new Error(say.cannotChange(shown(path)))
    const bytes = readFileSync(path)
    let out = bytes
    // From the end of the file back, so earlier offsets stay valid; each span must still hold what was matched.
    for (const e of [...edits].sort((a, b) => b.byteStart - a.byteStart)) {
      if (out.subarray(e.byteStart, e.byteEnd).toString('utf8') !== e.before)
        throw new Error(say.changedSince(shown(path)))
      out = Buffer.concat([
        out.subarray(0, e.byteStart),
        Buffer.from(e.after, 'utf8'),
        out.subarray(e.byteEnd),
      ])
    }
    changes.push({ path, before: bytes.toString('utf8'), after: out.toString('utf8') })
  }
  const listing = [...byFile].flatMap(([path, edits]) =>
    args.preview
      ? [
          shown(path),
          ...edits.map(
            (e) =>
              `  ${e.startLine}: ${e.before.split('\n')[0]}\n  ${' '.repeat(String(e.startLine).length)}→ ${e.after.split('\n')[0]}`,
          ),
        ]
      : [`  ${shown(path)} (${edits.length})`],
  )
  if (args.preview)
    return cut([say.previewed(result.totalReplacements, byFile.size), ...listing, ...notes].join('\n'))
  const edited = await scope.write(changes)
  return cut(
    [
      say.rewrote(result.totalReplacements, byFile.size),
      ...listing,
      ...notes,
      ...(edited.length ? [prompts.toolResults.editedByPerson.trim()] : []),
    ].join('\n'),
  )
}

// Language servers -------------------------------------------------------------------------------------------------

export const LSP_ACTIONS = [
  'diagnostics',
  'definition',
  'references',
  'hover',
  'symbols',
  'rename',
  'status',
] as const
export type LspAction = (typeof LSP_ACTIONS)[number]

export interface LspArgs {
  readonly action: LspAction
  readonly path?: string
  readonly line?: number
  readonly symbol?: string
  readonly query?: string
  readonly newName?: string
}

/** Whether this call changes files: only a rename does. */
export const lspWrites = (args: Partial<LspArgs>) => args.action === 'rename'

/**
 * omp's LSP modules, loaded on the first lsp call: they pull in its config discovery, which must not load before
 * omp has been pointed at Myrmidon's folder, and most rounds never need them.
 */
function ompLsp(): Promise<Omp> {
  ompModules ??= (async () => {
    const [config, client, diagnostics, edits, utils] = await Promise.all([
      import('@oh-my-pi/pi-coding-agent/lsp/config'),
      import('@oh-my-pi/pi-coding-agent/lsp/client'),
      import('@oh-my-pi/pi-coding-agent/lsp/diagnostics'),
      import('@oh-my-pi/pi-coding-agent/lsp/edits'),
      import('@oh-my-pi/pi-coding-agent/lsp/utils'),
    ])
    // Servers are started per agent (each in its own sandbox); idle ones are stopped rather than kept for the session.
    client.setIdleTimeout(LSP_IDLE_MS)
    return { config, client, diagnostics, edits, utils }
  })()
  return ompModules
}
interface Omp {
  readonly config: typeof import('@oh-my-pi/pi-coding-agent/lsp/config')
  readonly client: typeof import('@oh-my-pi/pi-coding-agent/lsp/client')
  readonly diagnostics: typeof import('@oh-my-pi/pi-coding-agent/lsp/diagnostics')
  readonly edits: typeof import('@oh-my-pi/pi-coding-agent/lsp/edits')
  readonly utils: typeof import('@oh-my-pi/pi-coding-agent/lsp/utils')
}
let ompModules: Promise<Omp> | undefined

/** Language servers omp finds for a folder: its defaults whose root markers are there and whose binary is installed. */
export async function lspServers(root: string): Promise<[string, ServerConfig][]> {
  const omp = await ompLsp()
  // Linters omp drives through their own command line (Biome, SwiftLint) are not language servers; they run unconfined.
  return Object.entries(omp.config.getConfig(root).servers).filter(([, s]) => !s.createClient)
}

/** A server that understands types (not a linter), for definitions, references, hover, symbols and renames. */
const typed = ([, s]: [string, ServerConfig]) => !s.isLinter

export async function lsp(scope: LspScope, args: LspArgs): Promise<string> {
  const omp = await ompLsp()
  const signal = AbortSignal.timeout(LSP_CALL_MS)
  const all = await lspServers(scope.root)
  if (args.action === 'status') return all.length ? say.servers(all.map(([name]) => name)) : say.noServers
  if (args.action === 'diagnostics' && !args.path) return projectDiagnostics(scope, omp)
  if (args.action === 'symbols' && !args.path) {
    if (!args.query?.trim()) throw new Error(say.needsQuery)
    const servers = all.filter(typed)
    if (servers.length === 0) return say.noServers
    return withServer(servers.map(([n]) => n).join(', '), signal, () =>
      workspaceSymbols(scope, omp, servers, args.query?.trim() ?? '', signal),
    )
  }
  if (!args.path) throw new Error(say.needsPath(args.action))
  const file = scope.resolveRead(args.path)
  const shown = shownIn(scope.root)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(say.notFile(args.path))
  const forFile = omp.config.getServersForFile({ servers: Object.fromEntries(all) }, file)
  if (args.action === 'diagnostics') {
    if (forFile.length === 0) return say.noServer(shown(file))
    return fileDiagnostics(scope, omp, forFile, file, signal)
  }
  const server = forFile.find(typed)
  if (!server) return say.noServer(shown(file))
  return withServer(server[0], signal, async () => {
    const client = await start(scope, omp, server[1], signal)
    await omp.client.reconcileFileFromDisk(client, file, signal)
    await omp.client.waitForProjectLoaded(client, signal)
    const uri = omp.utils.fileToUri(file)
    if (args.action === 'symbols') return documentSymbols(omp, client, uri, shown(file), signal)
    if (args.line === undefined || !args.symbol) throw new Error(say.needsLine(args.action))
    const character = await omp.utils.resolveSymbolColumn(file, args.line, args.symbol)
    const position = { line: Math.max(1, Math.floor(args.line)) - 1, character }
    const at = { textDocument: { uri }, position }
    switch (args.action) {
      case 'definition': {
        const result = (await omp.client.sendRequest(client, 'textDocument/definition', at, signal)) as
          | Location
          | Location[]
          | LocationLink
          | LocationLink[]
          | null
        return locations(scope, omp, omp.diagnostics.normalizeLocationResult(result), 'definitions')
      }
      case 'references': {
        const result = (await omp.client.sendRequest(
          client,
          'textDocument/references',
          { ...at, context: { includeDeclaration: true } },
          signal,
        )) as Location[] | null
        return locations(scope, omp, result ?? [], 'references')
      }
      case 'hover': {
        const result = (await omp.client.sendRequest(
          client,
          'textDocument/hover',
          at,
          signal,
        )) as Hover | null
        return result?.contents
          ? cut(omp.utils.extractHoverText(result.contents))
          : say.none('hover information')
      }
      case 'rename': {
        if (!args.newName?.trim()) throw new Error(say.needsNewName)
        const edit = (await omp.client.sendRequest(
          client,
          'textDocument/rename',
          { ...at, newName: args.newName.trim() },
          signal,
        )) as WorkspaceEdit | null
        return rename(scope, omp, client, edit, signal)
      }
    }
    throw new Error(`unknown action ${args.action}`)
  })
}

/** Starts (or reuses) a server's client, as the scope lets it run. */
async function start(
  scope: LspScope,
  omp: Omp,
  server: ServerConfig,
  signal: AbortSignal,
): Promise<LspClient> {
  return omp.client.getOrCreateClient(await scope.launch(server), scope.root, undefined, signal)
}

/** A slow server (still indexing) reads as that, not as an opaque abort. */
async function withServer(name: string, signal: AbortSignal, work: () => Promise<string>): Promise<string> {
  try {
    return await work()
  } catch (err) {
    if (signal.aborted) throw new Error(say.timedOut(name, LSP_CALL_MS / 1000))
    throw err
  }
}

async function fileDiagnostics(
  scope: LspScope,
  omp: Omp,
  servers: [string, ServerConfig][],
  file: string,
  signal: AbortSignal,
): Promise<string> {
  const shown = shownIn(scope.root)(file)
  const uri = omp.utils.fileToUri(file)
  const found: Diagnostic[] = []
  const failed: string[] = []
  for (const [name, server] of servers) {
    try {
      await withServer(name, signal, async () => {
        const client = await start(scope, omp, server, signal)
        if (!server.isLinter) await omp.client.waitForProjectLoaded(client, signal)
        const minVersion = client.diagnosticsVersion
        await omp.client.refreshFile(client, file, signal)
        found.push(
          ...(await omp.diagnostics.waitForDiagnostics(client, uri, {
            timeoutMs: LSP_DIAGNOSTICS_MS,
            signal,
            minVersion,
            expectedDocumentVersion: client.openFiles.get(uri)?.version,
          })),
        )
        return ''
      })
    } catch (err) {
      failed.push(say.serverFailed(name, err instanceof Error ? err.message : String(err)))
    }
  }
  if (failed.length === servers.length) throw new Error(failed.join('\n'))
  const seen = new Set<string>()
  const unique = found.filter((d) => {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.message}`
    return !seen.has(key) && !!seen.add(key)
  })
  omp.utils.sortDiagnostics(unique)
  const body = unique.length
    ? [
        `${shown}: ${omp.utils.formatDiagnosticsSummary(unique)}`,
        ...unique.map((d) => omp.utils.formatDiagnostic(d, shown)),
      ]
    : [say.clean(shown)]
  return cut([...body, ...failed].join('\n'))
}

/**
 * The project's own type check, run as the agent's commands run (sandbox, permissions): language servers only report
 * the files they have open, so a whole-project answer comes from the compiler.
 */
async function projectDiagnostics(scope: LspScope, omp: Omp): Promise<string> {
  const commands = projectChecks(scope.root, (cmd) => omp.config.resolveCommand(cmd, scope.root))
  if (commands.length === 0) return say.noChecker
  const out: string[] = []
  for (const command of commands) {
    const r = await scope.check(command)
    out.push(say.checked(command, r.ok), r.output.trim())
  }
  return cut(out.filter(Boolean).join('\n'))
}

/**
 * The type checks a project's markers call for, with a binary that is installed (never `npx`, which may download):
 * after omp's workspace diagnostics. A local binary is named relative to the project, so the command line works in
 * every shell the sandbox may use.
 */
export function projectChecks(root: string, which: (command: string) => string | null): string[] {
  const has = (marker: string) => existsSync(join(root, marker))
  const program = (command: string) => {
    const found = which(command)
    if (!found) return undefined
    const rel = relative(root, found)
    return rel.startsWith('..') || isAbsolute(rel) ? command : `./${rel.split(sep).join('/')}`
  }
  const checks: (string | undefined)[] = []
  if (has('tsconfig.json')) {
    const tsc = program('tsc')
    checks.push(tsc && `${tsc} --noEmit --pretty false`)
  }
  if (has('Cargo.toml')) checks.push(program('cargo') && 'cargo check --message-format=short')
  if (has('go.mod') || has('go.work')) checks.push(program('go') && 'go build ./...')
  if (has('pyproject.toml') || has('pyrightconfig.json')) checks.push(program('pyright'))
  return checks.filter((c): c is string => !!c)
}

async function locations(
  scope: LspScope,
  omp: Omp,
  found: readonly Location[],
  what: string,
): Promise<string> {
  const shown = shownIn(scope.root)
  const visible = found.filter((l) => scope.mayRead(omp.utils.uriToFile(l.uri)))
  if (visible.length === 0)
    return [say.none(what), ...(found.length ? [say.hiddenMatches(found.length)] : [])].join('\n')
  const listed = visible.slice(0, LSP_LIST_LIMIT)
  const lines = await Promise.all(
    listed.map(async (l) => {
      const file = omp.utils.uriToFile(l.uri)
      const line = l.range.start.line + 1
      const text = (await omp.utils.readLocationContext(file, line, 0))[0]?.replace(/^\d+: /, '').trim()
      return `  ${shown(file)}:${line}:${l.range.start.character + 1}${text ? `  ${text}` : ''}`
    }),
  )
  return cut(
    [
      say.found(visible.length, what),
      ...lines,
      ...(visible.length > listed.length ? [say.moreListed(visible.length - listed.length)] : []),
      ...(visible.length < found.length ? [say.hiddenMatches(found.length - visible.length)] : []),
    ].join('\n'),
  )
}

async function documentSymbols(
  omp: Omp,
  client: LspClient,
  uri: string,
  shown: string,
  signal: AbortSignal,
): Promise<string> {
  const result = (await omp.client.sendRequest(
    client,
    'textDocument/documentSymbol',
    { textDocument: { uri } },
    signal,
  )) as (DocumentSymbol | SymbolInformation)[] | null
  if (!result?.length) return say.none('symbols')
  const lines: string[] = []
  const walk = (s: DocumentSymbol, depth: number) => {
    lines.push(
      `${'  '.repeat(depth + 1)}${omp.utils.symbolKindToName(s.kind)} ${s.name}${s.detail ? ` ${s.detail}` : ''} (line ${s.range.start.line + 1})`,
    )
    for (const child of s.children ?? []) walk(child, depth + 1)
  }
  for (const s of result) {
    if ('range' in s && 'selectionRange' in s) walk(s, 0)
    else if ('location' in s)
      lines.push(
        `  ${omp.utils.symbolKindToName(s.kind)} ${s.name} (line ${s.location.range.start.line + 1})`,
      )
  }
  return cut([`${shown}:`, ...lines].join('\n'))
}

async function workspaceSymbols(
  scope: LspScope,
  omp: Omp,
  servers: [string, ServerConfig][],
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const shown = shownIn(scope.root)
  const found: SymbolInformation[] = []
  for (const [, server] of servers) {
    const client = await start(scope, omp, server, signal)
    await omp.client.waitForProjectLoaded(client, signal)
    const result = (await omp.client.sendRequest(client, 'workspace/symbol', { query }, signal)) as
      | SymbolInformation[]
      | null
    found.push(...omp.utils.filterWorkspaceSymbols(result ?? [], query))
  }
  const visible = omp.utils
    .dedupeWorkspaceSymbols(found)
    // A workspace symbol may come without a range (LSP 3.17's WorkspaceSymbol); it still names its file.
    .filter((s) => scope.mayRead(omp.utils.uriToFile(s.location.uri)))
  if (visible.length === 0) return say.none(`symbols matching "${query}"`)
  const lines = visible.slice(0, LSP_LIST_LIMIT).map((s) => {
    const where = shown(omp.utils.uriToFile(s.location.uri))
    const line = s.location.range ? `:${s.location.range.start.line + 1}` : ''
    return `  ${omp.utils.symbolKindToName(s.kind)} ${s.name}${s.containerName ? ` (${s.containerName})` : ''}  ${where}${line}`
  })
  return cut(
    [
      say.found(visible.length, `symbols matching "${query}"`),
      ...lines,
      ...(visible.length > LSP_LIST_LIMIT ? [say.moreListed(visible.length - LSP_LIST_LIMIT)] : []),
    ].join('\n'),
  )
}

/**
 * A rename the server worked out, applied the way fs_edit applies a change: every file is checked against where the
 * agent may write and approved as the permission model says, then written; the server is told the new contents.
 */
async function rename(
  scope: LspScope,
  omp: Omp,
  client: LspClient,
  edit: WorkspaceEdit | null,
  signal: AbortSignal,
): Promise<string> {
  if (!edit) return say.renameNone
  if (edit.documentChanges?.some((c) => 'kind' in c)) throw new Error(say.renameMoves)
  const shown = shownIn(scope.root)
  const byUri = omp.edits.flattenWorkspaceTextEdits(edit)
  if (byUri.size === 0) return say.renameNone
  const changes: FileChange[] = []
  const counts: string[] = []
  for (const [uri, edits] of byUri) {
    const path = omp.utils.uriToFile(uri)
    if (!scope.mayRead(path) || !scope.mayWrite(path)) throw new Error(say.cannotChange(shown(path)))
    const before = readFileSync(path, 'utf8')
    changes.push({ path, before, after: omp.edits.applyTextEditsToString(before, edits) })
    counts.push(`  ${shown(path)} (${edits.length})`)
  }
  const edited = await scope.write(changes)
  for (const c of changes) await omp.client.reconcileFileFromDisk(client, c.path, signal).catch(() => {})
  const total = [...byUri.values()].reduce((n, e) => n + e.length, 0)
  return [
    say.renamed(total, changes.length),
    ...counts,
    ...(edited.length ? [prompts.toolResults.editedByPerson.trim()] : []),
  ].join('\n')
}
