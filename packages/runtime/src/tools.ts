import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  type Review,
  type ReviewField,
  resolveConversation,
  reviewVerdicts,
  SYSTEM,
  type TaskSnapshot,
  TEAM_CHAT,
} from '@myrmidon/protocol'
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { type } from '@oh-my-pi/pi-ai'
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
  assertAgentControl,
  type BrowserTab,
  doneWith,
  openPage,
  pageElement,
  pageSnapshot,
  pointAt,
  refLabel,
  switchPage,
  watched,
} from './browser.ts'
import {
  GLOB_LIMIT,
  GREP_LIMIT,
  MAX_ARTIFACT_BYTES,
  MAX_READ_CHARS,
  MCP_FAILURE_LIMIT,
  PAGE_EXCERPT,
  REVIEW_MAX_CHARS,
} from './config.ts'
import { gitCommitChanges, gitWorkingChanges } from './git.ts'
import { agentActor, type ColonyHost } from './host.ts'
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
import { toolsFor } from './patterns.ts'
import { adoptDraft, isOwnDraft, testPlugin, writeDraft } from './plugin-builder.ts'
import type { ProjectCheck } from './project-context.ts'
import { prompts } from './prompts.ts'
import { SANDBOX_DIRS } from './sandbox.ts'
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
}

interface ToolDef {
  readonly name: string
  readonly tier: Tier
  readonly description: string
  readonly parameters: ReturnType<typeof type>
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
 * submit that lists it. Each agent's write calls therefore run one after another; reads stay parallel.
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

/** A file URL for a published artifact, after writing the latest files so relative links resolve. */
async function artifactUrl(host: ColonyHost, name: string): Promise<string> {
  const artifacts = host.state().artifacts
  if (!artifacts[name]) throw new Error(`no such artifact: ${name}`)
  // Its own copy: the mirror is read-only for the agents' shells.
  const root = join(host.workspace.colonyDir, 'browse')
  for (const [file, versions] of Object.entries(artifacts)) {
    const latest = versions.at(-1)
    if (!latest) continue
    const path = join(root, assertArtifactName(file))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, await host.blobs.get(latest.blob))
  }
  return pathToFileURL(join(root, name)).href
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
  if (host.spec.chat?.project?.permissions?.mode === 'read-only') return [scratch]
  return [...new Set([host.workspace.workdir(agent), scratch])]
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
  'spawn_worker',
  'dismiss_worker',
  'update_todo',
])

/**
 * Whether a call needs the person's approval first. A round started by someone else (`askAll`) asks for every call
 * that is not `readOnly`, whatever the person allowed. Otherwise a tool's own rule wins, then the rule for every MCP
 * tool; with neither, an MCP tool asks unless its server marks it read-only, and other tools follow their groups.
 * `readOnly`: the call changes nothing outside the colony.
 */
export function needsApproval(
  spec: Pick<ColonyHost['spec'], 'askTools' | 'allowTools' | 'askAll'>,
  tool: string,
  readOnly: boolean,
): boolean {
  const ask = spec.askTools ?? []
  const allow = spec.allowTools ?? []
  if (spec.askAll && !readOnly) return true
  if (ask.includes(tool)) return true
  if (allow.includes(tool) || !tool.startsWith('mcp__')) return false
  if (ask.includes('mcp')) return true
  if (allow.includes('mcp')) return false
  return !readOnly
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
 * Tools the person set to "ask" in Settings wait for their approval on every call, showing the call in full; the
 * person may rewrite its text arguments first. Returns whether they did.
 */
async function askFirst(
  host: ColonyHost,
  agent: string,
  tool: string,
  params: unknown,
  readOnly: boolean,
  key?: string,
): Promise<boolean> {
  if (!needsApproval(host.spec, tool, readOnly)) return false
  const args = JSON.stringify(params ?? {})
  const decision = await host.reviewChange(
    agent,
    tool,
    `${tool} ${args.length > 280 ? `${args.slice(0, 280)}…` : args}`,
    { review: callReview(tool, params), ...(key ? { key } : {}) },
  )
  if (!decision.approved) throw new Error(prompts.toolResults.declined(`this ${tool} call`, decision.note))
  const edits = Object.entries(decision.edits ?? {})
  for (const [k, v] of edits) (params as Record<string, unknown>)[k] = v
  return edits.length > 0
}

/**
 * A write to a file in the project folder (not scratch) follows the project's permissions. In an "ask" project the
 * person sees the new content against the file as it is, and may rewrite it; returns the content to write.
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
  const mode = project?.permissions?.mode ?? 'auto'
  if (!project || mode === 'auto') return unchanged
  const scratch = host.workspace.scratch(agent)
  const inProject =
    (path === project.path || path.startsWith(`${project.path}/`)) && !path.startsWith(`${scratch}/`)
  if (!inProject) return unchanged
  const where = relative(project.path, path)
  if (mode === 'read-only')
    throw new Error(
      `${project.name} is read-only for agents: you can read it but not change ${where}. Put drafts in your scratch directory and describe the change instead.`,
    )
  const decision = await host.reviewChange(agent, tool, `${tool === 'fs_edit' ? 'edit' : 'write'} ${where}`, {
    review: fileReview(
      tool === 'fs_edit' ? prompts.reviewCard.edit(where) : prompts.reviewCard.write(where),
      where,
      change,
    ),
    key: change.key,
  })
  if (!decision.approved) throw new Error(prompts.toolResults.declined(`changing ${where}`, decision.note))
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
 * In an "ask" project, a command runs only if it starts with an allowed prefix or the person approves it; where the
 * command is real (`editable`), they may rewrite it first. Returns the command to run.
 */
async function guardProjectCommand(
  host: ColonyHost,
  agent: string,
  tool: string,
  command: string,
  editable = false,
): Promise<string> {
  const permissions = host.spec.chat?.project?.permissions
  if (permissions?.mode !== 'ask') return command
  const line = command.trim()
  // "bun test && rm -rf src" starts with an allowed prefix but runs more: anything chained, piped, substituted or
  // redirected always asks.
  const simple = !/[;&|`<>\n]|\$\(/.test(line)
  if (simple && permissions.allow.some((prefix) => line === prefix || line.startsWith(`${prefix} `)))
    return command
  const decision = await host.reviewChange(agent, tool, line.length > 300 ? `${line.slice(0, 300)}…` : line, {
    review: {
      kind: 'command',
      title: prompts.reviewCard.command,
      fields: [{ key: 'command', label: tool, value: line, format: 'code', editable }],
    },
  })
  if (!decision.approved) throw new Error(prompts.toolResults.declined('this command', decision.note))
  return decision.edits?.command ?? command
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
])
/** Tools whose command is checked against recent web content before it runs. */
const COPY_CHECKED = new Set(['shell', 'start_server'])

function untrustedSource(tool: string, params: unknown, output: string): string {
  const args = (params ?? {}) as { url?: unknown; query?: unknown }
  if (tool === 'web_fetch' && typeof args.url === 'string') return args.url
  if (tool === 'web_search' && typeof args.query === 'string') return `search: ${args.query}`
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
  const command = String((params as { command?: unknown })?.command ?? '').trim()
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
      text: type('string').atLeastLength(1),
      'section?': type("'plan' | 'decision' | 'finding' | 'status'"),
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
          `no such teammate or group: ${args.to}. Teammates: ${crewOf(state).join(', ')}; groups: ${Object.keys(state.groups).join(', ') || 'none'}; or "team"`,
        )
      if (chat.kind === 'group' && !chat.members.includes(agent))
        throw new Error(`you are not in the group ${args.to}; ask a member to add you`)
      if (args.reply_to !== undefined && !linesOf(state, chat.id).some((l) => l.seq === args.reply_to))
        throw new Error(`#${args.reply_to} is not a message in your conversation with ${args.to}`)
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
      if (members.length < 2) throw new Error('a group needs at least one teammate besides you')
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
      name: type('string'),
      'add?': type('string').array(),
      'remove?': type('string').array(),
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
    parameters: type({ 'with?': type('string'), 'limit?': type('number') }),
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
      return Object.values(s.agents)
        .map((a) => {
          const task = Object.values(s.tasks).find(
            (t) => t.owner === a.info.name && t.status === 'in_progress',
          )
          return `${a.info.name} (${a.info.role}) ${a.status}${task ? ` working on ${task.id}` : ''}`
        })
        .join('\n')
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
    description: prompts.tools.create_task.description,
    parameters: type({
      subject: type('string').atLeastLength(1),
      'description?': type('string'),
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
    parameters: type({ id: type('string'), revision: type('number') }),
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
    parameters: type({ id: type('string'), assignee: type('string'), revision: type('number') }),
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
    parameters: type({ id: type('string'), revision: type('number') }),
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
      id: type('string'),
      revision: type('number'),
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
    parameters: type({ id: type('string'), revision: type('number'), artifacts: type('string').array() }),
    async run(args, agent, host) {
      if (args.id === 'task-final') throw new Error(FINAL_HINT)
      const held = host.state().tasks[args.id]
      if (held?.owner !== agent || held.status !== 'in_progress')
        throw new Error(`you do not hold ${args.id}`)
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
      'content?': type('string'),
      'fromScratch?': type('string').describe(prompts.tools.publish_artifact.params.fromScratch),
      'mediaType?': type('string'),
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
                mediaType: args.mediaType ?? guessMediaType(name),
              },
            },
          ]
        }),
      )
      return `published ${name} v${(e.payload as EventPayloads['artifact/versioned']).version} (${size} bytes)`
    },
  },
  {
    name: 'read_artifact',
    tier: 'read',
    description: prompts.tools.read_artifact.description,
    parameters: type({ name: type('string'), 'version?': type('number') }),
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
      name: type('string'),
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
    parameters: type({ query: type('string').atLeastLength(2) }),
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
    }),
    async run(args, _agent, host) {
      const events = await host.log.read(host.id)
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
    description: prompts.tools.fs_write.description,
    parameters: type({ path: type('string'), content: type('string') }),
    async run(args, agent, host) {
      const path = host.workspace.resolveInWorkdir(agent, args.path)
      const { content, edited } = await guardProjectEdit(host, agent, 'fs_write', path, {
        before: existsSync(path) ? readFileSync(path, 'utf8') : '',
        after: args.content,
        key: receiptKey(host, agent, 'fs_write', args),
      })
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return `wrote ${args.path} (${Buffer.byteLength(content)} bytes)${edited ? prompts.toolResults.editedByPerson : ''}`
    },
  },
  {
    name: 'fs_edit',
    tier: 'write',
    description: prompts.tools.fs_edit.description,
    parameters: type({
      path: type('string'),
      old: type('string').atLeastLength(1),
      new: type('string'),
      'all?': type('boolean'),
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
      return `edited ${args.path} (${args.all ? count : 1} replacement${count > 1 && args.all ? 's' : ''})${edited ? prompts.toolResults.editedByPerson : ''}`
    },
  },
  {
    name: 'fs_read',
    tier: 'read',
    description: prompts.tools.fs_read.description,
    parameters: type({ path: type('string') }),
    async run(args, agent, host) {
      return clip(readFileSync(host.workspace.resolveInWorkdir(agent, args.path), 'utf8'))
    },
  },
  {
    name: 'fs_list',
    tier: 'read',
    description: prompts.tools.fs_list.description,
    parameters: type({ 'path?': type('string') }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const dir = host.workspace.resolveInWorkdir(agent, args.path ?? '.')
      const out: string[] = []
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (SANDBOX_DIRS.has(entry.name) || SKIP_DIRS.has(entry.name) || out.length > 500) continue
          const full = `${d}/${entry.name}`
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
    description: prompts.tools.grep.description,
    parameters: type({
      pattern: type('string').atLeastLength(1).describe(prompts.tools.grep.params.pattern),
      'path?': type('string').describe(prompts.tools.grep.params.path),
      'glob?': type('string').describe(prompts.tools.grep.params.glob),
      'ignoreCase?': 'boolean',
      'context?': type('number').describe(prompts.tools.grep.params.context),
      'filesOnly?': type('boolean').describe(prompts.tools.grep.params.filesOnly),
    }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const target = host.workspace.resolveInWorkdir(agent, args.path ?? '.')
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
      if (result.matches.length === 0)
        return `No matches for /${args.pattern}/ in ${relative(root, target) || '.'}.`
      const head = `${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} in ${result.filesWithMatches} file${result.filesWithMatches === 1 ? '' : 's'}${result.totalMatches > result.matches.length ? ` (showing ${result.matches.length})` : ''}`
      if (args.filesOnly) return `${head}\n${result.matches.map((m) => where(m.path)).join('\n')}`
      const lines: string[] = [head]
      let file = ''
      for (const m of result.matches) {
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
    description: prompts.tools.glob.description,
    parameters: type({
      pattern: type('string').atLeastLength(1),
      'path?': type('string').describe(prompts.tools.glob.params.path),
    }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const target = host.workspace.resolveInWorkdir(agent, args.path ?? '.')
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
      if (result.matches.length === 0) return `No files match ${args.pattern}.`
      return result.matches.map((m) => relative(root, resolve(target, m.path)) || m.path).join('\n')
    },
  },
  {
    name: 'web_search',
    tier: 'read',
    description: prompts.tools.web_search.description,
    parameters: type({
      query: type('string').atLeastLength(2),
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
      const note = stale.length
        ? prompts.toolResults.staleYear(stale, new Date().toISOString().slice(0, 10))
        : ''
      return { text: clip(text.trim() || `No results for "${args.query}".`), images: [], preface: note }
    },
  },
  {
    name: 'web_fetch',
    tier: 'read',
    description: prompts.tools.web_fetch.description,
    parameters: type({ url: type('string').describe(prompts.tools.web_fetch.params.url) }),
    async run(args, agent, host) {
      const page = await host.web.read(args.url)
      const head = `Source: ${page.url} (${page.method}, ${page.contentType})`
      if (page.output.length <= PAGE_EXCERPT) return { text: page.output, images: [], preface: `${head}\n` }
      // Like Manus: keep context small and the rest recoverable. The full page goes to a scratch file the agent
      // can read or grep, and only an excerpt enters the conversation.
      const self = host.spec.agents.find((a) => a.name === agent)
      if (!self || !toolsFor(host.spec, self).includes('fs_read'))
        return { text: clip(page.output, 16_000), images: [], preface: `${head}\n` }
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
    name: 'escalate',
    tier: 'write',
    description: prompts.tools.escalate.description,
    parameters: type({
      to: "'solo' | 'team'",
      reason: type('string').atLeastLength(1).describe(prompts.tools.escalate.params.reason),
    }),
    async run(args, agent, host) {
      return host.escalate(agent, args.to, args.reason)
    },
  },
  {
    name: 'reply_user',
    tier: 'write',
    description: prompts.tools.reply_user.description,
    parameters: type({ text: type('string').atLeastLength(1), 'final?': type('boolean') }),
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
      text: type('string').atLeastLength(1),
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
      text: type('string').atLeastLength(3).atMostLength(400),
      kind: "'preference' | 'decision' | 'lesson' | 'fact'",
      scope: type("'everywhere' | 'project'").describe(prompts.tools.remember.params.scope),
      why: type('string').describe(prompts.tools.remember.params.why),
    }),
    async run(args, agent, host) {
      return host.proposeMemory(agent, args)
    },
  },
  {
    name: 'check_in',
    tier: 'write',
    description: prompts.tools.check_in.description,
    parameters: type({
      question: type('string').atLeastLength(3),
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
        question: type('string').atLeastLength(3),
        'header?': type('string').atMostLength(20),
        options: type({ label: type('string').atLeastLength(1), 'description?': 'string' })
          .array()
          .atLeastLength(2)
          .atMostLength(4),
        'multiSelect?': 'boolean',
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
      name: type('string'),
      'tests?': type({ tool: type('string'), 'args?': type('Record<string, unknown>') })
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
      })
    },
  },
  {
    name: 'propose_plugin',
    tier: 'write',
    description: prompts.tools.propose_plugin.description,
    parameters: type({
      name: type('string'),
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
      kind: type("'file' | 'commit'"),
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
        const decision = await host.reviewChange(agent, 'propose', args.why, {
          review: fileReview(title, where, { before, after: args.content }),
          key,
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
      const decision = await host.reviewChange(agent, 'propose', args.why, {
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
    name: 'spawn_worker',
    tier: 'write',
    description: prompts.tools.spawn_worker.description,
    parameters: type({
      'role?': type('string').atMostLength(40).describe(prompts.tools.spawn_worker.params.role),
      focus: type('string').atLeastLength(10).describe(prompts.tools.spawn_worker.params.focus),
      'model?': type('string').describe(prompts.tools.spawn_worker.params.model),
      'specialist?': type('string').describe(prompts.tools.spawn_worker.params.specialist),
    }),
    async run(args, agent, host) {
      if (!args.specialist && (args.role?.trim().length ?? 0) < 2)
        throw new Error("give the new worker a role, or bring in one of the person's specialists by name")
      return host.spawnWorker(agent, args.role?.trim() ?? '', args.focus, args.model, args.specialist)
    },
  },
  {
    name: 'dismiss_worker',
    tier: 'write',
    description: prompts.tools.dismiss_worker.description,
    parameters: type({ name: type('string'), reason: type('string').atLeastLength(3) }),
    async run(args, agent, host) {
      return host.dismissWorker(agent, args.name, args.reason)
    },
  },
  {
    name: 'update_todo',
    tier: 'write',
    description: prompts.tools.update_todo.description,
    parameters: type({ items: type({ text: type('string').atLeastLength(1), 'done?': 'boolean' }).array() }),
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
      const target = args.url.startsWith('artifact:') ? await artifactUrl(host, args.url.slice(9)) : args.url
      if (!/^(https?|file):/.test(target)) throw new Error('url must be http(s) or artifact:<name>')
      await tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
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
      await tab.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
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
        if (!/^https?:/.test(args.open)) throw new Error('open must be an http(s) URL')
        const page = await openPage(tab)
        await page.goto(args.open, { waitUntil: 'domcontentloaded', timeout: 30_000 })
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
      what: type("'tables' | 'links' | 'items'"),
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
      'only?': type("'failed' | 'api'"),
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
    description: prompts.tools.browser_downloads.description,
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
      ref: type('string'),
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
    parameters: type({ ref: type('string'), text: type('string'), 'submit?': type('boolean') }),
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
    parameters: type({ key: type('string') }),
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
    parameters: type({ 'fullPage?': type('boolean') }),
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
    parameters: type({ expression: type('string') }),
    async run(args, agent, host) {
      const tab = await browserTab(host, agent)
      const value = await tab.page.evaluate(`(async () => (${args.expression}))()`)
      return clip(JSON.stringify(value, null, 2) ?? 'undefined')
    },
  },
  {
    name: 'start_server',
    tier: 'exec',
    description: prompts.tools.start_server.description,
    parameters: type({
      command: type('string').atLeastLength(1),
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
    description: prompts.tools.run_checks.description,
    parameters: type({ 'only?': type('string').describe(prompts.tools.run_checks.params.only) }),
    async run(args, agent, host) {
      if (!host.project) throw new Error('run_checks works in project chats; use shell to run commands here')
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('run_checks needs the OS sandbox')
      const all = host.project.checks
      const picked = pickChecks(all, args.only)
      if (picked.length === 0)
        throw new Error(
          args.only
            ? `this project has no ${args.only} check; it has: ${all.map((c) => c.name).join(', ') || 'none'}`
            : 'this project defines no checks (no scripts in package.json, no Cargo.toml, go.mod or pyproject); use shell',
        )
      const cwd = host.workspace.workdir(agent)
      return clip((await runProjectChecks(host, cwd, writableFor(host, agent), picked)).report)
    },
  },
  {
    name: 'create_tool',
    tier: 'exec',
    description: prompts.tools.create_tool.description(MADE_PREFIX),
    parameters: type({
      name: type('string').describe(prompts.tools.create_tool.params.name),
      description: type('string').describe(prompts.tools.create_tool.params.description),
      inputs: type({
        name: type('string'),
        type: type('string').describe(prompts.tools.create_tool.params.inputType),
        'description?': type('string'),
        'optional?': 'boolean',
      }).array(),
      language: type('string').describe(prompts.tools.create_tool.params.language),
      source: type('string'),
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
      host.toolsChanged()
      return prompts.toolResults.toolCreated(`${MADE_PREFIX}${tool.name}`, r.output)
    },
  },
  {
    name: 'shell',
    tier: 'exec',
    description: prompts.tools.shell.description,
    parameters: type({ command: type('string'), 'timeoutSeconds?': type('number') }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('shell is disabled: no OS sandbox')
      const cwd = host.workspace.workdir(agent)
      const command = await guardProjectCommand(host, agent, 'shell', args.command, true)
      const r = await host.sandbox.run({
        command,
        cwd,
        writable: writableFor(host, agent),
        timeoutMs: Math.min(Math.max(1, args.timeoutSeconds ?? 60), 300) * 1000,
        env: { MYR_MIRROR: host.workspace.mirrorRoot },
      })
      const status = r.timedOut ? 'TIMED OUT' : `exit ${r.code}`
      return clip(`${status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`)
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

/** The colony log as one line per thing an agent did, oldest first, for read_log. */
export function logLines(events: readonly MyrEvent[], filter: { agent?: string; tool?: string }): string[] {
  const calls = new Map<string, number>()
  const out: string[] = []
  const keep = (agent: string, tool?: string) =>
    (!filter.agent || agent === filter.agent) && (!filter.tool || (tool ?? '').includes(filter.tool))
  for (const e of events) {
    const at = e.time.slice(11, 19)
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      if (!keep(p.agent, p.tool)) continue
      calls.set(`${p.agent}/${p.callId}`, out.length)
      out.push(`${at} ${p.agent} ${p.tool}(${firstLine(JSON.stringify(p.args ?? {}), 160)}) → …`)
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const line = calls.get(`${p.agent}/${p.callId}`)
      if (line === undefined) continue
      const outcome = p.ok ? `ok: ${firstLine(p.output, 160)}` : `FAILED: ${firstLine(p.output, 160)}`
      out[line] = `${out[line]?.slice(0, -1)}${outcome}`
    } else if (filter.tool) {
    } else if (e.type === 'task/changed') {
      const p = e.payload as EventPayloads['task/changed']
      if (keep(p.by))
        out.push(
          `${at} ${p.by} ${p.task.id} → ${p.task.status}${p.reason ? ` (${firstLine(p.reason, 120)})` : ''}`,
        )
    } else if (e.type === 'chat/reply') {
      const p = e.payload as EventPayloads['chat/reply']
      if (keep(p.agent)) out.push(`${at} ${p.agent} told the person: ${firstLine(p.text, 160)}`)
    } else if (e.type === 'worktree/merged' || e.type === 'worktree/conflict') {
      const p = e.payload as EventPayloads['worktree/merged']
      if (keep(p.agent))
        out.push(
          `${at} ${p.agent} ${e.type === 'worktree/merged' ? 'merged' : 'conflicted on'} ${p.files.join(', ')}`,
        )
    }
  }
  return out
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
  const spent = Object.values(s.agents).reduce((n, a) => n + a.cost, 0)
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
    }[ext ?? ''] ?? 'text/plain'
  )
}

/**
 * Wraps tool definitions as pi-agent-core tools for one agent. The allowlist and tier rules are
 * enforced here, inside execution, so hiding a tool from the model is never the only defence.
 */
/** Tools matching a find_tools query: exact names first, then by how many query words a name or description holds. */
export function matchTools(tools: readonly AgentTool[], query: string, limit = 12): AgentTool[] {
  const q = query.toLowerCase()
  const exact = tools.filter((t) => q.split(/[\s,]+/).includes(t.name.toLowerCase()))
  const words = q.split(/[^a-z0-9_]+/).filter((w) => w.length > 1)
  const scored = tools
    .map((t) => {
      const text = `${t.name} ${t.description}`.toLowerCase()
      return {
        t,
        score: words.filter((w) => text.includes(w)).length + (t.name.toLowerCase().includes(q) ? 3 : 0),
      }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t)
  return [...new Set([...exact, ...scored])].slice(0, limit)
}

export function buildAgentTools(agent: string, allowed: readonly string[], host: ColonyHost): AgentTool[] {
  const allow = new Set(allowed)
  const mcp = allow.has('mcp')
    ? [...host.mcpTools(), ...host.pluginTools(agent)]
        // A single MCP tool switched off in Settings is left out like any disabled tool.
        .filter((t) => !host.spec.disabledTools?.includes(t.name))
        .map((t) => logged(agent, t, host))
    : []
  // Scripts run in the sandbox, so they need shell; browser flows drive the agent's browser.
  const scripts = allow.has('shell') && (host.sandbox.kind !== 'none' || host.unsafeNoSandbox)
  const browsing = allow.has('browser_open') && host.browser !== undefined
  const made = Object.values(host.state().madeTools)
    .filter((t) => (t.language === 'browser' ? browsing : scripts))
    .map((t) => logged(agent, madeTool(agent, t, host), host))
  return [...harnessTools(agent, allow, host), ...mcp, ...made]
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
        await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
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
          const readOnly = tool.name.startsWith('mcp__') && host.mcpReadOnly(tool.name)
          const edited = await askFirst(host, agent, tool.name, params, readOnly, key)
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

function harnessTools(agent: string, allow: ReadonlySet<string>, host: ColonyHost): AgentTool[] {
  return TOOL_DEFS.filter((d) => allow.has(d.name))
    .filter((d) => d.tier !== 'exec' || host.sandbox.kind !== 'none' || host.unsafeNoSandbox)
    .map(
      (def): AgentTool => ({
        name: def.name,
        label: def.name,
        description: def.description,
        parameters: def.parameters,
        intent: 'omit',
        approval: def.tier,
        async execute(callId: string, params: unknown): Promise<AgentToolResult> {
          const actor = agentActor(agent)
          await host.append({
            type: 'tool/call',
            actor,
            payload: { agent, callId, tool: def.name, args: params ?? {} },
          })
          let output: string
          let images: ToolOutput['images'] = []
          let ok = true
          // Calls that write get receipts; commands may rightly run twice, and reads change nothing.
          const key = def.tier === 'write' ? receiptKey(host, agent, def.name, params) : undefined
          const kept = key === undefined ? undefined : host.state().receipts[key]
          try {
            if (!allow.has(def.name)) throw new Error(`${def.name} is not allowed for ${agent}`)
            if (host.state().status !== 'running') throw new Error('the colony is no longer running')
            if (host.huddling() && !HUDDLE_TOOLS.has(def.name)) throw new Error(prompts.toolResults.huddling)
            if (kept !== undefined) throw new AlreadyDone(kept)
            if (COPY_CHECKED.has(def.name)) await flagIfCopied(host, agent, def.name, params)
            const readOnly = def.tier === 'read' || COLONY_ONLY.has(def.name)
            const edited = await askFirst(host, agent, def.name, params, readOnly, key)
            await host.beforeTool(agent, def.name, params)
            const run = () => def.run(params ?? {}, agent, host)
            const result = def.tier === 'read' ? await run() : await inCallOrder(host, agent, run)
            output = typeof result === 'string' ? result : result.text
            // The person's hooks speak for the harness: their note stays outside any untrusted-content block.
            const hookNote = await host.afterTool(agent, def.name, params, output)
            if (typeof result !== 'string') images = result.images
            const preface = typeof result === 'string' ? '' : (result.preface ?? '')
            // Long pages are saved under web/ in scratch; reading one back is still outside content.
            const savedPage =
              def.name === 'fs_read' && /(^|\/)web\//.test(String((params as { path?: unknown })?.path ?? ''))
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
            payload: { agent, callId, tool: def.name, ok, output: clip(output, 8_000) },
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
