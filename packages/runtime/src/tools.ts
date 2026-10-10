import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  type ColonyState,
  type ConversationLine,
  conversationsOf,
  crewOf,
  type EventDraft,
  type EventPayloads,
  GROUP_NAME,
  groupMembers,
  linesOf,
  type MyrEvent,
  mentionsIn,
  type PermissionCall,
  type PermissionVerdict,
  type Review,
  type ReviewField,
  resolveConversation,
  reviewVerdicts,
  SYSTEM,
  type TaskSnapshot,
  TEAM_CHAT,
  type UsageInfo,
} from '@myrmidon/protocol'
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { type Model, type } from '@oh-my-pi/pi-ai'
import type { ServerConfig } from '@oh-my-pi/pi-coding-agent/lsp/types'
import * as natives from '@oh-my-pi/pi-natives'
import type { ElementHandle } from 'puppeteer-core'
import chatDoc from '../docs/chat.md' with { type: 'text' }
import coordinationDoc from '../docs/coordination.md' with { type: 'text' }
import limitsDoc from '../docs/limits.md' with { type: 'text' }
import modesDoc from '../docs/modes.md' with { type: 'text' }
import overviewDoc from '../docs/overview.md' with { type: 'text' }
import pluginsDoc from '../docs/plugins.md' with { type: 'text' }
import verificationDoc from '../docs/verification.md' with { type: 'text' }
import workingDoc from '../docs/working.md' with { type: 'text' }
import {
  artifactOrigin,
  assertAgentControl,
  type BrowserTab,
  doneWith,
  navigate,
  openPage,
  pageElement,
  pageSnapshot,
  pointAt,
  refLabel,
  switchPage,
  watched,
} from './browser.ts'
import { CELL_LANGUAGES, type CellAccess, type CellScope, cellKernels } from './cells.ts'
import { clockTime, localDate } from './clock.ts'
import {
  astEdit,
  astGrep,
  type FileChange,
  LSP_ACTIONS,
  type LspScope,
  lsp,
  lspWrites,
} from './code-intel.ts'
import { desktopTool } from './computer/desktop.ts'
import { DESKTOP_TOOL } from './computer/names.ts'
import {
  appTool,
  COMPUTER_TOOL,
  computerTool,
  computerToolSpec,
  LIST_APPS_TOOL,
  OPEN_APP_TOOL,
} from './computer/tool.ts'
import {
  FETCH_SHOWN_CHARS,
  FIND_TOOLS_LIMIT,
  GITHUB,
  GLOB_LIMIT,
  GREP_LIMIT,
  IMAGE_TIMEOUT_MS,
  LSP_PROJECT_CHECK_MS,
  MAX_ARTIFACT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_IMAGES_PER_CALL,
  MAX_MEDIA_BYTES,
  MAX_READ_CHARS,
  MCP_FAILURE_LIMIT,
  PAGE_EXCERPT,
  READ_LOG_RESULT_CHARS,
  REVIEW_MAX_CHARS,
  RULE_MAX_TEXT,
  TTS_MAX_CHARS,
} from './config.ts'
import { readFileAs } from './file-read.ts'
import { find } from './find.ts'
import { gitCommitChanges, gitWorkingChanges } from './git.ts'
import {
  type GhScope,
  GITHUB_OPS,
  ghBinary,
  ghEnv,
  ghToken,
  githubWriteCommand,
  githubWrites,
  posixLine,
  runGithub,
  runGithubWrite,
  scrubToken,
  shellLine,
} from './github.ts'
import { agentActor, type ColonyHost, type ReviewDecision } from './host.ts'
import {
  browserSteps,
  checkedArgs,
  checkedTool,
  fillPlaceholders,
  inputSchema,
  MADE_PREFIX,
  type MadeTool,
  scriptCommand,
} from './made-tools.ts'
import { RUNTIMES, toolsFor } from './patterns.ts'
import { presetOf } from './permissions.ts'
import { adoptDraft, isOwnDraft, testPlugin, writeDraft } from './plugin-builder.ts'
import { type ProjectCheck, scratchChecks } from './project-context.ts'
import type { PromptFacts } from './prompt/facts.ts'
import { type Place, prompts } from './prompts.ts'
import { within } from './read-access.ts'
import { ruleMatches } from './rule-files.ts'
import { SANDBOX_DIRS, type SandboxRun } from './sandbox.ts'
import { hostShell } from './shell.ts'
import { parseWav } from './voice/audio.ts'
import { assertArtifactName, SKIP_DIRS } from './workspace.ts'

/** A short, stable file name for a fetched URL. */
function pageFileName(url: string): string {
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${slug || 'page'}-${Bun.hash(url).toString(36).slice(0, 6)}`
}

type Tier = 'read' | 'write' | 'exec'

/** A tool result with pictures attached, for models that can see them (others get a placeholder). */
interface ToolOutput {
  readonly text: string
  readonly images: readonly { readonly data: string; readonly mimeType: string }[]
  /** The harness's own note (where a page was saved, a stale-year warning); stays outside the untrusted block. */
  readonly preface?: string
  /** What the call spent on a model of its own (generate_image), for the round's budget. */
  readonly usage?: UsageInfo
}

interface ToolDef {
  readonly name: string
  readonly tier: Tier
  readonly description: string
  /** For a tool whose description depends on the round's configuration: what this agent is told instead. */
  readonly describe?: (facts: PromptFacts) => string
  readonly parameters: ReturnType<typeof type>
  /** For a tool only some of whose calls change things (lsp's rename): this call's tier, which `tier` is the least of. */
  // biome-ignore lint/suspicious/noExplicitAny: arguments are validated against `parameters` by the agent loop
  readonly tierOf?: (args: any) => Tier
  // biome-ignore lint/suspicious/noExplicitAny: arguments are validated against `parameters` by the agent loop
  run(args: any, agent: string, host: ColonyHost): Promise<string | ToolOutput>
}

/** Leading bytes of each raster format, so a text file published under an image name is never sent as one. */
const IMAGE_MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  'image/webp': (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
}

/** The raster image type these bytes really are (PNG, JPEG, GIF, WebP), whatever the file is called. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  return Object.entries(IMAGE_MAGIC).find(([, is]) => is(bytes))?.[0]
}

/** Leading bytes of each sound format the chat plays, so only real audio is served as audio. */
const AUDIO_MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'audio/wav': (b) => text4(b, 0) === 'RIFF' && text4(b, 8) === 'WAVE',
  'audio/mpeg': (b) => text4(b, 0).startsWith('ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  'audio/ogg': (b) => text4(b, 0) === 'OggS',
  'audio/flac': (b) => text4(b, 0) === 'fLaC',
}
const text4 = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4))

/** The sound type these bytes really are (WAV, MP3, Ogg, FLAC), whatever the file is called. */
export function sniffAudio(bytes: Uint8Array): string | undefined {
  return Object.entries(AUDIO_MAGIC).find(([, is]) => is(bytes))?.[0]
}

/** Media types whose bytes are readable text. */
export function isTextual(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'image/svg+xml' ||
    mediaType.endsWith('+xml') ||
    mediaType === 'application/xml'
  )
}

function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error('expected an appended event')
  return item
}

const clip = (text: string, max = MAX_READ_CHARS) =>
  text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text

/**
 * The lines of a file fs_read returns: `offset` (1-based) and `limit` pick a range, and the result stops at the last
 * whole line within `max` characters. A whole file that fits comes back as it is; otherwise a header names the lines
 * shown and, when lines remain, the offset that reads on (after Qwen Code's and Gemini CLI's read_file paging).
 */
export function readRange(text: string, offset = 1, limit?: number, max = MAX_READ_CHARS): string {
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset is a line number, 1 or more')
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error('limit is a number of lines, 1 or more')
  if (offset === 1 && limit === undefined && text.length <= max) return text
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  const total = lines.length
  if (offset > total) throw new Error(prompts.toolResults.readPastEnd(offset, total))
  const wanted = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
  const shown: string[] = []
  let size = 0
  for (const line of wanted) {
    // A single line longer than the cap is cut rather than skipped, so a minified file still reads.
    if (size + line.length + 1 > max) {
      if (shown.length === 0) shown.push(`${line.slice(0, max)}…`)
      break
    }
    shown.push(line)
    size += line.length + 1
  }
  const last = offset + shown.length - 1
  return `${prompts.toolResults.readLines(offset, last, total)}\n${shown.join('\n')}${last < total ? `\n${prompts.toolResults.readOn(last + 1, total)}` : ''}`
}

function taskLine(t: TaskSnapshot) {
  const owner = `${t.owner ? ` owner=${t.owner}` : ''}${t.assignee && t.assignee !== t.owner ? ` assignee=${t.assignee}` : ''}${t.outputs?.length ? ` outputs=${t.outputs.join(',')}` : ''}`
  const blocked = t.blockedBy.length ? ` blockedBy=${t.blockedBy.join(',')}` : ''
  const arts = t.artifacts.length ? ` artifacts=${t.artifacts.join(',')}` : ''
  return `${t.id} r${t.revision} [${t.status}]${owner}${blocked}${arts} — ${t.subject}`
}

function requireTask(state: ColonyState, id: string): TaskSnapshot {
  const task = state.tasks[id]
  if (!task || task.status === 'deleted') throw new Error(`no such task: ${id}`)
  return task
}

function taskEvent(agent: string, task: TaskSnapshot): EventDraft {
  return { type: 'task/changed', actor: agentActor(agent), payload: { task, by: agent } }
}

function blockersDone(state: ColonyState, task: TaskSnapshot) {
  return task.blockedBy.every((b) => state.tasks[b]?.status === 'verified')
}

/**
 * Tool calls from one assistant message run concurrently, but an agent writing several changes in one step expects
 * them to happen in the order it wrote them: a task named in a later blockedBy, a file published before the
 * submit that lists it. Each agent's write calls therefore run one after another; reads stay parallel. A read after
 * a write in the same step must see it too, so writes are scheduled `exclusive` (see `concurrencyOf`).
 */
const creating = new WeakMap<ColonyHost, Map<string, Promise<unknown>>>()
function inCallOrder<T>(host: ColonyHost, agent: string, run: () => Promise<T>): Promise<T> {
  const chains = creating.get(host) ?? new Map<string, Promise<unknown>>()
  creating.set(host, chains)
  const next = (chains.get(agent) ?? Promise.resolve()).catch(() => {}).then(run)
  chains.set(agent, next)
  return next
}

// Words every task subject shares; they say nothing about which task it is.
const FILLER = new Set(
  'the and for with from into about this that each all its are using use write build create make research draft add implement framework frameworks task tasks report file files code page'.split(
    ' ',
  ),
)

const FINAL_HINT =
  'task-final is finished by sending the complete answer with reply_user(final: true); it is never claimed, submitted, or released'

async function browserTab(host: ColonyHost, agent: string): Promise<BrowserTab> {
  if (!host.browser) throw new Error('no browser here: Chrome is not installed on this machine')
  const tab = await host.browser.tab(host.id, agent, {
    downloads: join(host.workspace.scratch(agent), 'downloads'),
    localPorts: () => host.localPorts(),
    artifacts: {
      origin: artifactOrigin(host.id),
      file: async (name) => {
        const latest = host.state().artifacts[name]?.at(-1)
        return latest && { body: await host.blobs.get(latest.blob), mediaType: latest.mediaType }
      },
    },
  })
  assertAgentControl(tab)
  return tab
}

/** Records what the agent's browser shows after an action, so the person can replay it later. */
async function keyframe(
  host: ColonyHost,
  agent: string,
  tab: BrowserTab,
  action: EventPayloads['browser/keyframe']['action'],
  label?: string,
  box?: { x: number; y: number; width: number; height: number } | null,
) {
  try {
    const shot = await tab.page.screenshot({ type: 'jpeg', quality: 55 })
    const { hash } = await host.blobs.put(new Uint8Array(shot))
    const view = tab.page.viewport()
    await host.append({
      type: 'browser/keyframe',
      actor: agentActor(agent),
      payload: {
        agent,
        blob: hash,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        action,
        ...(label ? { label } : {}),
        cursor: tab.cursor,
        ...(box ? { box: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
        width: view?.width ?? 1280,
        height: view?.height ?? 800,
      },
    })
  } catch (err) {
    // Replay is a convenience; a failed capture must not fail the agent's action.
    console.error(`[${agent}] keyframe failed:`, err instanceof Error ? err.message : err)
  }
}

/** Where a published artifact opens in the agents' browsers: the colony's own origin, so relative links resolve. */
function artifactUrl(host: ColonyHost, name: string): string {
  if (!host.state().artifacts[name]) throw new Error(`no such artifact: ${name}`)
  return `${artifactOrigin(host.id)}/${name.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Publishes bytes as the next version of artifact `name`, unless it is the output of a task someone else is working on.
 * Returns the version and stored size.
 */
async function publishFile(
  host: ColonyHost,
  agent: string,
  name: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ version: number; size: number }> {
  const { hash, size } = await host.blobs.put(bytes)
  const e = first(
    await host.appendAtomic((s) => {
      const owner = Object.values(s.tasks).find(
        (t) => t.status === 'in_progress' && t.owner !== agent && t.outputs?.includes(name),
      )
      if (owner)
        throw new Error(
          `${name} is an output of ${owner.id}, which ${owner.owner} is working on; do not publish it`,
        )
      const prev = s.artifacts[name]?.at(-1)
      return [
        {
          type: 'artifact/versioned',
          actor: agentActor(agent),
          payload: {
            name,
            version: (prev?.version ?? 0) + 1,
            blob: hash,
            size,
            ...(prev ? { parentVersion: prev.version } : {}),
            author: agent,
            mediaType,
          },
        },
      ]
    }),
  )
  return { version: (e.payload as EventPayloads['artifact/versioned']).version, size }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * The artifact name of a media file: the agent's `name`, else a few words of the request under `folder`, with the
 * extension the bytes really have, and `-n` when it is one of several.
 */
export function mediaName(
  given: string | undefined,
  words: string,
  folder: string,
  extension: string,
  index?: number,
): string {
  const slug =
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 6)
      .join('-')
      .slice(0, 48)
      .replace(/-+$/, '') || 'untitled'
  const base = given ? assertArtifactName(given).replace(/\.[A-Za-z0-9]+$/, '') : `${folder}/${slug}`
  return `${base}${index === undefined ? '' : `-${index}`}.${extension}`
}

/** A picture to edit from: a published artifact by name, else a file the agent may read. */
async function inputImage(
  host: ColonyHost,
  agent: string,
  ref: string,
): Promise<{ data: string; mimeType: string }> {
  const latest = host.state().artifacts[ref]?.at(-1)
  const bytes = latest
    ? await host.blobs.get(latest.blob)
    : new Uint8Array(readFileSync(host.workspace.resolveForRead(agent, ref)))
  if (bytes.byteLength > MAX_MEDIA_BYTES)
    throw new Error(prompts.toolResults.mediaTooLarge(ref, bytes.byteLength))
  const mimeType = sniffImage(bytes)
  if (!mimeType) throw new Error(prompts.toolResults.notAPicture(ref))
  return { data: Buffer.from(bytes).toString('base64'), mimeType }
}

/**
 * Publishes a picture or sound for the person and keeps a copy in the agent's scratch directory, so it can use the file
 * (copy it into a project, put it on a page). Returns the artifact's name and version and where the copy is.
 */
async function publishMedia(
  host: ColonyHost,
  agent: string,
  name: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ name: string; version: number; copy: string }> {
  if (bytes.byteLength > MAX_MEDIA_BYTES)
    throw new Error(prompts.toolResults.mediaTooLarge(name, bytes.byteLength))
  const { version } = await publishFile(host, agent, name, bytes, mediaType)
  const path = host.workspace.resolveInScratch(agent, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  // In a project the shell starts in the project, so the copy is named by its full path.
  return { name, version, copy: host.workspace.project ? path : name }
}

/** All a swarm peer may do during the opening huddle: look around and talk. */
const HUDDLE_TOOLS = new Set([
  'read_task',
  'read_notes',
  'list_agents',
  'list_tasks',
  'list_artifacts',
  'read_artifact',
  'observe',
  'read_docs',
  'message',
  'read_messages',
])

// A peer-made "final answer" task would block task-final, which only appears once every other task is verified.
const FINAL_TASK =
  /\b(final (answer|review|reply|response|summary)|answer the (person|user)|reply to the (person|user)|respond to the (person|user))\b/i

// Numbers and ordinals tell otherwise identical subjects apart ("example app #1" vs "#2").
const MARKER = /\d+|\b(first|second|third|fourth|fifth|sixth|one|two|three|four|five|six)\b/g

/** Content-word overlap (Jaccard) of two task subjects, 0 to 1; catches peers proposing the same task twice. */
export function similar(a: string, b: string): number {
  const markers = (s: string) => [...new Set(s.toLowerCase().match(MARKER) ?? [])].sort().join(',')
  if (markers(a) !== markers(b)) return 0
  const words = (s: string) =>
    new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !FILLER.has(w)))
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared += 1
  return shared / (x.size + y.size - shared)
}

/** The swarm peer that currently speaks for the colony: whoever holds task-final. */
function speaker(state: ColonyState): string | undefined {
  return state.tasks['task-final']?.owner
}

function toolsAllowed(host: ColonyHost, agent: string): string[] {
  const spec = host.spec.agents.find((a) => a.name === agent)
  return spec ? toolsFor(host.spec, spec) : []
}

const DOCS: Record<string, string> = {
  overview: overviewDoc,
  modes: modesDoc,
  coordination: coordinationDoc,
  verification: verificationDoc,
  chat: chatDoc,
  limits: limitsDoc,
  working: workingDoc,
  plugins: pluginsDoc,
}

/**
 * Folders a command may write: the working directory and scratch, except in a read-only project, where the sandbox
 * keeps the project itself untouchable and only scratch is writable.
 */
function writableFor(host: ColonyHost, agent: string): string[] {
  const scratch = host.workspace.scratch(agent)
  if (presetOf(host.spec) === 'read-only') return [scratch]
  return [...new Set([host.workspace.workdir(agent), scratch])]
}

/** Search results without what stays hidden inside the searched folder (the person's keys, other chats' data). */
function readableMatches<T extends { path: string }>(
  host: ColonyHost,
  agent: string,
  target: string,
  matches: readonly T[],
): T[] {
  const seen = new Map<string, boolean>()
  return matches.filter((m) => {
    let ok = seen.get(m.path)
    if (ok === undefined) {
      ok = host.workspace.mayRead(agent, resolve(target, m.path))
      seen.set(m.path, ok)
    }
    return ok
  })
}

/**
 * Write tools whose effects stay inside the colony: its notes, tasks, messages, helpers and answers. A round that asks
 * for everything (`askAll`) still lets them run, since it could not work at all otherwise.
 */
const COLONY_ONLY = new Set([
  'append_note',
  'message',
  'create_group',
  'update_group',
  'create_task',
  'claim_task',
  'assign_task',
  'release_task',
  'reject_task',
  'submit_task',
  'publish_artifact',
  'request_review',
  'request_final_verification',
  'escalate',
  'reply_user',
  'reply_person',
  'check_in',
  'ask_user',
  'propose',
  'add_crewmate',
  'dismiss_crewmate',
  'ask_crewmate',
  'update_todo',
])

/** Write calls that may run side by side: each waits on someone else's work, so asks in one step go out together. */
const IN_PARALLEL = new Set(['ask_crewmate'])

/**
 * How the agent loop schedules a call among the others of its step: reads run side by side, and anything that
 * changes state runs alone, after the calls before it and before those after it, so a read written after
 * update_group or publish_artifact sees the change (pi-agent-core's `concurrency`).
 */
function concurrencyOf(def: Pick<ToolDef, 'name' | 'tier'>): 'shared' | 'exclusive' {
  return def.tier === 'read' || IN_PARALLEL.has(def.name) ? 'shared' : 'exclusive'
}

/** A call's tier: the tool's own, or what this call does when that depends on its arguments. */
function tierOf(def: Pick<ToolDef, 'tier' | 'tierOf'>, params: unknown): Tier {
  return def.tierOf?.(params ?? {}) ?? def.tier
}

/** File tools that read from the working directory, which is the person's project in a chat that has one. */
const PROJECT_READS = new Set(['fs_read', 'fs_list', 'grep', 'glob', 'find', 'ast_grep', 'lsp'])

/**
 * Whether a call reads the person's project rather than the agent's own scratch. A round someone else started
 * (`askAll`) asks before these, so a member cannot have secrets such as `.env` read and sent back to them.
 */
function readsProject(host: ColonyHost, agent: string, tool: string, params: unknown): boolean {
  if (!host.spec.chat?.project || !PROJECT_READS.has(tool)) return false
  const path = (params as { path?: unknown } | undefined)?.path
  let target: string
  try {
    target = host.workspace.resolveInWorkdir(agent, typeof path === 'string' ? path : '.')
  } catch {
    // The tool refuses that path itself.
    return false
  }
  const scratch = host.workspace.scratch(agent)
  return target !== scratch && !target.startsWith(scratch + sep)
}

/**
 * Tools that decide their own calls once they know what they would do (the file, the command, the proposal): those of
 * their calls that are not reads.
 */
const GUARDED = new Set([
  'fs_write',
  'fs_edit',
  'ast_edit',
  'lsp',
  'shell',
  'eval',
  'start_server',
  'run_checks',
  'propose',
  'github',
])
/**
 * Guarded tools whose reads are commands too, decided as the commands they run (the github tool's `gh pr view`): the
 * harness leaves all their calls to them, so a rule naming the tool is not asked about twice.
 */
const GUARDS_READS = new Set(['github'])

/** Tools that reach the web, in the agent's own fetcher or browser. */
const WEB_TOOL = (name: string) =>
  name === 'web_search' || name === 'web_fetch' || name.startsWith('browser_')

/**
 * A built-in tool's call as the permission engine sees it. `readOnly` (it changes nothing outside the colony) is what a
 * round that asks for everything still lets run: reads that stay out of the person's project, and the colony's own
 * notes, tasks and messages.
 */
function callOf(
  host: ColonyHost,
  agent: string,
  tier: string,
  tool: string,
  params: unknown,
): PermissionCall {
  if (COLONY_ONLY.has(tool)) return { tool, kind: 'colony', readOnly: true }
  const quiet = tier === 'read' && !readsProject(host, agent, tool, params)
  if (WEB_TOOL(tool)) return { tool, kind: 'web', readOnly: quiet }
  return { tool, kind: tier === 'read' ? 'read' : 'other', readOnly: quiet }
}

/** An MCP or plugin tool's call: MCP tools by their server, with its read-only hint. */
function mcpCallOf(host: ColonyHost, tool: string): PermissionCall {
  if (!tool.startsWith('mcp__')) return { tool, kind: 'other', readOnly: false }
  const readOnly = host.mcpReadOnly(tool)
  return { tool, kind: 'mcp', mcp: { server: host.mcpServer(tool) ?? '', readOnly }, readOnly }
}

/** A refusal the agent reads as final: what was refused and which rule or preset refused it. */
function denied(what: string, verdict: PermissionVerdict): Error {
  return new Error(prompts.toolResults.denied(what, prompts.permissionSource(verdict.source)))
}

/** Object keys sorted, so the same arguments always read the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? {}, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )

/**
 * The key an approved call's receipt is kept under: the same agent making the same call with the same arguments in
 * the same round. A retry (after a crash, or a resumed round replaying its step) finds the receipt and is not run
 * again; a changed call is a new review.
 */
export function receiptKey(host: ColonyHost, agent: string, tool: string, params: unknown): string {
  const round = host.state().rounds.at(-1)?.round ?? 0
  return createHash('sha256')
    .update(`${round}\0${agent}\0${tool}\0${canonical(params)}`)
    .digest('hex')
    .slice(0, 24)
}

/** Once an approved call has run, its result is kept under its key so the same call cannot write or send twice. */
async function keepReceipt(host: ColonyHost, agent: string, tool: string, key: string, output: string) {
  const s = host.state()
  if (s.receipts[key] !== undefined) return
  if (!Object.values(s.approvals).some((a) => a.key === key && a.decided?.approved)) return
  await host.append({
    type: 'review/done',
    actor: SYSTEM,
    payload: { key, agent, tool, output: clip(output, 8_000) },
  })
}

/** Text too long for a review card is shown cut, and then cannot be rewritten there. */
function reviewText(text: string): { value: string; editable: boolean } {
  return text.length <= REVIEW_MAX_CHARS
    ? { value: text, editable: true }
    : { value: text.slice(0, REVIEW_MAX_CHARS) + prompts.reviewCard.cut, editable: false }
}

/** A call's arguments as review fields: text arguments can be rewritten, the rest are shown as they are. */
function callReview(tool: string, params: unknown): Review {
  const args = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const fields: ReviewField[] = []
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      rest[key] = value
      continue
    }
    const text = reviewText(value)
    fields.push({ key, label: key, ...text, format: value.includes('\n') ? 'code' : 'text' })
  }
  if (Object.keys(rest).length)
    fields.push({
      key: '*',
      label: prompts.reviewCard.otherArgs,
      value: JSON.stringify(rest, null, 2),
      format: 'code',
      editable: false,
    })
  return { kind: 'call', title: tool, fields }
}

/**
 * A call the permission model asks about waits for the person, showing the call in full; they may rewrite its text
 * arguments first. A denied call is refused. Returns whether the person rewrote it.
 */
async function askFirst(
  host: ColonyHost,
  agent: string,
  tool: string,
  params: unknown,
  call: PermissionCall,
  key?: string,
): Promise<boolean> {
  const verdict = host.permit(agent, call)
  if (verdict.decision === 'deny') throw denied(`${tool}`, verdict)
  if (verdict.decision === 'allow') return false
  const args = JSON.stringify(params ?? {})
  const decision = await host.reviewChange(
    agent,
    tool,
    `${tool} ${args.length > 280 ? `${args.slice(0, 280)}…` : args}`,
    { review: callReview(tool, params), ...(key ? { key } : {}), permission: { call, verdict } },
  )
  if (!decision.approved) throw new Error(prompts.toolResults.declined(`this ${tool} call`, decision.note))
  const edits = Object.entries(decision.edits ?? {})
  for (const [k, v] of edits) (params as Record<string, unknown>)[k] = v
  return edits.length > 0
}

/** The file-scoped rules each agent of a round was shown already, so a rule comes with one file, not with every read. */
const shownRules = new WeakMap<ColonyHost, Map<string, Set<string>>>()

/**
 * The project's rules for a file an agent just read or wrote (`glob` rules from other tools, see rule-files.ts), each
 * the first time one of its files comes up, the way Cursor attaches a rule when a matching file enters the chat. Its
 * globs are relative to the project, or to the agent's worktree, which is a copy of it. Empty for any other file.
 */
function rulesForFile(host: ColonyHost, agent: string, path: string): string {
  const rules = host.project?.instructions?.rules.filter((r) => r.mode === 'glob') ?? []
  if (rules.length === 0) return ''
  const root = host.workspace.isolation(agent)?.workdir ?? host.workspace.project
  if (!root) return ''
  let base: string
  try {
    base = realpathSync(root)
  } catch {
    return ''
  }
  if (path === base || !within(path, base)) return ''
  const file = relative(base, path).split(sep).join('/')
  const byAgent = shownRules.get(host) ?? new Map<string, Set<string>>()
  shownRules.set(host, byAgent)
  const shown = byAgent.get(agent) ?? new Set<string>()
  byAgent.set(agent, shown)
  return rules
    .filter((r) => !shown.has(r.name) && ruleMatches(r, file))
    .map((r) => {
      shown.add(r.name)
      const cut = r.text.length > RULE_MAX_TEXT
      return prompts.toolResults.projectRule(
        r.name,
        r.file,
        r.globs ?? [],
        cut ? r.text.slice(0, RULE_MAX_TEXT) : r.text,
        cut,
      )
    })
    .join('')
}

/**
 * A file change follows the permission model: where it lands (the project, the agent's own scratch or worktree, or
 * elsewhere, which only full access reaches) and the preset and rules in effect. When it asks, the person sees the new
 * content against the file as it is, and may rewrite it; returns the content to write.
 */
async function guardProjectEdit(
  host: ColonyHost,
  agent: string,
  tool: string,
  path: string,
  change: { before: string; after: string; key: string },
): Promise<{ content: string; edited: boolean }> {
  const unchanged = { content: change.after, edited: false }
  const project = host.spec.chat?.project
  const inside = (root: string) => within(path, root)
  const scratch = host.workspace.scratch(agent)
  const inProject = !!project && inside(project.path) && !inside(scratch)
  const where = inProject
    ? 'project'
    : inside(scratch) || inside(host.workspace.workdir(agent))
      ? 'private'
      : 'outside'
  const call: PermissionCall = { tool, kind: 'edit', where, readOnly: false }
  const verdict = host.permit(agent, call)
  const shown = inProject && project ? relative(project.path, path) : path
  if (verdict.decision === 'deny')
    throw verdict.source.by === 'read-only'
      ? new Error(prompts.toolResults.readOnly(project?.name ?? 'this chat', shown))
      : denied(`changing ${shown}`, verdict)
  if (verdict.decision === 'allow') return unchanged
  const decision = await host.reviewChange(
    agent,
    tool,
    `${tool === 'fs_write' ? 'write' : 'edit'} ${shown}`,
    {
      review: fileReview(
        tool === 'fs_write' ? prompts.reviewCard.write(shown) : prompts.reviewCard.edit(shown),
        shown,
        change,
      ),
      key: change.key,
      permission: { call, verdict },
    },
  )
  if (!decision.approved) throw new Error(prompts.toolResults.declined(`changing ${shown}`, decision.note))
  const edited = decision.edits?.content
  return edited === undefined ? unchanged : { content: edited, edited: true }
}

/** A file's new content against what it holds now. */
function fileReview(title: string, where: string, change: { before: string; after: string }): Review {
  const after = reviewText(change.after)
  const shown = after.editable && change.before.length <= REVIEW_MAX_CHARS
  return {
    kind: 'file',
    title,
    fields: [
      {
        key: 'content',
        label: where,
        format: 'code',
        ...after,
        ...(shown ? { before: change.before } : {}),
      },
    ],
  }
}

/**
 * A command follows the permission model: the preset in effect (Ask asks unless it only looks, Auto before destructive
 * commands) and command rules (a prefix covers a command only when every part of a plain command starts with it).
 * When it asks and the command is real (`editable`), the person may rewrite it first. Returns the command to run.
 */
async function guardProjectCommand(
  host: ColonyHost,
  agent: string,
  tool: string,
  command: string,
  editable = false,
): Promise<string> {
  const line = command.trim()
  const call: PermissionCall = { tool, kind: 'command', command: line, readOnly: false }
  const verdict = host.permit(agent, call)
  if (verdict.decision === 'deny') throw denied('this command', verdict)
  if (verdict.decision === 'allow') return command
  const decision = await host.reviewChange(agent, tool, line.length > 300 ? `${line.slice(0, 300)}…` : line, {
    review: {
      kind: 'command',
      title: prompts.reviewCard.command,
      fields: [{ key: 'command', label: tool, value: line, format: 'code', editable }],
    },
    permission: { call, verdict },
  })
  if (!decision.approved) throw new Error(prompts.toolResults.declined('this command', decision.note))
  return decision.edits?.command ?? command
}

/**
 * Several files changed by one call (ast_edit, lsp rename), each decided as fs_edit decides one: every file is
 * approved before any is written, so a change turned down halfway leaves none behind. Returns the files the person
 * rewrote.
 */
async function writeChanges(
  host: ColonyHost,
  agent: string,
  tool: string,
  key: string,
  changes: readonly FileChange[],
): Promise<string[]> {
  const approved: { path: string; content: string; edited: boolean }[] = []
  for (const c of changes)
    approved.push({ path: c.path, ...(await guardProjectEdit(host, agent, tool, c.path, { ...c, key })) })
  for (const a of approved) writeFileSync(a.path, a.content)
  return approved.filter((a) => a.edited).map((a) => a.path)
}

/** POSIX shell quoting, for the command line a language server starts with inside the sandbox. */
const shQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/** Language servers a person was asked about once in a round, by agent and command line: one card per server. */
const serversAsked = new WeakMap<ColonyHost, Set<string>>()

/**
 * A language server, started as the agent's commands are: the permission model decides it like a command (a project's
 * own lsp.json can name any program), and in the OS sandbox it runs confined like `shell`, with the same environment.
 * Started through omp's client, which needs the server's pipes, so the confinement wraps its command line.
 */
async function launchServer(host: ColonyHost, agent: string, server: ServerConfig): Promise<ServerConfig> {
  if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox) throw new Error(prompts.codeIntel.needsSandbox)
  const argv = [server.resolvedCommand ?? server.command, ...(server.args ?? [])]
  const line = argv.join(' ')
  const asked = serversAsked.get(host) ?? new Set<string>()
  serversAsked.set(host, asked)
  const verdict = host.permit(agent, { tool: 'lsp', kind: 'command', command: line, readOnly: false })
  if (verdict.decision === 'deny') throw denied(`starting ${line}`, verdict)
  if (verdict.decision === 'ask' && !asked.has(`${agent}\0${line}`)) {
    await guardProjectCommand(host, agent, 'lsp', line)
    asked.add(`${agent}\0${line}`)
  }
  if (host.sandbox.kind !== 'sandbox-exec' && host.sandbox.kind !== 'bubblewrap') return server
  const [program = '', ...args] = confinedLaunch(host, commandSpec(host, agent), argv).argv
  return { ...server, command: program, resolvedCommand: program, args }
}

/** Where and with what access the agent's commands run (see `SandboxRun`), without the command. */
function commandSpec(host: ColonyHost, agent: string): Omit<SandboxRun, 'timeoutMs'> {
  return {
    command: '',
    cwd: host.workspace.workdir(agent),
    writable: writableFor(host, agent),
    ...host.workspace.confinement(),
  }
}

/**
 * A program started as the agent's commands are, by a caller that spawns it itself because it needs the program's
 * pipes (a language server, a cell runtime): in the OS sandbox its command line is wrapped in the confinement and run
 * with the sandbox's environment alone; with full access (or no sandbox, when allowed) it runs as it is, in the
 * environment `run` would give it.
 */
function confinedLaunch(
  host: ColonyHost,
  spec: Omit<SandboxRun, 'timeoutMs'>,
  argv: readonly string[],
): { argv: string[]; env: Record<string, string | undefined> } {
  const env = host.sandbox.env(spec)
  if (host.sandbox.kind !== 'sandbox-exec' && host.sandbox.kind !== 'bubblewrap')
    return { argv: [...argv], env }
  const vars = Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`]))
  const command = `exec /usr/bin/env -i ${[...vars, ...argv].map(shQuote).join(' ')}`
  return { argv: host.sandbox.argv({ ...spec, command }), env }
}

/** The access a cell runtime started now would keep while it runs (see `CellAccess`). */
export function cellAccess(host: Pick<ColonyHost, 'sandbox' | 'spec'>): CellAccess {
  return { unconfined: host.sandbox.kind === 'unconfined', readOnly: presetOf(host.spec) === 'read-only' }
}

/**
 * Where an agent's code cells run, as cells.ts sees it: started as its commands are, in its working directory. The
 * runtimes' own files (omp's bundled runtime, its Python runner) go in the chat's folder, which commands may read and
 * not change, and are opened to the runtime by name.
 */
function cellScope(host: ColonyHost, agent: string): CellScope {
  const filesDir = join(host.workspace.colonyDir, 'cells')
  mkdirSync(filesDir, { recursive: true })
  const spec = commandSpec(host, agent)
  const confined = { ...spec, readable: [...(spec.readable ?? []), filesDir] }
  return {
    colonyId: host.id,
    agent,
    access: cellAccess(host),
    cwd: spec.cwd,
    filesDir,
    launch: (argv, env) => confinedLaunch(host, { ...confined, env: { ...env } }, argv),
    python: () => {
      const path = host.sandbox.env(spec).PATH
      return Bun.which('python3', path === undefined ? {} : { PATH: path }) ?? undefined
    },
  }
}

/** Where an agent's code tools work, as code-intel.ts sees it: its working directory, read access, and writes. */
function codeScope(host: ColonyHost, agent: string, tool: string, params: unknown): LspScope {
  const key = receiptKey(host, agent, tool, params)
  return {
    root: host.workspace.workdir(agent),
    resolveRead: (path) => host.workspace.resolveForRead(agent, path),
    mayRead: (path) => host.workspace.mayRead(agent, path),
    mayWrite: (path) => {
      try {
        host.workspace.resolveInWorkdir(agent, path)
        return true
      } catch {
        return false
      }
    },
    write: (changes) => writeChanges(host, agent, tool, key, changes),
    launch: (server) => launchServer(host, agent, server),
    async check(command) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error(prompts.codeIntel.needsSandbox)
      const run = await guardProjectCommand(host, agent, tool, command)
      const r = await host.sandbox.run({
        command: run,
        cwd: host.workspace.workdir(agent),
        writable: writableFor(host, agent),
        ...host.workspace.confinement(),
        timeoutMs: LSP_PROJECT_CHECK_MS,
      })
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-80).join('\n')
      return { ok: !r.timedOut && r.code === 0, output: r.timedOut ? `timed out\n${tail}` : tail }
    },
  }
}

/**
 * Where the github tool's `gh` runs: where the agent's commands run, in its working directory, so gh finds the
 * checkout's repository. A read is decided as the commands it runs (command rules, the preset, a round that asks for
 * everything): a deny refuses any of them, and the person is asked at most once per call, about the first that asks,
 * not once for every page of a run's jobs. A write was approved whole before it runs. Inside the sandbox gh's HOME
 * is private and cannot hold the person's sign-in, so it gets their token in its environment; unconfined it runs as
 * them and reads its own.
 */
function githubScope(host: ColonyHost, agent: string, bin: string, write: boolean): GhScope {
  // Asked for on the first command, so a call refused for its arguments never reaches gh at all.
  let token: Promise<string | undefined> | undefined
  const confined = host.sandbox.kind === 'sandbox-exec' || host.sandbox.kind === 'bubblewrap'
  const syntax = confined ? 'posix' : hostShell().syntax
  const confinement = host.workspace.confinement()
  let asked = write
  return {
    async run(args, timeoutMs = GITHUB.commandMs) {
      const line = `gh ${posixLine(args)}`
      const verdict = host.permit(agent, { tool: 'github', kind: 'command', command: line, readOnly: false })
      if (verdict.decision === 'deny') throw denied('this command', verdict)
      if (verdict.decision === 'ask' && !asked) {
        await guardProjectCommand(host, agent, 'github', line)
        asked = true
      }
      token ??= host.sandbox.kind === 'unconfined' ? Promise.resolve(undefined) : ghToken(bin)
      const secret = await token
      const r = await host.sandbox.run({
        command: shellLine([bin, ...args], syntax),
        cwd: host.workspace.workdir(agent),
        writable: writableFor(host, agent),
        ...confinement,
        // gh may live in a folder the sandbox hides, such as a toolchain folder in the person's home.
        readable: [...confinement.readable, bin],
        timeoutMs,
        env: ghEnv(secret),
      })
      return { ...r, stdout: scrubToken(r.stdout, secret), stderr: scrubToken(r.stderr, secret) }
    },
  }
}

/** Tools whose results are outside content an agent must treat as data, never as instructions. */
const UNTRUSTED = new Set([
  // The log quotes tool results, web pages among them.
  'read_log',
  'request_login',
  'browser_tabs',
  'browser_upload',
  'browser_extract',
  'browser_network',
  'web_search',
  'web_fetch',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_console',
  'browser_eval',
  // Issues, pull requests, comments and CI logs are written by anyone who can open one.
  'github',
])
/** Tools whose command is checked against recent web content before it runs. */
const COPY_CHECKED = new Set(['shell', 'start_server', 'eval'])

function untrustedSource(tool: string, params: unknown, output: string): string {
  const args = (params ?? {}) as { url?: unknown; query?: unknown; op?: unknown }
  if (tool === 'web_fetch' && typeof args.url === 'string') return args.url
  if (tool === 'web_search' && typeof args.query === 'string') return `search: ${args.query}`
  if (tool === 'github' && typeof args.op === 'string') return `github ${args.op}`
  // Browser snapshots start with the page's URL.
  const page = /^url: (\S+)/m.exec(output)?.[1]
  return page ? `${tool} ${page}` : tool
}

/**
 * Marks outside content so the model can tell data from instructions ("spotlighting"). The boundary is random per
 * round and removed from the content, so a page cannot close the block early and speak as the harness.
 */
export function spotlight(boundary: string, source: string, text: string): string {
  const clean = text.replace(/⟦\/?untrusted[^⟧]*⟧/g, '')
  return `⟦untrusted ${boundary} · ${source}⟧\n${clean}\n⟦/untrusted ${boundary}⟧`
}

/**
 * Flags a command that appears word for word in web content the agent just read: the usual shape of a prompt
 * injection ("run this to continue"). It is recorded for the person, not blocked; copying a documented install
 * command is often legitimate.
 */
async function flagIfCopied(host: ColonyHost, agent: string, tool: string, params: unknown) {
  const args = params as { command?: unknown; code?: unknown } | undefined
  const command = String(args?.command ?? args?.code ?? '').trim()
  if (command.length < 12) return
  const hit = host.recentUntrusted(agent).find((u) => u.text.includes(command))
  if (!hit) return
  await host.append({
    type: 'safety/flagged',
    actor: { kind: 'system', id: 'myrmidon' },
    payload: {
      agent,
      tool,
      reason: `ran a command that appears word for word in web content: ${command.slice(0, 200)}`,
      source: hit.source,
    },
  })
}

/** Reads tables, links, or repeating items from a page's DOM (browser_extract and saved browser flows). */
function extractFromPage(
  page: BrowserTab['page'],
  what: 'tables' | 'links' | 'items',
  selector: string,
  fields: Record<string, string>,
  limit: number,
): Promise<unknown[]> {
  return page.evaluate(
    (what, selector, fields, limit) => {
      const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const roots = selector ? [...document.querySelectorAll(selector)] : [document.body]
      if (what === 'links') {
        const out: { text: string; href: string }[] = []
        for (const root of roots)
          for (const a of root.querySelectorAll('a[href]')) {
            if (out.length >= limit) break
            out.push({ text: text(a), href: (a as HTMLAnchorElement).href })
          }
        return out
      }
      if (what === 'tables') {
        const tables = roots.flatMap((r) => (r.matches('table') ? [r] : [...r.querySelectorAll('table')]))
        return tables.slice(0, 20).map((t) => {
          const rows = [...t.querySelectorAll('tr')]
          const head = rows.find((r) => r.querySelector('th')) ?? rows[0]
          const headers = [...(head?.children ?? [])].map((c, i) => text(c) || `col${i + 1}`)
          const body = rows.filter((r) => r !== head)
          return {
            caption: text(t.querySelector('caption')),
            headers,
            rows: body
              .slice(0, limit)
              .map((r) =>
                Object.fromEntries([...r.children].map((c, i) => [headers[i] ?? `col${i + 1}`, text(c)])),
              ),
          }
        })
      }
      return roots.slice(0, limit).map((item) =>
        Object.fromEntries(
          Object.entries(fields).map(([name, spec]) => {
            const [css = '', attr] = spec.split('@')
            const el = css ? item.querySelector(css) : item
            if (!el) return [name, null]
            if (!attr) return [name, text(el)]
            // href and src come back absolute, the way a person would copy them.
            const value =
              attr === 'href' || attr === 'src'
                ? (((el as unknown as Record<string, unknown>)[attr] as string | undefined) ??
                  el.getAttribute(attr))
                : el.getAttribute(attr)
            return [name, value]
          }),
        ),
      )
    },
    what,
    selector,
    fields,
    limit,
  ) as Promise<unknown[]>
}

/** The checks run by default: the project's `check` script if it has one, otherwise everything but build. */
export function pickChecks(all: readonly ProjectCheck[], only?: string): ProjectCheck[] {
  if (only) return all.filter((c) => c.name === only)
  return all.some((c) => c.name === 'check')
    ? all.filter((c) => c.name === 'check')
    : all.filter((c) => c.name !== 'build')
}

/** Runs checks one after another in the sandbox; the report lists PASS/FAIL per check and the failing output. */
export async function runProjectChecks(
  host: ColonyHost,
  cwd: string,
  writable: readonly string[],
  checks: readonly ProjectCheck[],
): Promise<{ ok: boolean; report: string }> {
  const lines: string[] = []
  const failures: string[] = []
  for (const check of checks) {
    const started = Date.now()
    const r = await host.sandbox.run({
      command: check.command,
      cwd,
      writable: [...new Set(writable)],
      ...host.workspace.confinement(),
      timeoutMs: 300_000,
    })
    const ok = !r.timedOut && r.code === 0
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`
    lines.push(
      `${ok ? 'PASS' : 'FAIL'} ${check.name} (\`${check.command}\`, ${r.timedOut ? 'timed out' : took})`,
    )
    if (!ok) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-60).join('\n')
      failures.push(`--- ${check.name} (${r.timedOut ? 'timed out after 300s' : `exit ${r.code}`})\n${tail}`)
    }
  }
  return {
    ok: failures.length === 0,
    report: [...lines, ...(failures.length ? ['', ...failures] : [])].join('\n'),
  }
}

/** Where the file tools work, before the agent's facts are known: the neutral default. */
const PLACE: Place = { where: 'working', full: false }

/** Where this agent's file tools work, for their descriptions. */
function placeOf(f: PromptFacts): Place {
  const where = f.access.worktree ? 'worktree' : f.access.project ? 'project' : 'scratch'
  return { where, full: f.access.fullAccess }
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'read_task',
    tier: 'read',
    description: prompts.tools.read_task.description,
    parameters: type({}),
    async run(_args, agent, host) {
      const s = host.state()
      const left = Math.max(0, Math.round((host.deadline() - Date.now()) / 1000))
      const roster = Object.values(s.agents)
        .map(
          (a) => `- ${a.info.name} (${a.info.role}, ${a.info.model})${a.info.name === agent ? ' ← you' : ''}`,
        )
        .join('\n')
      const acceptance =
        host.spec.acceptance.map((c) => `- ${describeCheck(c)}`).join('\n') || '- none declared'
      return `MISSION:\n${s.mission}\n\nACCEPTANCE (checked by the verifier, not by agents):\n${acceptance}\n\nTIME LEFT: ${left}s\n\nROSTER:\n${roster}`
    },
  },
  {
    name: 'append_note',
    tier: 'write',
    description: prompts.tools.append_note.description,
    parameters: type({
      text: type('string').atLeastLength(1).describe(prompts.tools.append_note.params.text),
      'section?': type("'plan' | 'decision' | 'finding' | 'status'").describe(
        prompts.tools.append_note.params.section,
      ),
      'corrects?': type('string').describe(prompts.tools.append_note.params.corrects),
    }),
    async run(args, agent, host) {
      const e = first(
        await host.appendAtomic((s) => {
          // One plan per round: a chat's later rounds plan their own request.
          const from = s.rounds.at(-1)?.startSeq ?? 0
          const plan = s.notes.find((n) => n.section === 'plan' && n.seq >= from)
          if (args.section === 'plan' && plan && args.corrects !== plan.id)
            throw new Error(
              `a plan already exists (${plan.id} by ${plan.agent}); refine it with a "decision" note, or correct it by passing corrects: "${plan.id}"`,
            )
          return [
            {
              type: 'note/appended',
              actor: agentActor(agent),
              payload: {
                agent,
                text: args.text,
                ...(args.section ? { section: args.section } : {}),
                ...(args.corrects ? { corrects: args.corrects } : {}),
              },
            },
          ]
        }),
      )
      return `note ${e.id} appended`
    },
  },
  {
    name: 'read_notes',
    tier: 'read',
    description: prompts.tools.read_notes.description,
    parameters: type({}),
    async run(_args, _agent, host) {
      const notes = host.state().notes
      return (
        clip(
          notes
            .map(
              (n) =>
                `${n.id} ${n.agent}${n.section ? ` [${n.section}]` : ''}: ${n.text}${n.corrects ? ` (corrects ${n.corrects})` : ''}`,
            )
            .join('\n'),
        ) || '(no notes yet)'
      )
    },
  },
  {
    name: 'message',
    tier: 'write',
    description: prompts.tools.message.description,
    parameters: type({
      to: type('string').describe(prompts.tools.message.params.to),
      text: type('string').atLeastLength(1).describe(prompts.tools.message.params.text),
      'reply_to?': type('number').describe(prompts.tools.message.params.reply_to),
    }),
    async run(args, agent, host) {
      const state = host.state()
      if (args.to === agent) throw new Error('you cannot message yourself')
      const chat = resolveConversation(state, agent, args.to)
      if (chat.kind === 'direct' && !crewOf(state).includes(args.to))
        throw new Error(
          `no such crewmate or group: ${args.to}. Crewmates: ${crewOf(state).join(', ')}; groups: ${Object.keys(state.groups).join(', ') || 'none'}; or "team"`,
        )
      if (chat.kind === 'group' && !chat.members.includes(agent))
        throw new Error(`you are not in the group ${args.to}; ask a member to add you`)
      if (args.reply_to !== undefined && !linesOf(state, chat.id).some((l) => l.seq === args.reply_to))
        throw new Error(`#${args.reply_to} is not a message in your conversation with ${args.to}`)
      const closing = host.closing?.(agent)
      if (closing) return closing
      const replyTo = args.reply_to !== undefined ? { replyTo: args.reply_to } : {}
      if (chat.kind === 'team') {
        const mentions = mentionsIn(args.text, chat.members).filter((m) => m !== agent)
        const e = await host.append({
          type: 'board/posted',
          actor: agentActor(agent),
          payload: { agent, text: args.text, mentions, ...replyTo },
        })
        return `sent #${e.seq} to the team chat${mentions.length ? ` (woke ${mentions.join(', ')})` : ''}`
      }
      const e = await host.append({
        type: 'mail/sent',
        actor: agentActor(agent),
        payload: {
          from: agent,
          to: args.to,
          subject: '',
          body: args.text,
          ...replyTo,
          ...(chat.kind === 'group' ? { members: [...chat.members] } : {}),
        },
      })
      return `sent #${e.seq} to ${args.to}`
    },
  },
  {
    name: 'create_group',
    tier: 'write',
    description: prompts.tools.create_group.description,
    parameters: type({
      name: type('string').describe(prompts.tools.create_group.params.name),
      members: type('string').array().atLeastLength(1).describe(prompts.tools.create_group.params.members),
      'text?': type('string').describe(prompts.tools.create_group.params.text),
    }),
    async run(args, agent, host) {
      const state = host.state()
      const crew = crewOf(state)
      if (!GROUP_NAME.test(args.name))
        throw new Error('name must be 2-31 lowercase letters, digits and dashes')
      if (args.name === TEAM_CHAT || state.agents[args.name] || state.groups[args.name])
        throw new Error(`"${args.name}" is taken; choose another name`)
      const unknown = args.members.filter((m: string) => !crew.includes(m))
      if (unknown.length) throw new Error(`not on the crew: ${unknown.join(', ')}`)
      const members = [...new Set([agent, ...args.members])]
      if (members.length < 2) throw new Error('a group needs at least one crewmate besides you')
      const closing = args.text ? host.closing?.(agent) : undefined
      if (closing) return closing
      await host.append({
        type: 'group/created',
        actor: agentActor(agent),
        payload: { name: args.name, members, by: agent },
      })
      if (!args.text) return `group ${args.name} created with ${members.join(', ')}`
      const e = await host.append({
        type: 'mail/sent',
        actor: agentActor(agent),
        payload: { from: agent, to: args.name, subject: '', body: args.text, members },
      })
      return `group ${args.name} created with ${members.join(', ')}; sent #${e.seq}`
    },
  },
  {
    name: 'update_group',
    tier: 'write',
    description: prompts.tools.update_group.description,
    parameters: type({
      name: type('string').describe(prompts.tools.update_group.params.name),
      'add?': type('string').array().describe(prompts.tools.update_group.params.add),
      'remove?': type('string').array().describe(prompts.tools.update_group.params.remove),
    }),
    async run(args, agent, host) {
      const state = host.state()
      const members = groupMembers(state, args.name)
      if (!state.groups[args.name]) throw new Error(`no such group: ${args.name}`)
      if (!members.includes(agent)) throw new Error(`you are not in the group ${args.name}`)
      const add = (args.add ?? []).filter((m: string) => !members.includes(m))
      const unknown = add.filter((m: string) => !crewOf(state).includes(m))
      if (unknown.length) throw new Error(`not on the crew: ${unknown.join(', ')}`)
      const remove = (args.remove ?? []).filter((m: string) => members.includes(m))
      if (!add.length && !remove.length) return 'nothing to change'
      await host.append({
        type: 'group/changed',
        actor: agentActor(agent),
        payload: { name: args.name, add, remove, by: agent },
      })
      return `${args.name}: ${[...add.map((m: string) => `added ${m}`), ...remove.map((m: string) => (m === agent ? 'you left' : `removed ${m}`))].join(', ')}`
    },
  },
  {
    name: 'read_messages',
    tier: 'read',
    description: prompts.tools.read_messages.description,
    parameters: type({
      'with?': type('string').describe(prompts.tools.read_messages.params.with),
      'limit?': type('number').describe(prompts.tools.read_messages.params.limit),
    }),
    async run(args, agent, host) {
      const state = host.state()
      const line = (l: ConversationLine) =>
        `#${l.seq} ${l.from === agent ? 'you' : l.from}${l.replyTo !== undefined ? ` (re #${l.replyTo})` : ''}: ${l.text}`
      if (args.with) {
        const chat = resolveConversation(state, agent, args.with)
        if (chat.kind === 'group' && !chat.members.includes(agent))
          throw new Error(`you are not in the group ${args.with}`)
        const lines = linesOf(state, chat.id).slice(-(args.limit ?? 30))
        const who = chat.kind === 'direct' ? '' : `members: ${chat.members.join(', ')}\n`
        return clip(`${who}${lines.map(line).join('\n') || '(no messages yet)'}`)
      }
      return (
        conversationsOf(state, agent)
          .map((c) => {
            const last = linesOf(state, c.id).at(-1)
            const label =
              c.kind === 'team'
                ? 'team chat'
                : c.kind === 'group'
                  ? `group ${c.name} (${c.members.join(', ')})`
                  : c.name
            return `${label}: ${last ? line(last) : '(quiet)'}`
          })
          .join('\n') + '\nRead one with read_messages(with: …).'
      )
    },
  },
  {
    name: 'list_agents',
    tier: 'read',
    description: prompts.tools.list_agents.description,
    parameters: type({}),
    async run(_args, _agent, host) {
      const s = host.state()
      const here = Object.values(s.agents).map((a) => {
        const task = Object.values(s.tasks).find((t) => t.owner === a.info.name && t.status === 'in_progress')
        return `${a.info.name} (${a.info.role}) ${a.status}${task ? ` working on ${task.id}` : ''}`
      })
      // A solo lead's crewmates on call are crew too, before ask_crewmate brings them in.
      const onCall = (host.spec.team?.crewmates ?? [])
        .filter((c) => !s.agents[c.name])
        .map((c) => `${c.name} (${c.specialty ?? 'crewmate'}) on call`)
      return [...here, ...onCall].join('\n')
    },
  },
  {
    name: 'list_tasks',
    tier: 'read',
    description: prompts.tools.list_tasks.description,
    parameters: type({}),
    async run(_args, _agent, host) {
      const tasks = Object.values(host.state().tasks).filter((t) => t.status !== 'deleted')
      return tasks.map(taskLine).join('\n') || '(no tasks yet)'
    },
  },
  {
    name: 'create_task',
    tier: 'write',
    description: prompts.tools.create_task.description(prompts.system.brief),
    parameters: type({
      subject: type('string').atLeastLength(1).describe(prompts.tools.create_task.params.subject),
      'description?': type('string').describe(prompts.tools.create_task.params.description),
      'assignee?': type('string').describe(prompts.tools.create_task.params.assignee),
      'outputs?': type('string').array().describe(prompts.tools.create_task.params.outputs),
      'blockedBy?': type('string').array().describe(prompts.tools.create_task.params.blockedBy),
    }),
    async run(args, agent, host) {
      const e = first(
        await host.appendAtomic((s) => {
          const blockedBy: string[] = args.blockedBy ?? []
          for (const b of blockedBy) {
            if (!s.tasks[b])
              throw new Error(
                `blockedBy ${b} does not exist yet: create the blocking task first, then use the id it returns`,
              )
          }
          if (args.assignee && !s.agents[args.assignee]) throw new Error(`no such agent: ${args.assignee}`)
          if (host.spec.team?.mode === 'swarm') {
            if (FINAL_TASK.test(args.subject))
              throw new Error(
                'the harness creates task-final for the final answer once every other task is verified; plan only the work',
              )
            const twin = Object.values(s.tasks).find(
              (t) =>
                t.status !== 'deleted' && t.status !== 'verified' && similar(t.subject, args.subject) >= 0.6,
            )
            if (twin)
              throw new Error(
                `similar to ${twin.id} (${twin.subject}); claim it, or split it with a more specific task that uses blockedBy`,
              )
          }
          const outputs: string[] = (args.outputs ?? []).map(assertArtifactName)
          const id = `task-${Object.keys(s.tasks).length + 1}`
          return [
            taskEvent(agent, {
              id,
              revision: 1,
              subject: args.subject,
              description: args.description ?? '',
              status: 'pending',
              blockedBy,
              artifacts: [],
              ...(args.assignee ? { assignee: args.assignee } : {}),
              ...(outputs.length ? { outputs } : {}),
            }),
          ]
        }),
      )
      const task = (e.payload as EventPayloads['task/changed']).task
      return `created ${taskLine(task)}`
    },
  },
  {
    name: 'claim_task',
    tier: 'write',
    description: prompts.tools.claim_task.description,
    parameters: type({
      id: type('string').describe(prompts.tools.claim_task.params.id),
      revision: type('number').describe(prompts.tools.claim_task.params.revision),
    }),
    async run(args, agent, host) {
      if (args.id === 'task-final') throw new Error(FINAL_HINT)
      const e = first(
        await host.appendAtomic((s) => {
          const task = requireTask(s, args.id)
          if (task.revision !== args.revision) {
            throw new Error(`stale revision: ${task.id} is at r${task.revision}; re-read with list_tasks`)
          }
          if (task.status !== 'pending' && task.status !== 'rejected')
            throw new Error(`${task.id} is ${task.status}`)
          if (!blockersDone(s, task)) throw new Error(`${task.id} is blocked by ${task.blockedBy.join(', ')}`)
          return [
            taskEvent(agent, { ...task, revision: task.revision + 1, status: 'in_progress', owner: agent }),
          ]
        }),
      )
      // A task often builds on work merged since this worker's worktree was made; start it from the latest code.
      const updated = await host.refreshWork(agent)
      const note = updated.length ? prompts.toolResults.worktreeUpdated(updated) : ''
      return `claimed ${taskLine((e.payload as EventPayloads['task/changed']).task)}${note}`
    },
  },
  {
    name: 'assign_task',
    tier: 'write',
    description: prompts.tools.assign_task.description,
    parameters: type({
      id: type('string').describe(prompts.tools.assign_task.params.id),
      assignee: type('string').describe(prompts.tools.assign_task.params.assignee),
      revision: type('number').describe(prompts.tools.assign_task.params.revision),
    }),
    async run(args, agent, host) {
      await host.appendAtomic((s) => {
        const task = requireTask(s, args.id)
        if (!s.agents[args.assignee]) throw new Error(`no such agent: ${args.assignee}`)
        if (task.revision !== args.revision)
          throw new Error(`stale revision: ${task.id} is at r${task.revision}`)
        if (task.status !== 'pending' && task.status !== 'rejected')
          throw new Error(`${task.id} is ${task.status}; only pending or rejected tasks can be assigned`)
        return [taskEvent(agent, { ...task, revision: task.revision + 1, assignee: args.assignee })]
      })
      return `${args.id} assigned to ${args.assignee}`
    },
  },
  {
    name: 'release_task',
    tier: 'write',
    description: prompts.tools.release_task.description,
    parameters: type({
      id: type('string').describe(prompts.tools.release_task.params.id),
      revision: type('number').describe(prompts.tools.release_task.params.revision),
    }),
    async run(args, agent, host) {
      if (args.id === 'task-final') throw new Error(FINAL_HINT)
      await host.appendAtomic((s) => {
        const task = requireTask(s, args.id)
        if (task.owner !== agent || task.status !== 'in_progress')
          throw new Error(`you do not hold ${task.id}`)
        if (task.revision !== args.revision)
          throw new Error(`stale revision: ${task.id} is at r${task.revision}`)
        const { owner: _owner, ...rest } = task
        return [taskEvent(agent, { ...rest, revision: task.revision + 1, status: 'pending' })]
      })
      return `released ${args.id}`
    },
  },
  {
    name: 'reject_task',
    tier: 'write',
    description: prompts.tools.reject_task.description,
    parameters: type({
      id: type('string').describe(prompts.tools.reject_task.params.id),
      revision: type('number').describe(prompts.tools.reject_task.params.revision),
      reason: type('string').atLeastLength(10).describe(prompts.tools.reject_task.params.reason),
    }),
    async run(args, agent, host) {
      if (args.id === 'task-final') throw new Error(FINAL_HINT)
      if (host.spec.pattern === 'lead-workers' && host.state().agents[agent]?.info.role !== 'lead')
        throw new Error('only the lead sends tasks back; post what you found with @lead instead')
      await host.appendAtomic((s) => {
        const task = requireTask(s, args.id)
        if (task.revision !== args.revision)
          throw new Error(`stale revision: ${task.id} is at r${task.revision}; re-read with read_task`)
        if (task.status !== 'submitted' && task.status !== 'verified')
          throw new Error(`${task.id} is ${task.status}; only submitted or verified work can be sent back`)
        if (task.owner === agent)
          throw new Error('you own this task: keep working on it instead of rejecting it')
        return [
          {
            type: 'task/changed',
            actor: agentActor(agent),
            payload: {
              task: { ...task, revision: task.revision + 1, status: 'rejected' },
              by: agent,
              reason: args.reason,
            },
          },
        ]
      })
      return `sent ${args.id} back to ${host.state().tasks[args.id]?.owner ?? 'its owner'} with your reason`
    },
  },
  {
    name: 'submit_task',
    tier: 'write',
    description: prompts.tools.submit_task.description,
    parameters: type({
      id: type('string').describe(prompts.tools.submit_task.params.id),
      revision: type('number').describe(prompts.tools.submit_task.params.revision),
      artifacts: type('string').array().describe(prompts.tools.submit_task.params.artifacts),
    }),
    async run(args, agent, host) {
      if (args.id === 'task-final') throw new Error(FINAL_HINT)
      const held = host.state().tasks[args.id]
      if (held?.owner !== agent || held.status !== 'in_progress')
        throw new Error(`you do not hold ${args.id}`)
      if (held.outputs?.length && args.artifacts.length === 0)
        throw new Error(prompts.toolResults.outputsMissing(args.id, held.outputs))
      // A worker in its own worktree hands its changes to the project folder first, so the reviewer sees them.
      const merged = await host.mergeWork(agent)
      await host.appendAtomic((s) => {
        const task = requireTask(s, args.id)
        if (task.owner !== agent || task.status !== 'in_progress')
          throw new Error(`you do not hold ${task.id}`)
        if (task.revision !== args.revision)
          throw new Error(`stale revision: ${task.id} is at r${task.revision}`)
        for (const name of args.artifacts)
          if (!s.artifacts[name]) throw new Error(`no such artifact: ${name}`)
        return [
          taskEvent(agent, {
            ...task,
            revision: task.revision + 1,
            status: 'submitted',
            artifacts: args.artifacts,
          }),
        ]
      })
      host.requestTaskVerification(args.id, agent)
      const note = merged.length
        ? ` (merged ${merged.length} file${merged.length === 1 ? '' : 's'} into the project)`
        : ''
      return `${args.id} submitted${note}; the verifier will report back`
    },
  },
  {
    name: 'publish_artifact',
    tier: 'write',
    description: prompts.tools.publish_artifact.description,
    parameters: type({
      name: type('string').describe(prompts.tools.publish_artifact.params.name),
      'content?': type('string').describe(prompts.tools.publish_artifact.params.content),
      'fromScratch?': type('string').describe(prompts.tools.publish_artifact.params.fromScratch),
      'mediaType?': type('string').describe(prompts.tools.publish_artifact.params.mediaType),
    }),
    async run(args, agent, host) {
      const name = assertArtifactName(args.name)
      // Models often send an empty `content` alongside `fromScratch`; treat empty as absent, but never guess between two real sources.
      const content = typeof args.content === 'string' && args.content.length > 0 ? args.content : undefined
      if (content !== undefined && args.fromScratch)
        throw new Error('give either content or fromScratch, not both')
      let bytes: Uint8Array
      if (content !== undefined) bytes = new TextEncoder().encode(content)
      else if (args.fromScratch)
        bytes = readFileSync(host.workspace.resolveInWorkdir(agent, args.fromScratch))
      else throw new Error('give non-empty content or fromScratch')
      if (bytes.byteLength === 0) throw new Error('refusing to publish an empty artifact')
      if (bytes.byteLength > MAX_ARTIFACT_BYTES)
        throw new Error(`artifact too large (${bytes.byteLength} bytes)`)
      const { version, size } = await publishFile(
        host,
        agent,
        name,
        bytes,
        args.mediaType ?? guessMediaType(name),
      )
      return `published ${name} v${version} (${size} bytes)`
    },
  },
  {
    name: 'read_artifact',
    tier: 'read',
    description: prompts.tools.read_artifact.description,
    parameters: type({
      name: type('string').describe(prompts.tools.read_artifact.params.name),
      'version?': type('number').describe(prompts.tools.read_artifact.params.version),
    }),
    async run(args, _agent, host) {
      const versions = host.state().artifacts[args.name]
      if (!versions) throw new Error(`no such artifact: ${args.name}`)
      const v = args.version ? versions.find((x) => x.version === args.version) : versions.at(-1)
      if (!v) throw new Error(`${args.name} has no version ${args.version}`)
      const head = `${args.name} v${v.version} by ${v.author}`
      const isImage = IMAGE_MAGIC[v.mediaType]
      if (isImage) {
        const bytes = await host.blobs.get(v.blob)
        if (isImage(bytes)) {
          const data = Buffer.from(bytes).toString('base64')
          return {
            text: `${head}: ${v.mediaType} image, ${v.size} bytes`,
            images: [{ data, mimeType: v.mediaType }],
          }
        }
        return `${head}:\n${clip(new TextDecoder().decode(bytes))}`
      }
      if (!isTextual(v.mediaType))
        return `${head}: ${v.mediaType}, ${v.size} bytes of binary data (not readable as text)`
      return `${head}:\n${clip(await host.blobs.text(v.blob))}`
    },
  },
  {
    name: 'list_artifacts',
    tier: 'read',
    description: prompts.tools.list_artifacts.description,
    parameters: type({}),
    async run(_args, _agent, host) {
      const entries = Object.entries(host.state().artifacts)
      return (
        entries
          .map(([n, vs]) => `${n} v${vs.at(-1)?.version} (${vs.at(-1)?.size} bytes, ${vs.at(-1)?.author})`)
          .join('\n') || '(no artifacts yet)'
      )
    },
  },
  {
    name: 'generate_image',
    tier: 'write',
    description: prompts.tools.generate_image.description,
    parameters: type({
      prompt: type('string').atLeastLength(3).describe(prompts.tools.generate_image.params.prompt),
      'inputs?': type('string[]').describe(prompts.tools.generate_image.params.inputs),
      'aspectRatio?': type("'1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '3:2' | '2:3'").describe(
        prompts.tools.generate_image.params.aspectRatio,
      ),
      'size?': type("'1024x1024' | '1536x1024' | '1024x1536'").describe(
        prompts.tools.generate_image.params.size,
      ),
      'count?': type('number').describe(prompts.tools.generate_image.params.count),
      'name?': type('string').describe(prompts.tools.generate_image.params.name),
    }),
    async run(args, agent, host) {
      if (!host.media) throw new Error(prompts.toolResults.noMedia)
      const refs: string[] = args.inputs ?? []
      if (refs.length > MAX_IMAGE_INPUTS) throw new Error(prompts.toolResults.tooManyInputs(MAX_IMAGE_INPUTS))
      const inputImages = await Promise.all(refs.map((ref) => inputImage(host, agent, ref)))
      const made = await host.media.generateImage(
        {
          prompt: args.prompt,
          ...(inputImages.length ? { inputImages } : {}),
          ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
          ...(args.size ? { imageSize: args.size } : {}),
          count: Math.min(Math.max(1, Math.round(args.count ?? 1)), MAX_IMAGES_PER_CALL),
        },
        AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      )
      const usage: UsageInfo | undefined =
        made.cost !== undefined || made.tokens.total > 0
          ? {
              input: made.tokens.input,
              output: made.tokens.output,
              totalTokens: made.tokens.total,
              ...(made.cost !== undefined ? { cost: made.cost } : {}),
            }
          : undefined
      const spent = usage ? { usage } : {}
      if (made.images.length === 0)
        return { text: prompts.toolResults.noPicture(made.model, made.text), images: [], ...spent }
      const published: { name: string; version: number; copy: string }[] = []
      for (const [i, image] of made.images.entries()) {
        const bytes = new Uint8Array(Buffer.from(image.data, 'base64'))
        const mimeType = sniffImage(bytes) ?? image.mimeType
        const extension = IMAGE_EXTENSIONS[mimeType] ?? 'png'
        const index = made.images.length > 1 ? i + 1 : undefined
        const name = mediaName(args.name, args.prompt, 'images', extension, index)
        published.push(await publishMedia(host, agent, name, bytes, mimeType))
      }
      return {
        text: prompts.toolResults.picturesMade(made.model, published, made.text),
        images: made.images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
        ...spent,
      }
    },
  },
  {
    name: 'tts',
    tier: 'write',
    description: prompts.tools.tts.description,
    parameters: type({
      text: type('string')
        .atLeastLength(1)
        .atMostLength(TTS_MAX_CHARS)
        .describe(prompts.tools.tts.params.text),
      'name?': type('string').describe(prompts.tools.tts.params.name),
    }),
    async run(args, agent, host) {
      if (!host.media) throw new Error(prompts.toolResults.noMedia)
      const spoken = await host.media.speak(args.text)
      const name = mediaName(args.name, args.text, 'audio', 'wav')
      const file = await publishMedia(host, agent, name, spoken.audio, spoken.mimeType)
      const { pcm, sampleRate } = parseWav(spoken.audio)
      return prompts.toolResults.speechMade(file, spoken.voice, pcm.length / sampleRate)
    },
  },
  {
    name: 'observe',
    tier: 'read',
    description: prompts.tools.observe.description,
    parameters: type({}),
    async run(_args, _agent, host) {
      return observeFacts(host)
    },
  },
  {
    name: 'use_skill',
    tier: 'read',
    description: prompts.tools.use_skill.description,
    parameters: type({
      name: type('string').describe(prompts.tools.use_skill.params.name),
      'file?': type('string').describe(prompts.tools.use_skill.params.file),
    }),
    async run(args, agent, host) {
      return host.useSkill(agent, args.name, args.file)
    },
  },
  {
    name: 'find_tools',
    tier: 'read',
    description: prompts.tools.find_tools.description,
    parameters: type({
      query: type('string').atLeastLength(2).describe(prompts.tools.find_tools.params.query),
    }),
    async run(args, agent, host) {
      return host.loadTools(agent, args.query)
    },
  },
  {
    name: 'read_log',
    tier: 'read',
    description: prompts.tools.read_log.description,
    parameters: type({
      'agent?': type('string').describe(prompts.tools.read_log.params.agent),
      'tool?': type('string').describe(prompts.tools.read_log.params.tool),
      'last?': type('number').describe(prompts.tools.read_log.params.last),
      'entry?': type('number').describe(prompts.tools.read_log.params.entry),
    }),
    async run(args, _agent, host) {
      const events = await host.log.read(host.id)
      if (args.entry !== undefined) return clip(logEntry(events, Math.round(args.entry)))
      const lines = logLines(events, args)
      const last = Math.min(100, Math.max(1, Math.round(args.last ?? 30)))
      if (lines.length === 0) return 'nothing in the log matches'
      return `${lines.length > last ? `(${lines.length - last} earlier entries left out)\n` : ''}${lines.slice(-last).join('\n')}`
    },
  },
  {
    name: 'request_review',
    tier: 'write',
    description: prompts.tools.request_review.description,
    parameters: type({ summary: type('string').describe(prompts.tools.request_review.params.summary) }),
    async run(args, agent, host) {
      return host.requestReview(agent, args.summary)
    },
  },
  {
    name: 'request_final_verification',
    tier: 'write',
    description: prompts.tools.request_final_verification.description,
    parameters: type({
      summary: type('string').describe(prompts.tools.request_final_verification.params.summary),
    }),
    async run(args, agent, host) {
      return host.requestFinalVerification(agent, args.summary)
    },
  },
  {
    name: 'fs_write',
    tier: 'write',
    description: prompts.tools.fs_write.description(PLACE),
    describe: (f) => prompts.tools.fs_write.description(placeOf(f)),
    parameters: type({
      path: type('string').describe(prompts.tools.fs_write.params.path),
      content: type('string').describe(prompts.tools.fs_write.params.content),
    }),
    async run(args, agent, host) {
      const path = host.workspace.resolveInWorkdir(agent, args.path)
      const { content, edited } = await guardProjectEdit(host, agent, 'fs_write', path, {
        before: existsSync(path) ? readFileSync(path, 'utf8') : '',
        after: args.content,
        key: receiptKey(host, agent, 'fs_write', args),
      })
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return `wrote ${args.path} (${Buffer.byteLength(content)} bytes)${edited ? prompts.toolResults.editedByPerson : ''}${rulesForFile(host, agent, path)}`
    },
  },
  {
    name: 'fs_edit',
    tier: 'write',
    description: prompts.tools.fs_edit.description(PLACE),
    describe: (f) => prompts.tools.fs_edit.description(placeOf(f)),
    parameters: type({
      path: type('string').describe(prompts.tools.fs_edit.params.path),
      old: type('string').atLeastLength(1).describe(prompts.tools.fs_edit.params.old),
      new: type('string').describe(prompts.tools.fs_edit.params.new),
      'all?': type('boolean').describe(prompts.tools.fs_edit.params.all),
    }),
    async run(args, agent, host) {
      const path = host.workspace.resolveInWorkdir(agent, args.path)
      const text = readFileSync(path, 'utf8')
      const count = text.split(args.old).length - 1
      if (count === 0)
        throw new Error(`old text not found in ${args.path}; re-read the file and copy the snippet exactly`)
      if (count > 1 && !args.all)
        throw new Error(
          `old text appears ${count} times in ${args.path}; include more surrounding lines, or set all`,
        )
      const { content, edited } = await guardProjectEdit(host, agent, 'fs_edit', path, {
        before: text,
        after: args.all ? text.split(args.old).join(args.new) : text.replace(args.old, () => args.new),
        key: receiptKey(host, agent, 'fs_edit', args),
      })
      writeFileSync(path, content)
      return `edited ${args.path} (${args.all ? count : 1} replacement${count > 1 && args.all ? 's' : ''})${edited ? prompts.toolResults.editedByPerson : ''}${rulesForFile(host, agent, path)}`
    },
  },
  {
    name: 'fs_read',
    tier: 'read',
    description: prompts.tools.fs_read.description(PLACE),
    describe: (f) => prompts.tools.fs_read.description(placeOf(f)),
    parameters: type({
      path: type('string').describe(prompts.tools.fs_read.params.path),
      'offset?': type('number').describe(prompts.tools.fs_read.params.offset),
      'limit?': type('number').describe(prompts.tools.fs_read.params.limit),
      'entry?': type('string').describe(prompts.tools.fs_read.params.entry),
      'sql?': type('string').describe(prompts.tools.fs_read.params.sql),
    }),
    async run(args, agent, host) {
      const path = host.workspace.resolveForRead(agent, args.path)
      const read = await readFileAs(path, args.path, args)
      if (read.image) return { text: read.head ?? '', images: [read.image] }
      const text = `${readRange(read.text, args.offset, args.limit)}${rulesForFile(host, agent, path)}`
      return read.head ? { text, images: [], preface: `${read.head}\n` } : text
    },
  },
  {
    name: 'fs_list',
    tier: 'read',
    description: prompts.tools.fs_list.description(PLACE),
    describe: (f) => prompts.tools.fs_list.description(placeOf(f)),
    parameters: type({ 'path?': type('string').describe(prompts.tools.fs_list.params.path) }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const dir = host.workspace.resolveForRead(agent, args.path ?? '.')
      const out: string[] = []
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (SANDBOX_DIRS.has(entry.name) || SKIP_DIRS.has(entry.name) || out.length > 500) continue
          const full = join(d, entry.name)
          // A readable folder can hold what stays hidden (the person's keys in a home they opened).
          if (!host.workspace.mayRead(agent, full)) continue
          if (entry.isDirectory()) walk(full)
          else out.push(`${relative(root, full)} (${statSync(full).size} bytes)`)
        }
      }
      walk(dir)
      return out.join('\n') || '(empty)'
    },
  },
  {
    name: 'grep',
    tier: 'read',
    description: prompts.tools.grep.description(PLACE),
    describe: (f) => prompts.tools.grep.description(placeOf(f)),
    parameters: type({
      pattern: type('string').atLeastLength(1).describe(prompts.tools.grep.params.pattern),
      'path?': type('string').describe(prompts.tools.grep.params.path),
      'glob?': type('string').describe(prompts.tools.grep.params.glob),
      'ignoreCase?': type('boolean').describe(prompts.tools.grep.params.ignoreCase),
      'context?': type('number').describe(prompts.tools.grep.params.context),
      'filesOnly?': type('boolean').describe(prompts.tools.grep.params.filesOnly),
    }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const target = host.workspace.resolveForRead(agent, args.path ?? '.')
      const context = Math.min(Math.max(0, args.context ?? 0), 5)
      const result = await natives.grep({
        pattern: args.pattern,
        path: target,
        ...(args.glob ? { glob: args.glob } : {}),
        ...(args.ignoreCase ? { ignoreCase: true } : {}),
        hidden: false,
        gitignore: true,
        maxCount: GREP_LIMIT,
        maxCountPerFile: 20,
        maxColumns: 300,
        timeoutMs: 20_000,
        ...(context ? { context } : {}),
        mode: args.filesOnly ? natives.GrepOutputMode.FilesWithMatches : natives.GrepOutputMode.Content,
      })
      const where = (p: string) => relative(root, resolve(target, p)) || p
      const matches = readableMatches(host, agent, target, result.matches)
      if (matches.length === 0) return `No matches for /${args.pattern}/ in ${relative(root, target) || '.'}.`
      const dropped = matches.length < result.matches.length
      const total = dropped ? matches.length : result.totalMatches
      const files = dropped ? new Set(matches.map((m) => m.path)).size : result.filesWithMatches
      const head = `${total} match${total === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}${total > matches.length ? ` (showing ${matches.length})` : ''}`
      if (args.filesOnly) return `${head}\n${matches.map((m) => where(m.path)).join('\n')}`
      const lines: string[] = [head]
      let file = ''
      for (const m of matches) {
        const p = where(m.path)
        if (p !== file) {
          lines.push(`\n${p}`)
          file = p
        }
        for (const c of m.contextBefore ?? []) lines.push(`  ${c.lineNumber}- ${c.line}`)
        lines.push(`  ${m.lineNumber}: ${m.line}`)
        for (const c of m.contextAfter ?? []) lines.push(`  ${c.lineNumber}- ${c.line}`)
      }
      return clip(lines.join('\n'))
    },
  },
  {
    name: 'glob',
    tier: 'read',
    description: prompts.tools.glob.description(PLACE),
    describe: (f) => prompts.tools.glob.description(placeOf(f)),
    parameters: type({
      pattern: type('string').atLeastLength(1).describe(prompts.tools.glob.params.pattern),
      'path?': type('string').describe(prompts.tools.glob.params.path),
    }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const target = host.workspace.resolveForRead(agent, args.path ?? '.')
      const result = await natives.glob({
        pattern: args.pattern,
        path: target,
        fileType: natives.FileType.File,
        gitignore: true,
        hidden: false,
        sortByMtime: true,
        maxResults: GLOB_LIMIT,
        timeoutMs: 20_000,
      })
      const matches = readableMatches(host, agent, target, result.matches)
      if (matches.length === 0) return `No files match ${args.pattern}.`
      return matches.map((m) => relative(root, resolve(target, m.path)) || m.path).join('\n')
    },
  },
  {
    name: 'find',
    tier: 'read',
    description: prompts.tools.find.description(PLACE),
    describe: (f) => prompts.tools.find.description(placeOf(f)),
    parameters: type({
      query: type('string').atLeastLength(1).describe(prompts.tools.find.params.query),
      'keywords?': type('string[]').describe(prompts.tools.find.params.keywords),
      'path?': type('string').describe(prompts.tools.find.params.path),
    }),
    async run(args, agent, host) {
      const target = host.workspace.resolveForRead(agent, args.path ?? '.')
      if (!existsSync(target)) throw new Error(`no such file or folder: ${args.path}`)
      const judge = host.judge?.(agent)
      const scope = {
        root: host.workspace.workdir(agent),
        target,
        isFile: statSync(target).isFile(),
        // A readable folder can hold what stays hidden (the person's keys in a home they opened).
        mayRead: (path: string) => host.workspace.mayRead(agent, path),
        ...(judge ? { judge } : {}),
      }
      return clip(await find(scope, { query: args.query, keywords: args.keywords ?? [] }))
    },
  },
  {
    name: 'ast_grep',
    tier: 'read',
    description: prompts.tools.ast_grep.description(PLACE),
    describe: (f) => prompts.tools.ast_grep.description(placeOf(f)),
    parameters: type({
      pattern: type('string').atLeastLength(1).describe(prompts.tools.ast_grep.params.pattern),
      'path?': type('string').describe(prompts.tools.ast_grep.params.path),
      'glob?': type('string').describe(prompts.tools.ast_grep.params.glob),
      'lang?': type('string').describe(prompts.tools.ast_grep.params.lang),
      'skip?': type('number').describe(prompts.tools.ast_grep.params.skip),
    }),
    async run(args, agent, host) {
      return astGrep(codeScope(host, agent, 'ast_grep', args), args)
    },
  },
  {
    name: 'ast_edit',
    tier: 'write',
    description: prompts.tools.ast_edit.description(PLACE),
    describe: (f) => prompts.tools.ast_edit.description(placeOf(f)),
    parameters: type({
      pattern: type('string').atLeastLength(1).describe(prompts.tools.ast_edit.params.pattern),
      rewrite: type('string').describe(prompts.tools.ast_edit.params.rewrite),
      'path?': type('string').describe(prompts.tools.ast_edit.params.path),
      'glob?': type('string').describe(prompts.tools.ast_edit.params.glob),
      'lang?': type('string').describe(prompts.tools.ast_edit.params.lang),
      'preview?': type('boolean').describe(prompts.tools.ast_edit.params.preview),
    }),
    async run(args, agent, host) {
      return astEdit(codeScope(host, agent, 'ast_edit', args), args)
    },
  },
  {
    name: 'lsp',
    tier: 'read',
    tierOf: (args) => (lspWrites(args) ? 'write' : 'read'),
    description: prompts.tools.lsp.description(PLACE),
    describe: (f) => prompts.tools.lsp.description(placeOf(f)),
    parameters: type({
      action: type.enumerated(...LSP_ACTIONS).describe(prompts.tools.lsp.params.action),
      'path?': type('string').describe(prompts.tools.lsp.params.path),
      'line?': type('number').describe(prompts.tools.lsp.params.line),
      'symbol?': type('string').describe(prompts.tools.lsp.params.symbol),
      'query?': type('string').describe(prompts.tools.lsp.params.query),
      'newName?': type('string').describe(prompts.tools.lsp.params.newName),
    }),
    async run(args, agent, host) {
      return lsp(codeScope(host, agent, 'lsp', args), args)
    },
  },
  {
    name: 'request_read',
    tier: 'read',
    description: prompts.tools.request_read.description(false),
    describe: (f) => prompts.tools.request_read.description(f.access.fullAccess),
    parameters: type({
      path: type('string').atLeastLength(1).describe(prompts.tools.request_read.params.path),
      'reason?': type('string').describe(prompts.tools.request_read.params.reason),
    }),
    async run(args, agent, host) {
      return host.requestRead(agent, args.path, args.reason)
    },
  },
  {
    name: 'web_search',
    tier: 'read',
    description: prompts.tools.web_search.description,
    parameters: type({
      query: type('string').atLeastLength(2).describe(prompts.tools.web_search.params.query),
      'limit?': type('number').describe(prompts.tools.web_search.params.limit),
      'recency?': type("'day' | 'week' | 'month' | 'year'").describe(prompts.tools.web_search.params.recency),
    }),
    async run(args, _agent, host) {
      const limit = Math.min(Math.max(1, args.limit ?? 6), 10)
      const text = await host.web.search(args.query, {
        limit,
        ...(args.recency ? { recency: args.recency } : {}),
      })
      const year = new Date().getFullYear()
      const stale = (args.query.match(/\b20\d\d\b/g) ?? []).map(Number).filter((y: number) => y < year)
      // Models search for the year their training ended; say so, once per such query.
      const note = stale.length ? prompts.toolResults.staleYear(stale, localDate()) : ''
      return { text: clip(text.trim() || `No results for "${args.query}".`), images: [], preface: note }
    },
  },
  {
    name: 'web_fetch',
    tier: 'read',
    description: prompts.tools.web_fetch.description(true),
    describe: (f) => prompts.tools.web_fetch.description(f.tools.names.includes('fs_read')),
    parameters: type({ url: type('string').describe(prompts.tools.web_fetch.params.url) }),
    async run(args, agent, host) {
      const page = await host.web.read(args.url, () => host.localPorts())
      const head = `Source: ${page.url} (${page.method}, ${page.contentType})`
      if (page.output.length <= PAGE_EXCERPT) return { text: page.output, images: [], preface: `${head}\n` }
      // Like Manus: keep context small and the rest recoverable. The full page goes to a scratch file the agent
      // can read or grep, and only an excerpt enters the conversation.
      const self = host.spec.agents.find((a) => a.name === agent)
      if (!self || !toolsFor(host.spec, self).includes('fs_read'))
        return { text: clip(page.output, FETCH_SHOWN_CHARS), images: [], preface: `${head}\n` }
      const name = `web/${pageFileName(page.url)}.md`
      const path = host.workspace.resolveInScratch(agent, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${head}\n\n${page.output}`)
      // In a project the shell starts in the project, so point at the scratch copy by its full path.
      const where = host.workspace.project ? path : name
      return {
        text: `${page.output.slice(0, PAGE_EXCERPT)}\n…`,
        images: [],
        preface: prompts.toolResults.savedPage(head, page.output.length, where),
      }
    },
  },
  {
    name: 'github',
    tier: 'read',
    tierOf: (args) => (githubWrites(args) ? 'write' : 'read'),
    description: prompts.tools.github.description,
    parameters: type({
      op: type.enumerated(...GITHUB_OPS).describe(prompts.tools.github.params.op),
      'repo?': type('string').describe(prompts.tools.github.params.repo),
      'issue?': type('string').describe(prompts.tools.github.params.issue),
      'pr?': type('string').describe(prompts.tools.github.params.pr),
      'run?': type('string').describe(prompts.tools.github.params.run),
      'branch?': type('string').describe(prompts.tools.github.params.branch),
      'state?': type("'open' | 'closed' | 'merged' | 'all'").describe(prompts.tools.github.params.state),
      'label?': type('string[]').describe(prompts.tools.github.params.label),
      'assignee?': type('string[]').describe(prompts.tools.github.params.assignee),
      'reviewer?': type('string[]').describe(prompts.tools.github.params.reviewer),
      'limit?': type('number').describe(prompts.tools.github.params.limit),
      'query?': type('string').describe(prompts.tools.github.params.query),
      'since?': type('string').describe(prompts.tools.github.params.since),
      'until?': type('string').describe(prompts.tools.github.params.until),
      'dateField?': type("'created' | 'updated'").describe(prompts.tools.github.params.dateField),
      'comments?': type('boolean').describe(prompts.tools.github.params.comments),
      'title?': type('string').describe(prompts.tools.github.params.title),
      'body?': type('string').describe(prompts.tools.github.params.body),
      'base?': type('string').describe(prompts.tools.github.params.base),
      'head?': type('string').describe(prompts.tools.github.params.head),
      'draft?': type('boolean').describe(prompts.tools.github.params.draft),
      'method?': type("'merge' | 'squash' | 'rebase'").describe(prompts.tools.github.params.method),
      'event?': type("'approve' | 'request_changes' | 'comment'").describe(prompts.tools.github.params.event),
      'reason?': type("'completed' | 'not planned'").describe(prompts.tools.github.params.reason),
      'failedOnly?': type('boolean').describe(prompts.tools.github.params.failedOnly),
      'tail?': type('number').describe(prompts.tools.github.params.tail),
    }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox) throw new Error(prompts.github.needsSandbox)
      const bin = ghBinary()
      if (!bin) throw new Error(prompts.github.missing)
      const write = githubWrites(args)
      let edited = false
      if (write) {
        // Anything that changes GitHub speaks for the person in public: no preset runs it unasked, only a rule
        // (perhaps one this card offers). The card shows the call with its text rewritable, so a comment or title
        // the person changes is what gets posted.
        const command = `gh ${posixLine(githubWriteCommand(args))}`
        const key = receiptKey(host, agent, 'github', args)
        edited = await askFirst(
          host,
          agent,
          'github',
          args,
          { tool: 'github', kind: 'command', command, readOnly: false, asks: true },
          key,
        )
      }
      const scope = githubScope(host, agent, bin, write)
      const out = write ? await runGithubWrite(scope, args) : await runGithub(scope, args)
      return `${clip(out)}${edited ? prompts.toolResults.editedByPerson : ''}`
    },
  },
  {
    name: 'escalate',
    tier: 'write',
    description: prompts.tools.escalate.description,
    parameters: type({
      to: type("'solo' | 'team'").describe(prompts.tools.escalate.params.to),
      reason: type('string').atLeastLength(1).describe(prompts.tools.escalate.params.reason),
    }),
    async run(args, agent, host) {
      return host.escalate(agent, args.to, args.reason)
    },
  },
  {
    name: 'reply_user',
    tier: 'write',
    description: prompts.tools.reply_user.description('always', false),
    describe: (f) =>
      prompts.tools.reply_user.description(f.review.setting, f.tools.names.includes('request_review')),
    parameters: type({
      text: type('string').atLeastLength(1).describe(prompts.tools.reply_user.params.text),
      'final?': type('boolean').describe(prompts.tools.reply_user.params.final),
    }),
    async run(args, agent, host) {
      if (host.spec.team?.mode === 'swarm' && host.spec.tier === 'team' && speaker(host.state()) !== agent)
        throw new Error(
          'only the peer holding task-final speaks to the person; record what you found as a note',
        )
      await host.append({
        type: 'chat/reply',
        actor: agentActor(agent),
        payload: { agent, text: args.text, final: args.final === true },
      })
      return args.final ? 'final answer sent to the user' : 'message sent to the user'
    },
  },
  {
    name: 'reply_person',
    tier: 'write',
    description: prompts.tools.reply_person.description,
    parameters: type({
      text: type('string').atLeastLength(1).describe(prompts.tools.reply_person.params.text),
      'final?': type('boolean').describe(prompts.tools.reply_person.params.final),
    }),
    async run(args, agent, host) {
      const s = host.state()
      const from = s.rounds.at(-1)?.startSeq ?? 0
      // The person opened this round by writing to this agent: its answer is the round's answer.
      const opened = host.spec.chat?.addressed?.includes(agent) ?? false
      const asked =
        opened || s.chatMessages.some((m) => m.from === 'user' && m.seq >= from && m.to?.includes(agent))
      if (!asked) throw new Error(prompts.toolResults.notAddressed)
      const final = opened && args.final !== false
      await host.append({
        type: 'chat/reply',
        actor: agentActor(agent),
        payload: { agent, text: args.text, final },
      })
      return final ? prompts.toolResults.answeredPerson : 'message sent to the person'
    },
  },
  {
    name: 'remember',
    tier: 'write',
    description: prompts.tools.remember.description,
    parameters: type({
      text: type('string').atLeastLength(3).atMostLength(400).describe(prompts.tools.remember.params.text),
      kind: type("'preference' | 'decision' | 'lesson' | 'fact'").describe(
        prompts.tools.remember.params.kind,
      ),
      scope: type("'everywhere' | 'project'").describe(prompts.tools.remember.params.scope),
      why: type('string').describe(prompts.tools.remember.params.why),
      'replaces?': type('string').array().atMostLength(10).describe(prompts.tools.remember.params.replaces),
    }),
    async run(args, agent, host) {
      return host.proposeMemory(agent, args)
    },
  },
  {
    name: 'recall',
    tier: 'read',
    description: prompts.tools.recall.description,
    parameters: type({
      query: type('string').describe(prompts.tools.recall.params.query),
    }),
    async run(args, _agent, host) {
      return host.recallMemory(args.query)
    },
  },
  {
    name: 'check_in',
    tier: 'write',
    description: prompts.tools.check_in.description,
    parameters: type({
      question: type('string').atLeastLength(3).describe(prompts.tools.check_in.params.question),
      assumption: type('string').atLeastLength(3).describe(prompts.tools.check_in.params.assumption),
    }),
    async run(args, agent, host) {
      if (host.spec.team?.mode === 'swarm' && host.spec.tier === 'team' && speaker(host.state()) !== agent)
        throw new Error(
          'only the peer holding task-final speaks to the person; record the question as a note',
        )
      await host.append({
        type: 'chat/reply',
        actor: agentActor(agent),
        payload: { agent, text: args.question, final: false, assumption: args.assumption },
      })
      return prompts.toolResults.checkIn
    },
  },
  {
    name: 'ask_user',
    tier: 'write',
    description: prompts.tools.ask_user.description,
    parameters: type({
      question: type('string').atLeastLength(3).describe(prompts.tools.ask_user.params.question),
      'questions?': type({
        question: type('string').atLeastLength(3).describe(prompts.tools.ask_user.params.q_question),
        'header?': type('string').atMostLength(20).describe(prompts.tools.ask_user.params.q_header),
        options: type({
          label: type('string').atLeastLength(1).describe(prompts.tools.ask_user.params.q_label),
          'description?': type('string').describe(prompts.tools.ask_user.params.q_description),
        })
          .array()
          .atLeastLength(2)
          .atMostLength(4)
          .describe(prompts.tools.ask_user.params.q_options),
        'multiSelect?': type('boolean').describe(prompts.tools.ask_user.params.q_multiSelect),
      })
        .array()
        .atMostLength(4)
        .describe(prompts.tools.ask_user.params.questions),
      'plan?': type('string').atLeastLength(3).describe(prompts.tools.ask_user.params.plan),
    }),
    async run(args, agent, host) {
      const last = host.state().chatMessages.at(-1)
      if (last?.question) throw new Error('a question to the person is already open; wait for the answer')
      await host.append({
        type: 'chat/reply',
        actor: agentActor(agent),
        payload: {
          agent,
          text: args.question,
          final: false,
          question: true,
          ...(args.questions?.length ? { choices: args.questions } : {}),
          ...(args.plan ? { plan: args.plan } : {}),
        },
      })
      return prompts.toolResults.asked
    },
  },
  {
    name: 'create_plugin',
    tier: 'write',
    description: prompts.tools.create_plugin.description,
    parameters: type({
      name: type('string').describe(prompts.tools.create_plugin.params.name),
      description: type('string').atLeastLength(5).describe(prompts.tools.create_plugin.params.description),
      files: type('Record<string, string>').describe(prompts.tools.create_plugin.params.files),
    }),
    async run(args, _agent, host) {
      const plugins = host.plugins
      if (!plugins) throw new Error('plugins are not set up in this run')
      const p = writeDraft(plugins.store, host.id, args)
      return `draft ${p.name} written (switched off): ${Object.keys(args.files).length} file(s). Now test_plugin.`
    },
  },
  {
    name: 'test_plugin',
    tier: 'write',
    description: prompts.tools.test_plugin.description,
    parameters: type({
      name: type('string').describe(prompts.tools.test_plugin.params.name),
      'tests?': type({
        tool: type('string').describe(prompts.tools.test_plugin.params.t_tool),
        'args?': type('Record<string, unknown>').describe(prompts.tools.test_plugin.params.t_args),
      })
        .array()
        .describe(prompts.tools.test_plugin.params.tests),
    }),
    async run(args, agent, host) {
      const plugins = host.plugins
      if (!plugins) throw new Error('plugins are not set up in this run')
      if (!isOwnDraft(plugins.store, host.id, args.name))
        throw new Error(`${args.name} is not a draft this round made; create_plugin first`)
      const plugin = plugins.store.list().find((p) => p.name === args.name)
      if (!plugin) throw new Error(`no plugin called ${args.name}`)
      return testPlugin(plugin, {
        sandbox: host.sandbox,
        scratch: host.workspace.scratch(agent),
        tests: (args.tests ?? []).map((t: { tool: string; args?: Record<string, unknown> }) => ({
          tool: t.tool,
          args: t.args ?? {},
        })),
        allowUnsandboxed: host.unsafeNoSandbox,
        confinement: host.workspace.confinement(),
      })
    },
  },
  {
    name: 'propose_plugin',
    tier: 'write',
    description: prompts.tools.propose_plugin.description,
    parameters: type({
      name: type('string').describe(prompts.tools.propose_plugin.params.name),
      summary: type('string').atLeastLength(10).describe(prompts.tools.propose_plugin.params.summary),
    }),
    async run(args, agent, host) {
      const plugins = host.plugins
      if (!plugins) throw new Error('plugins are not set up in this run')
      if (!isOwnDraft(plugins.store, host.id, args.name))
        throw new Error(`${args.name} is not a draft this round made; create_plugin first`)
      const p = plugins.store.list().find((x) => x.name === args.name)
      if (!p) throw new Error(`no plugin called ${args.name}`)
      const adds = [
        p.skills.length && `skills: ${p.skills.join(', ')}`,
        p.commands.length && `commands: ${p.commands.map((c) => `/${c.name}`).join(', ')}`,
        p.hooks && `${p.hooks} hook(s)`,
        p.mcpServers.length && `MCP servers: ${p.mcpServers.join(', ')}`,
        p.server && 'code that runs in Myrmidon',
        p.ui && 'UI',
      ].filter(Boolean)
      const approved = await host.requestApproval(
        agent,
        'propose_plugin',
        `Switch on the ${p.name} plugin? ${args.summary} It adds ${adds.join('; ')}. Its files are in ${p.dir}.`,
      )
      if (!approved) return `the person did not switch on ${p.name}; ask what to change, or leave it off`
      adoptDraft(plugins.store, p.name)
      await plugins.sync()
      return `${p.name} is on. Its tools and prompt sections reach agents from the next message; tell the person how to use it.`
    },
  },
  {
    name: 'propose',
    tier: 'write',
    description: prompts.tools.propose.description,
    parameters: type({
      kind: type("'file' | 'commit'").describe(prompts.tools.propose.params.kind),
      why: type('string').atLeastLength(1).describe(prompts.tools.propose.params.why),
      'path?': type('string').describe(prompts.tools.propose.params.path),
      'content?': type('string').describe(prompts.tools.propose.params.content),
      'message?': type('string').describe(prompts.tools.propose.params.message),
    }),
    async run(args, agent, host) {
      const project = host.spec.chat?.project
      if (!project) throw new Error(prompts.toolResults.proposeNoProject)
      const key = receiptKey(host, agent, 'propose', args)
      if (args.kind === 'file') {
        if (!args.path || args.content === undefined)
          throw new Error('a file proposal needs path and content')
        const path = resolve(project.path, args.path)
        if (!path.startsWith(`${project.path}/`)) throw new Error(`${args.path} is outside ${project.name}`)
        const where = relative(project.path, path)
        const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
        const title = existsSync(path) ? prompts.reviewCard.edit(where) : prompts.reviewCard.write(where)
        // A proposed file is a file change like any other, so a rule allowing file changes covers it.
        const call: PermissionCall = { tool: 'propose', kind: 'proposal', edits: true, readOnly: false }
        const verdict = host.permit(agent, call)
        if (verdict.decision === 'deny') throw denied(`writing ${where}`, verdict)
        const decision =
          verdict.decision === 'allow'
            ? { approved: true as const }
            : await host.reviewChange(agent, 'propose', args.why, {
                review: fileReview(title, where, { before, after: args.content }),
                key,
                permission: { call, verdict },
              })
        if (!decision.approved) return prompts.toolResults.declined(`writing ${where}`, decision.note)
        const content = decision.edits?.content ?? args.content
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
        return `wrote ${where}${decision.edits?.content !== undefined ? prompts.toolResults.editedByPerson : ''}`
      }
      if (!args.message?.trim()) throw new Error('a commit proposal needs message')
      const changes = await gitWorkingChanges(project.path).catch(() => undefined)
      if (!changes) throw new Error(`${project.name} is not a git repository`)
      if (changes.files.length === 0) throw new Error('there is nothing to commit')
      const call: PermissionCall = { tool: 'propose', kind: 'proposal', readOnly: false }
      const verdict = host.permit(agent, call)
      if (verdict.decision === 'deny') throw denied('this commit', verdict)
      const decision: ReviewDecision =
        verdict.decision === 'allow'
          ? { approved: true }
          : await host.reviewChange(agent, 'propose', args.why, {
              permission: { call, verdict },
              review: {
                kind: 'commit',
                title: prompts.reviewCard.commit(project.name),
                fields: [
                  {
                    key: 'message',
                    label: prompts.reviewCard.message,
                    format: 'text',
                    ...reviewText(args.message),
                  },
                  {
                    key: 'patch',
                    label: prompts.reviewCard.changes(changes.files.length),
                    value: changes.patch,
                    format: 'patch',
                    editable: false,
                  },
                ],
              },
              key,
            })
      if (!decision.approved) return prompts.toolResults.declined('this commit', decision.note)
      const message = decision.edits?.message ?? args.message
      const hash = await gitCommitChanges(project.path, message, true)
      return `committed ${hash}: ${message.split('\n')[0]}${decision.edits?.message !== undefined ? prompts.toolResults.editedByPerson : ''}`
    },
  },
  {
    name: 'read_docs',
    tier: 'read',
    description: prompts.tools.read_docs.description,
    parameters: type({
      'page?': type('string').describe(prompts.tools.read_docs.params.page),
    }),
    async run(args, agent, host) {
      const page = args.page?.replace(/\.md$/, '').trim()
      if (!page)
        return `Harness docs (read_docs with page):\n${[...Object.keys(DOCS), 'tools'].map((p) => `- ${p}`).join('\n')}`
      if (page === 'tools') {
        const mine = new Set(toolsAllowed(host, agent))
        return TOOL_DEFS.map(
          (d) => `- ${d.name}${mine.has(d.name) ? '' : ' (not available to you)'}: ${d.description}`,
        ).join('\n')
      }
      const doc = DOCS[page]
      if (!doc) throw new Error(`no doc "${page}"; pages: ${[...Object.keys(DOCS), 'tools'].join(', ')}`)
      return doc
    },
  },
  {
    name: 'ask_crewmate',
    tier: 'write',
    description: prompts.tools.ask_crewmate.description(prompts.system.brief),
    parameters: type({
      to: type('string').atLeastLength(1).describe(prompts.tools.ask_crewmate.params.to),
      job: type('string').atLeastLength(10).describe(prompts.tools.ask_crewmate.params.job),
    }),
    async run(args, agent, host) {
      return host.askCrewmate(agent, args.to, args.job)
    },
  },
  {
    name: 'add_crewmate',
    tier: 'write',
    description: prompts.tools.add_crewmate.description,
    parameters: type({
      'role?': type('string').atMostLength(40).describe(prompts.tools.add_crewmate.params.role),
      focus: type('string').atLeastLength(10).describe(prompts.tools.add_crewmate.params.focus),
      'model?': type('string').describe(prompts.tools.add_crewmate.params.model),
      'specialist?': type('string').describe(prompts.tools.add_crewmate.params.specialist),
    }),
    async run(args, agent, host) {
      if (!args.specialist && (args.role?.trim().length ?? 0) < 2)
        throw new Error("give the new crewmate a role, or bring in one of the person's specialists by name")
      return host.spawnWorker(agent, args.role?.trim() ?? '', args.focus, args.model, args.specialist)
    },
  },
  {
    name: 'dismiss_crewmate',
    tier: 'write',
    description: prompts.tools.dismiss_crewmate.description,
    parameters: type({
      name: type('string').describe(prompts.tools.dismiss_crewmate.params.name),
      reason: type('string').atLeastLength(3).describe(prompts.tools.dismiss_crewmate.params.reason),
    }),
    async run(args, agent, host) {
      return host.dismissWorker(agent, args.name, args.reason)
    },
  },
  {
    name: 'update_todo',
    tier: 'write',
    description: prompts.tools.update_todo.description,
    parameters: type({
      items: type({
        text: type('string').atLeastLength(1).describe(prompts.tools.update_todo.params.i_text),
        'done?': type('boolean').describe(prompts.tools.update_todo.params.i_done),
      })
        .array()
        .describe(prompts.tools.update_todo.params.items),
    }),
    async run(args, agent, host) {
      const items = (args.items as { text: string; done?: boolean }[]).map((i) => ({
        text: i.text,
        done: i.done === true,
      }))
      host.setTodos(agent, items)
      const done = items.filter((i) => i.done).length
      return `Todo (${done}/${items.length} done):\n${items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')}`
    },
  },
  {
    name: 'browser_open',
    tier: 'write',
    description: prompts.tools.browser_open.description,
    parameters: type({ url: type('string').describe(prompts.tools.browser_open.params.url) }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const target = args.url.startsWith('artifact:') ? artifactUrl(host, args.url.slice(9)) : args.url
      if (!/^https?:/.test(target)) throw new Error('url must be http(s) or artifact:<name>')
      await navigate(tab, tab.page, target)
      await tab.page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => {})
      await keyframe(host, agent, tab, 'open')
      return pageSnapshot(tab)
    },
  },
  {
    name: 'request_login',
    tier: 'write',
    description: prompts.tools.request_login.description,
    parameters: type({
      url: type('string').describe(prompts.tools.request_login.params.url),
      site: type('string').describe(prompts.tools.request_login.params.site),
      reason: type('string').describe(prompts.tools.request_login.params.reason),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      if (!/^https?:/.test(args.url)) throw new Error('url must be http(s)')
      await navigate(tab, tab.page, args.url)
      await keyframe(host, agent, tab, 'open')
      const outcome = await host.requestLogin(agent, args.site, args.url, args.reason)
      if (outcome !== 'handed-back')
        throw new Error(
          outcome === 'timeout'
            ? `the person did not sign in to ${args.site} in time; continue without it or say what is blocked`
            : 'the round stopped',
        )
      const after = await browserTab(host, agent)
      return prompts.toolResults.signedIn(args.site, await pageSnapshot(after))
    },
  },
  {
    name: 'browser_tabs',
    tier: 'write',
    description: prompts.tools.browser_tabs.description,
    parameters: type({
      'open?': type('string').describe(prompts.tools.browser_tabs.params.open),
      'switch?': type('number').describe(prompts.tools.browser_tabs.params.switch),
      'close?': type('number').describe(prompts.tools.browser_tabs.params.close),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      let changed = false
      if (args.close !== undefined) {
        const page = tab.pages[args.close - 1]
        if (!page) throw new Error(`no tab ${args.close}`)
        if (tab.pages.length === 1) throw new Error('that is your only tab; open another first')
        await page.close()
        changed = true
      }
      if (args.open !== undefined) {
        const target = args.open.startsWith('artifact:') ? artifactUrl(host, args.open.slice(9)) : args.open
        if (!/^https?:/.test(target)) throw new Error('open must be an http(s) URL or artifact:<name>')
        const page = await openPage(tab)
        await navigate(tab, page, target)
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => {})
        changed = true
      }
      if (args.switch !== undefined) {
        const page = tab.pages[args.switch - 1]
        if (!page) throw new Error(`no tab ${args.switch}`)
        await switchPage(tab, page)
        changed = true
      }
      const list = await Promise.all(
        tab.pages.map(
          async (p, i) =>
            `${p === tab.page ? '*' : ' '} ${i + 1}. ${(await p.title().catch(() => '')) || '(untitled)'} — ${p.url()}`,
        ),
      )
      if (changed) await keyframe(host, agent, tab, 'open')
      return `Tabs:\n${list.join('\n')}${changed ? `\n\n${await pageSnapshot(tab)}` : ''}`
    },
  },
  {
    name: 'browser_extract',
    tier: 'read',
    description: prompts.tools.browser_extract.description,
    parameters: type({
      what: type("'tables' | 'links' | 'items'").describe(prompts.tools.browser_extract.params.what),
      'selector?': type('string').describe(prompts.tools.browser_extract.params.selector),
      'fields?': type('string').describe(prompts.tools.browser_extract.params.fields),
      'limit?': type('number').describe(prompts.tools.browser_extract.params.limit),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const limit = Math.min(Math.max(1, args.limit ?? 200), 2000)
      let fields: Record<string, string> = {}
      if (args.what === 'items') {
        if (!args.selector) throw new Error('items needs a selector for the repeating element')
        try {
          fields = JSON.parse(args.fields ?? '{}') as Record<string, string>
        } catch {
          throw new Error('fields must be a JSON object, e.g. {"name": "h2", "url": "a@href"}')
        }
        if (Object.keys(fields).length === 0) throw new Error('items needs fields to extract')
      }
      const data = await extractFromPage(tab.page, args.what, args.selector ?? '', fields, limit)
      const json = JSON.stringify(data, null, 2)
      const count = Array.isArray(data) ? data.length : 0
      const head = `${count} ${args.what === 'tables' ? `table${count === 1 ? '' : 's'}` : args.what === 'links' ? 'links' : 'items'} from ${tab.page.url()}`
      if (count === 0) return prompts.toolResults.nothingExtracted(head)
      if (json.length <= PAGE_EXCERPT) return `${head}:\n${json}`
      const name = `extract/${pageFileName(tab.page.url())}-${args.what}.json`
      const path = host.workspace.resolveInScratch(agent, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, json)
      const where = host.workspace.project ? path : name
      return `${head} (${json.length} chars; all of it is saved as ${where}):\n${json.slice(0, PAGE_EXCERPT)}\n…`
    },
  },
  {
    name: 'browser_network',
    tier: 'read',
    description: prompts.tools.browser_network.description,
    parameters: type({
      'only?': type("'failed' | 'api'").describe(prompts.tools.browser_network.params.only),
      'body?': type('number').describe(prompts.tools.browser_network.params.body),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      if (args.body !== undefined) {
        const entry = tab.network.find((n) => n.id === args.body)
        if (!entry) throw new Error(`no request #${args.body} in the recent log`)
        if (!entry.response)
          throw new Error(`#${args.body} is not an API (xhr/fetch) response; its body is not kept`)
        const body = await entry.response.text().catch(() => '(the body is no longer available)')
        return `#${entry.id} ${entry.method} ${entry.url} → ${entry.status}\n${clip(body, 16_000)}`
      }
      const list = tab.network.filter((n) =>
        args.only === 'failed'
          ? n.failure !== undefined || (n.status ?? 0) >= 400
          : args.only === 'api'
            ? n.type === 'xhr' || n.type === 'fetch'
            : true,
      )
      if (list.length === 0) return `No ${args.only ?? ''} requests recorded yet.`.replace('  ', ' ')
      return list
        .slice(-60)
        .map(
          (n) =>
            `#${n.id} ${n.method} ${[n.status, n.failure && `FAILED (${n.failure})`].filter(Boolean).join(' ') || '…'} ${n.type} ${n.ms}ms ${n.url.length > 160 ? `${n.url.slice(0, 160)}…` : n.url}`,
        )
        .join('\n')
    },
  },
  {
    name: 'browser_downloads',
    tier: 'read',
    description: prompts.tools.browser_downloads.description({ read: true, shell: true, publish: true }),
    describe: (f) =>
      prompts.tools.browser_downloads.description({
        read: f.tools.names.includes('fs_read'),
        shell: f.tools.names.includes('shell'),
        publish: f.tools.names.includes('publish_artifact'),
      }),
    parameters: type({}),
    async run(_args, agent, host) {
      const dir = join(host.workspace.scratch(agent), 'downloads')
      const files = (() => {
        try {
          return readdirSync(dir).filter((f) => !f.endsWith('.crdownload'))
        } catch {
          return []
        }
      })()
      if (files.length === 0) return prompts.toolResults.noDownloads
      return files.map((f) => `downloads/${f} (${statSync(join(dir, f)).size} bytes)`).join('\n')
    },
  },
  {
    name: 'browser_upload',
    tier: 'write',
    description: prompts.tools.browser_upload.description,
    parameters: type({
      ref: type('string').describe(prompts.tools.browser_upload.params.ref),
      path: type('string').describe(prompts.tools.browser_upload.params.path),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const file = host.workspace.resolveInWorkdir(agent, args.path)
      if (!existsSync(file)) throw new Error(`no such file: ${args.path}`)
      const handle = await pageElement(tab, args.ref)
      const isFile = await handle.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')
      if (!isFile)
        throw new Error(`${args.ref} is not a file input; pick the element whose role says file upload`)
      await (handle as unknown as { uploadFile(...paths: string[]): Promise<void> }).uploadFile(file)
      await keyframe(host, agent, tab, 'type', refLabel(tab, args.ref))
      return `Chose ${args.path} for ${args.ref}.\n${await pageSnapshot(tab)}`
    },
  },
  {
    name: 'browser_snapshot',
    tier: 'read',
    description: prompts.tools.browser_snapshot.description,
    parameters: type({}),
    async run(_args, agent, host) {
      return pageSnapshot(await browserTab(host, agent))
    },
  },
  {
    name: 'browser_click',
    tier: 'write',
    description: prompts.tools.browser_click.description,
    parameters: type({ ref: type('string').describe(prompts.tools.browser_click.params.ref) }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const handle = await pageElement(tab, args.ref)
      const label = refLabel(tab, args.ref)
      const box = await handle.boundingBox()
      const at = await pointAt(tab, handle, 'click', label)
      await tab.page.mouse.click(at.x, at.y)
      doneWith(tab)
      await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 4_000 }).catch(() => {})
      await keyframe(host, agent, tab, 'click', label, box)
      return pageSnapshot(tab)
    },
  },
  {
    name: 'browser_type',
    tier: 'write',
    description: prompts.tools.browser_type.description,
    parameters: type({
      ref: type('string').describe(prompts.tools.browser_type.params.ref),
      text: type('string').describe(prompts.tools.browser_type.params.text),
      'submit?': type('boolean').describe(prompts.tools.browser_type.params.submit),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const field = await pageElement(tab, args.ref)
      const at = await pointAt(tab, field, 'type', refLabel(tab, args.ref))
      await tab.page.mouse.click(at.x, at.y, { count: 3 })
      // Typed key by key while someone watches, so they can follow it.
      await field.type(args.text, { delay: watched(tab) ? 35 : 0 })
      const box = await field.boundingBox().catch(() => null)
      doneWith(tab)
      if (args.submit) await field.press('Enter')
      await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 4_000 }).catch(() => {})
      await keyframe(host, agent, tab, 'type', `${refLabel(tab, args.ref)} ← ${args.text.slice(0, 40)}`, box)
      return pageSnapshot(tab)
    },
  },
  {
    name: 'browser_press',
    tier: 'write',
    description: prompts.tools.browser_press.description,
    parameters: type({ key: type('string').describe(prompts.tools.browser_press.params.key) }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      await tab.page.keyboard.press(args.key as never)
      await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 3_000 }).catch(() => {})
      await keyframe(host, agent, tab, 'press', args.key)
      return pageSnapshot(tab)
    },
  },
  {
    name: 'browser_screenshot',
    tier: 'read',
    description: prompts.tools.browser_screenshot.description,
    parameters: type({
      'fullPage?': type('boolean').describe(prompts.tools.browser_screenshot.params.fullPage),
    }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const data = (await tab.page.screenshot({
        type: 'png',
        fullPage: args.fullPage ?? false,
        encoding: 'base64',
      })) as string
      return { text: `screenshot of ${tab.page.url()}`, images: [{ data, mimeType: 'image/png' }] }
    },
  },
  {
    name: 'browser_console',
    tier: 'read',
    description: prompts.tools.browser_console.description,
    parameters: type({}),
    async run(_args, agent, host) {
      const tab = await browserTab(host, agent)
      const lines = tab.logs.splice(0)
      return lines.length ? lines.join('\n') : '(no console output, errors, or failed requests)'
    },
  },
  {
    name: 'browser_eval',
    tier: 'write',
    description: prompts.tools.browser_eval.description,
    parameters: type({ expression: type('string').describe(prompts.tools.browser_eval.params.expression) }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const value = await tab.page.evaluate(`(async () => (${args.expression}))()`)
      return clip(JSON.stringify(value, null, 2) ?? 'undefined')
    },
  },
  {
    name: 'start_server',
    tier: 'exec',
    description: prompts.tools.start_server.description(false),
    describe: (f) => prompts.tools.start_server.description(f.access.fullAccess),
    parameters: type({
      command: type('string').atLeastLength(1).describe(prompts.tools.start_server.params.command),
      'name?': type('string').describe(prompts.tools.start_server.params.name),
      'port?': type('number').describe(prompts.tools.start_server.params.port),
    }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('servers need the OS sandbox')
      const name = (args.name ?? 'dev').trim()
      if (!/^[a-z0-9][a-z0-9-]{0,20}$/i.test(name))
        throw new Error('name: letters, digits and dashes, up to 21')
      if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535))
        throw new Error('port must be between 1024 and 65535')
      const command = await guardProjectCommand(host, agent, 'start_server', args.command, true)
      const url = await host.startServer(agent, name, command, args.port)
      return prompts.toolResults.serving(name, url)
    },
  },
  {
    name: 'server_logs',
    tier: 'read',
    description: prompts.tools.server_logs.description,
    parameters: type({ 'name?': type('string').describe(prompts.tools.server_logs.params.name) }),
    async run(args, _agent, host) {
      const out = host.serverLogs((args.name ?? 'dev').trim())
      return clip(out.trim().split('\n').slice(-200).join('\n') || '(no output yet)')
    },
  },
  {
    name: 'stop_server',
    tier: 'exec',
    description: prompts.tools.stop_server.description,
    parameters: type({ 'name?': type('string').describe(prompts.tools.stop_server.params.name) }),
    async run(args, agent, host) {
      const name = (args.name ?? 'dev').trim()
      await host.stopServer(name, `stopped by ${agent}`)
      return `stopped ${name}`
    },
  },
  {
    name: 'run_checks',
    tier: 'exec',
    description: prompts.tools.run_checks.description(false),
    describe: (f) => prompts.tools.run_checks.description(f.access.fullAccess),
    parameters: type({ 'only?': type('string').describe(prompts.tools.run_checks.params.only) }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('run_checks needs the OS sandbox')
      const cwd = host.workspace.workdir(agent)
      // A project's checks are read once when the round starts; a scratch folder's change as the agent works.
      const all = host.project?.checks ?? scratchChecks(cwd)
      const picked = pickChecks(all, args.only)
      if (picked.length === 0)
        throw new Error(
          args.only
            ? prompts.toolResults.noSuchCheck(
                args.only,
                all.map((c) => c.name),
                host.project !== undefined,
              )
            : prompts.toolResults.noChecks(host.project !== undefined),
        )
      // The checks are commands, decided as shell's are (the preset, command rules).
      await guardProjectCommand(host, agent, 'run_checks', picked.map((c) => c.command).join(' && '))
      return clip((await runProjectChecks(host, cwd, writableFor(host, agent), picked)).report)
    },
  },
  {
    name: 'create_tool',
    tier: 'exec',
    description: prompts.tools.create_tool.description(MADE_PREFIX, false),
    describe: (f) => prompts.tools.create_tool.description(MADE_PREFIX, f.access.fullAccess),
    parameters: type({
      name: type('string').describe(prompts.tools.create_tool.params.name),
      description: type('string').describe(prompts.tools.create_tool.params.description),
      inputs: type({
        name: type('string').describe(prompts.tools.create_tool.params.inputName),
        type: type('string').describe(prompts.tools.create_tool.params.inputType),
        'description?': type('string').describe(prompts.tools.create_tool.params.inputDescription),
        'optional?': type('boolean').describe(prompts.tools.create_tool.params.inputOptional),
      })
        .array()
        .describe(prompts.tools.create_tool.params.inputs),
      language: type('string').describe(prompts.tools.create_tool.params.language),
      source: type('string').describe(prompts.tools.create_tool.params.source),
      test: type('string').describe(prompts.tools.create_tool.params.test),
    }),
    async run(args, agent, host) {
      const tool = checkedTool(args)
      if (tool.language === 'browser' && !host.browser)
        throw new Error('no browser here: Chrome is not installed')
      const existing = host.state().madeTools[tool.name]
      if (existing?.library)
        throw new Error(`a library tool is already called ${tool.name}; pick another name`)
      if (existing && existing.agent !== agent)
        throw new Error(
          `${existing.agent} already made ${MADE_PREFIX}${tool.name}; use it or pick another name`,
        )
      let sample: unknown
      try {
        sample = JSON.parse(args.test)
      } catch {
        throw new Error('test must be a JSON object of example inputs')
      }
      const r = await runMadeTool(tool, checkedArgs(tool.inputs, sample), agent, host)
      if (!r.ok)
        throw new Error(
          `the tool failed its test run, so it was not created. Fix it and try again.\n${r.output}`,
        )
      await host.append({
        type: 'tool/created',
        actor: agentActor(agent),
        payload: { agent, ...tool },
      })
      host.toolsChanged({ by: agent, tool: `${MADE_PREFIX}${tool.name}` })
      return prompts.toolResults.toolCreated(`${MADE_PREFIX}${tool.name}`, r.output)
    },
  },
  {
    name: 'shell',
    tier: 'exec',
    description: prompts.tools.shell.description(false),
    describe: (f) => prompts.tools.shell.description(f.access.fullAccess),
    parameters: type({
      command: type('string').describe(prompts.tools.shell.params.command),
      'timeoutSeconds?': type('number').describe(prompts.tools.shell.params.timeoutSeconds),
    }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('shell is disabled: no OS sandbox')
      const cwd = host.workspace.workdir(agent)
      const command = await guardProjectCommand(host, agent, 'shell', args.command, true)
      const r = await host.sandbox.run({
        command,
        cwd,
        writable: writableFor(host, agent),
        ...host.workspace.confinement(),
        timeoutMs: Math.min(Math.max(1, args.timeoutSeconds ?? 60), 300) * 1000,
        env: { MYR_MIRROR: host.workspace.mirrorRoot },
      })
      const status = r.timedOut ? 'TIMED OUT' : `exit ${r.code}`
      return clip(`${status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`)
    },
  },
  {
    name: 'eval',
    tier: 'exec',
    description: prompts.tools.eval.description(false, RUNTIMES.includes('python3')),
    describe: (f) => prompts.tools.eval.description(f.access.fullAccess, RUNTIMES.includes('python3')),
    parameters: type({
      language: type.enumerated(...CELL_LANGUAGES).describe(prompts.tools.eval.params.language),
      code: type('string').atLeastLength(1).describe(prompts.tools.eval.params.code),
      'timeoutSeconds?': type('number').describe(prompts.tools.eval.params.timeoutSeconds),
      'reset?': type('boolean').describe(prompts.tools.eval.params.reset),
    }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox) throw new Error(prompts.cells.needsSandbox)
      const scope = cellScope(host, agent)
      // Said before the person is asked about code that could not run anyway.
      if (args.language === 'py' && !scope.python()) throw new Error(prompts.cells.noPython)
      // A cell can do what a command can, in the same sandbox, so it is decided as one; the person may rewrite it.
      const code = await guardProjectCommand(host, agent, 'eval', args.code, true)
      const r = await cellKernels.run(scope, { ...args, code })
      if (!r.ok) throw new Error(clip(r.text))
      return r.images.length ? { text: clip(r.text), images: r.images } : clip(r.text)
    },
  },
]

export function describeCheck(c: ColonyHost['spec']['acceptance'][number]): string {
  switch (c.verifier) {
    case 'checks':
      return `checks: ${c.rules.map((r) => `${r.artifact}${r.contains ? ` contains "${r.contains}"` : ' exists'}`).join('; ')}`
    case 'command':
      return `command: \`${c.run}\` against ${c.against.join(', ') || 'all artifacts'} must exit 0`
    case 'llm-judge':
      return `llm-judge (${c.model}) scores ≥ ${c.threshold} on rubric: ${c.rubric.slice(0, 300)}`
  }
}

const firstLine = (text: string, max: number) => {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * The colony log as one entry per thing an agent did, oldest first, for read_log. A tool call shows what it returned,
 * up to READ_LOG_RESULT_CHARS, so a claim ("tests pass") can be checked against the output; entries are numbered by
 * their place in the log, and logEntry shows one in full.
 */
export function logLines(events: readonly MyrEvent[], filter: { agent?: string; tool?: string }): string[] {
  const calls = new Map<string, { line: number; seq: number }>()
  const out: string[] = []
  const keep = (agent: string, tool?: string) =>
    (!filter.agent || agent === filter.agent) && (!filter.tool || (tool ?? '').includes(filter.tool))
  for (const e of events) {
    const head = `#${e.seq} ${clockTime(e.time)}`
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      if (!keep(p.agent, p.tool)) continue
      calls.set(`${p.agent}/${p.callId}`, { line: out.length, seq: e.seq })
      out.push(`${head} ${p.agent} ${p.tool}(${firstLine(JSON.stringify(p.args ?? {}), 160)}) → …`)
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const call = calls.get(`${p.agent}/${p.callId}`)
      if (call === undefined) continue
      out[call.line] =
        `${out[call.line]?.slice(0, -1)}${p.ok ? 'ok' : 'FAILED'}${resultExcerpt(p.output, call.seq)}`
    } else if (filter.tool) {
    } else if (e.type === 'task/changed') {
      const p = e.payload as EventPayloads['task/changed']
      if (keep(p.by))
        out.push(
          `${head} ${p.by} ${p.task.id} → ${p.task.status}${p.reason ? ` (${firstLine(p.reason, 120)})` : ''}`,
        )
    } else if (e.type === 'chat/reply') {
      const p = e.payload as EventPayloads['chat/reply']
      if (keep(p.agent)) out.push(`${head} ${p.agent} told the person: ${firstLine(p.text, 160)}`)
    } else if (e.type === 'worktree/merged' || e.type === 'worktree/conflict') {
      const p = e.payload as EventPayloads['worktree/merged']
      if (keep(p.agent))
        out.push(
          `${head} ${p.agent} ${e.type === 'worktree/merged' ? 'merged' : 'conflicted on'} ${p.files.join(', ')}`,
        )
    }
  }
  return out
}

/** A tool result under its call in read_log: indented, cut at READ_LOG_RESULT_CHARS with a pointer to the rest. */
function resultExcerpt(output: string, seq: number): string {
  const text = output.trim()
  if (!text) return ' (no output)'
  const shown = text.slice(0, READ_LOG_RESULT_CHARS)
  const rest = text.length - shown.length
  return `\n${shown
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}${rest > 0 ? `\n  ${prompts.toolResults.logMore(rest, seq)}` : ''}`
}

/** One read_log entry in full: a tool call with all its arguments and its whole result (as logged), or a reply. */
export function logEntry(events: readonly MyrEvent[], seq: number): string {
  const e = events.find((x) => x.seq === seq)
  if (!e) throw new Error(`the log has no entry #${seq}`)
  const head = `#${e.seq} ${clockTime(e.time)}`
  if (e.type === 'tool/call') {
    const p = e.payload as EventPayloads['tool/call']
    const result = events.find(
      (x) =>
        x.type === 'tool/result' &&
        (x.payload as EventPayloads['tool/result']).agent === p.agent &&
        (x.payload as EventPayloads['tool/result']).callId === p.callId,
    )?.payload as EventPayloads['tool/result'] | undefined
    return `${head} ${p.agent} ${p.tool}\nargs: ${JSON.stringify(p.args ?? {}, null, 2)}\n${
      result ? `${result.ok ? 'ok' : 'FAILED'}:\n${result.output}` : prompts.toolResults.logPending
    }`
  }
  if (e.type === 'chat/reply') {
    const p = e.payload as EventPayloads['chat/reply']
    return `${head} ${p.agent} told the person:\n${p.text}`
  }
  if (e.type === 'task/changed') {
    const p = e.payload as EventPayloads['task/changed']
    return `${head} ${p.by} ${p.task.id} → ${p.task.status}${p.reason ? `\n${p.reason}` : ''}`
  }
  throw new Error(`#${seq} is not a tool call, task change or reply`)
}

export function observeFacts(host: ColonyHost): string {
  const s = host.state()
  const now = Date.now()
  const left = Math.max(0, Math.round((host.deadline() - now) / 1000))
  const tasks = Object.values(s.tasks)
  const pending = tasks.filter((t) => t.status === 'pending' && blockersDone(s, t)).map((t) => t.id)
  const blocked = tasks.filter((t) => t.status === 'pending' && !blockersDone(s, t)).map((t) => t.id)
  const rejected = tasks.filter((t) => t.status === 'rejected').map((t) => t.id)
  const idle = Object.values(s.agents)
    .filter((a) => a.status === 'idle')
    .map((a) => a.info.name)
  const spent = host.spent().cost
  const finals = reviewVerdicts(s).filter((v) => v.target === 'colony')
  return [
    `time left: ${left}s of ${Math.round(s.budget.wallMs / 1000)}s`,
    s.budget.costUsd !== undefined ? `cost: $${spent.toFixed(3)} of $${s.budget.costUsd}` : null,
    `tasks: ${tasks.length} total, unclaimed ${pending.join(', ') || 'none'}, blocked ${blocked.join(', ') || 'none'}, rejected ${rejected.join(', ') || 'none'}`,
    `idle agents: ${idle.join(', ') || 'none'}`,
    `artifacts: ${Object.keys(s.artifacts).join(', ') || 'none'}`,
    `final verifications: ${finals.length} run, last ${finals.at(-1)?.pass ? 'passed' : 'not passed'}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function guessMediaType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return (
    {
      html: 'text/html',
      css: 'text/css',
      js: 'text/javascript',
      mjs: 'text/javascript',
      ts: 'text/typescript',
      json: 'application/json',
      md: 'text/markdown',
      py: 'text/x-python',
      svg: 'image/svg+xml',
      csv: 'text/csv',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      wasm: 'application/wasm',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
    }[ext ?? ''] ?? 'text/plain'
  )
}

/**
 * Tools matching a find_tools query. Every tool a query word names is found, however many: exact names, and names
 * with a part that is the word or starts with it ("browser" is every browser_* tool, "server" start_server and the
 * rest). Descriptions are only a fallback when no name matches, best first and at most `limit`; whatever else
 * matches comes back as `more`, so nothing that matched is left out without the agent being told.
 */
export function matchTools(
  tools: readonly AgentTool[],
  query: string,
  limit = FIND_TOOLS_LIMIT,
): { found: AgentTool[]; more: AgentTool[] } {
  const q = query.toLowerCase()
  const asked = q.split(/[\s,]+/).filter(Boolean)
  const words = q.split(/[^a-z0-9_-]+/).filter((w) => w.length > 2)
  const names = (w: string, part: string) =>
    part === w || part === `${w}s` || `${part}s` === w || (w.length > 3 && part.startsWith(w))
  const byName = tools.filter((t) => {
    const name = t.name.toLowerCase()
    const parts = name.split(/[_-]+/)
    return asked.includes(name) || words.some((w) => w === name || parts.some((p) => names(w, p)))
  })
  const described = tools
    .filter((t) => !byName.includes(t))
    .map((t) => ({ t, score: words.filter((w) => t.description.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t)
  if (byName.length > 0) return { found: byName, more: described }
  return { found: described.slice(0, limit), more: described.slice(limit) }
}

/**
 * Wraps tool definitions as pi-agent-core tools for one agent. The allowlist and tier rules are
 * enforced here, inside execution, so hiding a tool from the model is never the only defence.
 */
export function buildAgentTools(
  agent: string,
  allowed: readonly string[],
  host: ColonyHost,
  /** The agent's current model, which sizes computer use's screenshots. */
  model?: () => Model,
  /** The facts the agent's prompt was assembled from, so configuration-dependent descriptions match it. */
  facts?: PromptFacts,
): AgentTool[] {
  const allow = new Set(allowed)
  const mcp = allow.has('mcp')
    ? [...host.mcpTools(), ...host.pluginTools(agent)]
        // A single MCP tool switched off in Settings is left out like any disabled tool.
        .filter(
          (t) =>
            !host.spec.disabledTools?.includes(t.name) &&
            !host.hidden(agent, t.name, t.name.startsWith('mcp__') ? host.mcpServer(t.name) : undefined),
        )
        .map((t) => logged(agent, t, host))
    : []
  // Scripts run in the sandbox, so they need shell; browser flows drive the agent's browser.
  const scripts = allow.has('shell') && (host.sandbox.kind !== 'none' || host.unsafeNoSandbox)
  const browsing = allow.has('browser_open') && host.browser !== undefined
  const made = Object.values(host.state().madeTools)
    .filter((t) => (t.language === 'browser' ? browsing : scripts))
    .map((t) => logged(agent, madeTool(agent, t, host), host))
  // The person's Mac, only for rounds that may use it (never one a channel member started or wrote into), through
  // the engine set in Settings. The app tools come with the computer tool: a rule that takes it away takes them too.
  const hub = host.computer
  const computer =
    !hub || !model
      ? []
      : hub.engine === 'omp'
        ? allow.has(DESKTOP_TOOL)
          ? [desktopTool(agent, host)]
          : []
        : allow.has(COMPUTER_TOOL)
          ? [
              computerTool(agent, host, model),
              ...([OPEN_APP_TOOL, LIST_APPS_TOOL] as const)
                .filter((name) => allow.has(name))
                .map((name) => appTool(name, agent, host, model)),
            ]
          : []
  return [...harnessTools(agent, allow, host, facts), ...mcp, ...made, ...computer]
}

/** Runs a made tool's script in the caller's sandbox, with its inputs as JSON in MYR_INPUT. */
async function runMadeTool(
  tool: MadeTool,
  input: Record<string, unknown>,
  agent: string,
  host: ColonyHost,
): Promise<{ ok: boolean; output: string }> {
  if (tool.language === 'browser') return runBrowserFlow(tool, input, agent, host)
  if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox) throw new Error('made tools need the OS sandbox')
  const cwd = host.workspace.workdir(agent)
  const r = await host.sandbox.run({
    command: scriptCommand(join(host.workspace.colonyDir, 'tools', tool.name), tool),
    cwd,
    writable: writableFor(host, agent),
    ...host.workspace.confinement(),
    timeoutMs: 120_000,
    env: { MYR_INPUT: JSON.stringify(input), MYR_MIRROR: host.workspace.mirrorRoot },
  })
  const ok = !r.timedOut && r.code === 0
  const output = ok
    ? r.stdout.trim() || '(no output)'
    : `${r.timedOut ? 'TIMED OUT after 120s' : `exit ${r.code}`}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`
  return { ok, output: clip(output) }
}

/**
 * Finds a flow step's target, waiting for it to appear: CSS, `text=` (visible text), or `aria=` (accessible name:
 * aria-label, label text, placeholder, title or alt). Among visible matches an exact one beats a partial one,
 * clickable elements beat others, and the innermost element wins.
 */
async function locate(page: BrowserTab['page'], target: string, timeout: number) {
  const mode = target.startsWith('text=') ? 'text' : target.startsWith('aria=') ? 'aria' : 'css'
  if (mode === 'css') {
    const handle = await page.waitForSelector(target, { visible: true, timeout }).catch(() => null)
    if (!handle) throw new Error(`nothing visible matches ${target} within ${timeout / 1000}s`)
    return handle
  }
  const wanted = target.slice(5)
  const found = await page
    .waitForFunction(
      (text: string, by: string) => {
        const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
        const t = norm(text)
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        }
        const name = (el: Element) => {
          if (by === 'text') return norm((el as HTMLElement).innerText || (el as HTMLInputElement).value)
          const labelled = el.getAttribute('aria-labelledby')
          return norm(
            el.getAttribute('aria-label') ||
              (labelled ? document.getElementById(labelled)?.textContent : '') ||
              [...((el as HTMLInputElement).labels ?? [])].map((l) => l.textContent).join(' ') ||
              el.getAttribute('placeholder') ||
              el.getAttribute('title') ||
              el.getAttribute('alt') ||
              (el.matches('button, a, [role]') ? (el as HTMLElement).innerText : ''),
          )
        }
        const all = [...document.querySelectorAll('body *')].filter(
          (el) => visible(el) && name(el).includes(t),
        )
        // Innermost: drop elements that contain another match.
        const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
        const clickable = (el: Element) =>
          el.matches('a, button, [role=button], [role=link], summary, label, input, textarea, select')
        inner.sort(
          (a, b) =>
            Number(name(b) === t) - Number(name(a) === t) || Number(clickable(b)) - Number(clickable(a)),
        )
        return inner[0] ?? null
      },
      { timeout },
      wanted,
      mode,
    )
    .catch(() => null)
  const handle = found?.asElement()
  if (!handle)
    throw new Error(
      `no visible element ${mode === 'text' ? 'with the text' : 'named'} "${wanted}" within ${timeout / 1000}s`,
    )
  return handle as ElementHandle<Element>
}

/**
 * Runs a saved browser flow in the caller's own browser: each step as a person would do it, with the live view's
 * cursor and highlight, ending with the page (or the extracted data). A failing step stops the flow and says which.
 */
async function runBrowserFlow(
  tool: MadeTool,
  input: Record<string, unknown>,
  agent: string,
  host: ColonyHost,
): Promise<{ ok: boolean; output: string }> {
  const tab = await browserTab(host, agent)
  const extracted: string[] = []
  for (const [i, step] of browserSteps(tool.source).entries()) {
    try {
      if ('open' in step) {
        const url = fillPlaceholders(step.open, input, true)
        if (!/^https?:/.test(url)) throw new Error(`open needs an http(s) URL, got ${url}`)
        await navigate(tab, tab.page, url)
        await tab.page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => {})
        await keyframe(host, agent, tab, 'open')
      } else if ('click' in step) {
        const handle = await locate(tab.page, fillPlaceholders(step.click, input), 10_000)
        const at = await pointAt(tab, handle, 'click', step.click)
        await tab.page.mouse.click(at.x, at.y)
        doneWith(tab)
        await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 4_000 }).catch(() => {})
        await keyframe(host, agent, tab, 'click', step.click)
      } else if ('type' in step) {
        const handle = await locate(tab.page, fillPlaceholders(step.type, input), 10_000)
        await pointAt(tab, handle, 'type', step.type)
        await handle.click({ count: 3 })
        await tab.page.keyboard.type(fillPlaceholders(step.text, input))
        if (step.submit) await tab.page.keyboard.press('Enter')
        doneWith(tab)
        await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 4_000 }).catch(() => {})
        await keyframe(host, agent, tab, 'type', step.type)
      } else if ('press' in step) {
        await tab.page.keyboard.press(step.press as never)
        await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 4_000 }).catch(() => {})
      } else if ('wait' in step) {
        if (typeof step.wait === 'number') await Bun.sleep(Math.min(step.wait, 10_000))
        else await locate(tab.page, fillPlaceholders(step.wait, input), 15_000)
      } else if ('extract' in step) {
        const e = step.extract
        const data = await extractFromPage(tab.page, e.what, e.selector ?? '', e.fields ?? {}, 200)
        extracted.push(JSON.stringify(data, null, 2))
      }
    } catch (err) {
      return { ok: false, output: await flowStepFailure(i, step, err, () => pageSnapshot(tab)) }
    }
  }
  const output = extracted.length ? extracted.join('\n') : await pageSnapshot(tab)
  host.rememberUntrusted(agent, `${MADE_PREFIX}${tool.name}`, output)
  return {
    ok: true,
    output: spotlight(host.boundary, `${MADE_PREFIX}${tool.name} ${tab.page.url()}`, clip(output)),
  }
}

/**
 * What a failed browser-flow step tells the agent: the step and its error, then the page as it is. The page is extra
 * context; when it cannot be read (the tab closed, the browser's session ended) the step's own error still comes
 * through instead of the snapshot's.
 */
export async function flowStepFailure(
  index: number,
  step: unknown,
  err: unknown,
  snapshot: () => Promise<string>,
): Promise<string> {
  const head = `step ${index + 1} (${JSON.stringify(step)}) failed: ${err instanceof Error ? err.message : String(err)}`
  const page = await snapshot().catch(
    (e) => `(the page could not be read: ${e instanceof Error ? e.message : String(e)})`,
  )
  return `${head}\n${page}`
}

function madeTool(agent: string, tool: EventPayloads['tool/created'], host: ColonyHost): AgentTool {
  return {
    name: `${MADE_PREFIX}${tool.name}`,
    label: `${MADE_PREFIX}${tool.name}`,
    description: `${tool.description} (${tool.library ? 'from the library' : `made by ${tool.agent}`})`,
    parameters: inputSchema(tool.inputs) as never,
    intent: 'omit',
    approval: 'exec',
    concurrency: 'exclusive',
    async execute(_callId: string, params: unknown) {
      const r = await inCallOrder(host, agent, async () => {
        const input = checkedArgs(tool.inputs, params ?? {})
        await guardProjectCommand(
          host,
          agent,
          `${MADE_PREFIX}${tool.name}`,
          `${MADE_PREFIX}${tool.name} ${JSON.stringify(input)}`,
        )
        return runMadeTool(tool, input, agent, host)
      })
      return { content: [{ type: 'text', text: r.output }], isError: !r.ok }
    },
  } as AgentTool
}

const breakers = new WeakMap<ColonyHost, Map<string, { failures: number; last: string }>>()

/**
 * A failing MCP server (a bad key, a dead endpoint) should not eat a round: its consecutive failures are counted per
 * colony, keyed by the server part of the tool name (mcp__<server>_<tool>).
 */
export function mcpBreaker(host: ColonyHost, toolName: string) {
  const server = /^mcp__([a-z0-9]+)/.exec(toolName)?.[1]
  if (!server) return undefined
  let byServer = breakers.get(host)
  if (!byServer) {
    byServer = new Map()
    breakers.set(host, byServer)
  }
  let state = byServer.get(server)
  if (!state) {
    state = { failures: 0, last: '' }
    byServer.set(server, state)
  }
  return {
    /** Why the call is refused, while the server is switched off. */
    refusal: () =>
      state.failures >= MCP_FAILURE_LIMIT
        ? `this MCP server failed ${state.failures} times in a row this round (last: ${state.last}), so its tools are switched off until the next round. Use Myrmidon's own tools instead (browser_*, web_*, shell).`
        : undefined,
    record(result: AgentToolResult) {
      if (!result.isError) {
        state.failures = 0
        return
      }
      state.failures += 1
      state.last = result.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join(' ')
        .slice(0, 160)
    },
  }
}

/** An MCP tool, recorded in the log like the harness's own tools and refused once the colony has ended. */
/**
 * A call the agent was told to drop (the person stopped the round or tightened its permissions) ends at once for the
 * agent; an MCP server or plugin that ignores the signal finishes on its own, and its late result is discarded.
 */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new Error('the call was stopped'))
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('the call was stopped')), { once: true }),
    ),
  ])
}

function logged(agent: string, tool: AgentTool, host: ColonyHost): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    intent: 'omit',
    approval: 'write',
    async execute(callId: string, params: unknown, signal?: AbortSignal) {
      const actor = agentActor(agent)
      await host.append({
        type: 'tool/call',
        actor,
        payload: {
          agent,
          callId,
          tool: tool.name,
          args: params ?? {},
          ...(tool.name.startsWith('mcp__') && host.mcpReadOnly(tool.name) ? { readOnly: true } : {}),
        },
      })
      let result: AgentToolResult
      const breaker = mcpBreaker(host, tool.name)
      // Only the server's own answers count toward its breaker, not the harness refusing the call.
      let ran = false
      const key = receiptKey(host, agent, tool.name, params)
      try {
        if (host.state().status !== 'running') throw new Error('the colony is no longer running')
        if (host.huddling()) throw new Error(prompts.toolResults.huddling)
        const kept = host.state().receipts[key]
        if (kept !== undefined) {
          result = {
            content: [{ type: 'text', text: prompts.toolResults.alreadyDone(kept) }],
            isError: false,
          }
        } else {
          const refused = breaker?.refusal()
          if (refused) throw new Error(refused)
          const edited = await askFirst(host, agent, tool.name, params, mcpCallOf(host, tool.name), key)
          await host.beforeTool(agent, tool.name, params)
          ran = true
          result = await untilAborted(tool.execute(callId, params as never, signal), signal)
          if (!result.isError) {
            const said = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
            const note = `${await host.afterTool(agent, tool.name, params, said)}${edited ? prompts.toolResults.editedByPerson : ''}`
            if (note) result = { ...result, content: [...result.content, { type: 'text', text: note }] }
            await keepReceipt(host, agent, tool.name, key, said)
          }
        }
      } catch (err) {
        result = {
          content: [{ type: 'text', text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
      if (ran) breaker?.record(result)
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
      await host.append({
        type: 'tool/result',
        actor,
        payload: { agent, callId, tool: tool.name, ok: !result.isError, output: clip(text, 8_000) },
      })
      // MCP servers bring in outside content (mail, issues, pages): the agent sees it marked as untrusted too.
      if (tool.name.startsWith('mcp__') && !result.isError) {
        host.rememberUntrusted(agent, tool.name, text)
        return {
          ...result,
          content: result.content.map((c) =>
            c.type === 'text' ? { ...c, text: spotlight(host.boundary, tool.name, c.text) } : c,
          ),
        }
      }
      return result
    },
  } as AgentTool
}

/** Thrown to skip a call whose approved twin already ran: it ends the call with its receipt, not an error. */
class AlreadyDone extends Error {
  constructor(readonly output: string) {
    super('already done')
  }
}

/** A harness tool's parameters as JSON Schema, the way providers receive them (as pi-ai's arkToWireSchema does). */
export function toolParameters(name: string): Record<string, unknown> | undefined {
  const params = computerToolSpec(name)?.parameters ?? TOOL_DEFS.find((d) => d.name === name)?.parameters
  return params?.toJsonSchema({ fallback: (ctx: { base: unknown }) => ctx.base } as never) as
    | Record<string, unknown>
    | undefined
}

/** A harness tool's description as this agent sees it. */
export function toolDescription(name: string, facts?: PromptFacts): string | undefined {
  const def = TOOL_DEFS.find((d) => d.name === name)
  return def && facts && def.describe ? def.describe(facts) : def?.description
}

function harnessTools(
  agent: string,
  allow: ReadonlySet<string>,
  host: ColonyHost,
  facts?: PromptFacts,
): AgentTool[] {
  return TOOL_DEFS.filter((d) => allow.has(d.name))
    .filter((d) => d.tier !== 'exec' || host.sandbox.kind !== 'none' || host.unsafeNoSandbox)
    .map(
      (def): AgentTool => ({
        name: def.name,
        label: def.name,
        description: (facts && def.describe?.(facts)) || def.description,
        parameters: def.parameters,
        intent: 'omit',
        approval: def.tier,
        concurrency: def.tierOf
          ? (args: unknown) => concurrencyOf({ name: def.name, tier: tierOf(def, args) })
          : concurrencyOf(def),
        async execute(callId: string, params: unknown): Promise<AgentToolResult> {
          const actor = agentActor(agent)
          await host.append({
            type: 'tool/call',
            actor,
            payload: { agent, callId, tool: def.name, args: params ?? {} },
          })
          let output: string
          let images: ToolOutput['images'] = []
          let usage: UsageInfo | undefined
          let ok = true
          const tier = tierOf(def, params)
          // Calls that write get receipts; commands may rightly run twice, and reads change nothing.
          const key = tier === 'write' ? receiptKey(host, agent, def.name, params) : undefined
          const kept = key === undefined ? undefined : host.state().receipts[key]
          try {
            if (!allow.has(def.name)) throw new Error(`${def.name} is not allowed for ${agent}`)
            if (host.state().status !== 'running') throw new Error('the colony is no longer running')
            if (host.huddling() && !HUDDLE_TOOLS.has(def.name)) throw new Error(prompts.toolResults.huddling)
            if (kept !== undefined) throw new AlreadyDone(kept)
            if (COPY_CHECKED.has(def.name)) await flagIfCopied(host, agent, def.name, params)
            // File changes, commands and proposals are decided where the change is known (guardProject*).
            const edited =
              GUARDED.has(def.name) && (tier !== 'read' || GUARDS_READS.has(def.name))
                ? false
                : await askFirst(
                    host,
                    agent,
                    def.name,
                    params,
                    callOf(host, agent, tier, def.name, params),
                    key,
                  )
            await host.beforeTool(agent, def.name, params)
            const run = () => def.run(params ?? {}, agent, host)
            const result =
              tier === 'read' || IN_PARALLEL.has(def.name) ? await run() : await inCallOrder(host, agent, run)
            output = typeof result === 'string' ? result : result.text
            // The person's hooks speak for the harness: their note stays outside any untrusted-content block.
            const hookNote = await host.afterTool(agent, def.name, params, output)
            if (typeof result !== 'string') {
              images = result.images
              usage = result.usage
            }
            const preface = typeof result === 'string' ? '' : (result.preface ?? '')
            // Long pages are saved under web/ in scratch, and the browser's downloads under downloads/; reading one
            // back is still outside content.
            const savedPage =
              def.name === 'fs_read' &&
              /(^|[\\/])(web|downloads)[\\/]/.test(String((params as { path?: unknown })?.path ?? ''))
            if (UNTRUSTED.has(def.name) || savedPage) {
              const source = untrustedSource(def.name, params, output)
              host.rememberUntrusted(agent, source, output)
              output = spotlight(host.boundary, source, output)
            }
            output = `${preface}${output}${hookNote}${edited ? prompts.toolResults.editedByPerson : ''}`
            if (key) await keepReceipt(host, agent, def.name, key, output)
          } catch (err) {
            ok = err instanceof AlreadyDone
            output = ok
              ? prompts.toolResults.alreadyDone((err as AlreadyDone).output)
              : `ERROR: ${err instanceof Error ? err.message : String(err)}`
          }
          await host.append({
            type: 'tool/result',
            actor,
            payload: {
              agent,
              callId,
              tool: def.name,
              ok,
              output: clip(output, 8_000),
              ...(usage ? { usage } : {}),
            },
          })
          return {
            content: [
              { type: 'text', text: output },
              ...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
            ],
            isError: !ok,
          }
        },
      }),
    )
}
