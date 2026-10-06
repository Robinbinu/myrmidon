import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ColonyState, EventDraft, EventPayloads, TaskSnapshot } from '@myrmidon/protocol'
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { type } from '@oh-my-pi/pi-ai'
import * as natives from '@oh-my-pi/pi-natives'
import chatDoc from '../docs/chat.md' with { type: 'text' }
import coordinationDoc from '../docs/coordination.md' with { type: 'text' }
import limitsDoc from '../docs/limits.md' with { type: 'text' }
import modesDoc from '../docs/modes.md' with { type: 'text' }
import overviewDoc from '../docs/overview.md' with { type: 'text' }
import verificationDoc from '../docs/verification.md' with { type: 'text' }
import workingDoc from '../docs/working.md' with { type: 'text' }
import {
  assertAgentControl,
  type BrowserTab,
  doneWith,
  pageElement,
  pageSnapshot,
  pointAt,
  refLabel,
  watched,
} from './browser.ts'
import { agentActor, type ColonyHost } from './host.ts'
import {
  checkedArgs,
  checkedTool,
  inputSchema,
  MADE_PREFIX,
  type MadeTool,
  scriptCommand,
} from './made-tools.ts'
import { toolsFor } from './patterns.ts'
import type { ProjectCheck } from './project-context.ts'
import { assertArtifactName, SKIP_DIRS } from './workspace.ts'

const MAX_ARTIFACT_BYTES = 512 * 1024
/** Most matches grep returns, and most paths glob lists, so a broad search does not flood the context. */
const GREP_LIMIT = 100
const GLOB_LIMIT = 200
/** How much of a fetched page enters the conversation; the rest is saved to a scratch file. */
const PAGE_EXCERPT = 8_000

/** A short, stable file name for a fetched URL. */
function pageFileName(url: string): string {
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${slug || 'page'}-${Bun.hash(url).toString(36).slice(0, 6)}`
}
const MAX_READ_CHARS = 40_000

type Tier = 'read' | 'write' | 'exec'

/** A tool result with pictures attached, for models that can see them (others get a placeholder). */
interface ToolOutput {
  readonly text: string
  readonly images: readonly { readonly data: string; readonly mimeType: string }[]
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

const MENTION = /@([a-z][a-z0-9-]{0,31})/g

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
  const tab = await host.browser.tab(host.id, agent)
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
  'read_board',
  'read_notes',
  'list_agents',
  'list_tasks',
  'list_artifacts',
  'read_artifact',
  'observe',
  'read_docs',
  'post',
  'send_mail',
  'read_mail',
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

/** A write to a file in the project folder (not scratch) follows the project's permissions. */
async function guardProjectEdit(host: ColonyHost, agent: string, tool: string, path: string) {
  const project = host.spec.chat?.project
  const mode = project?.permissions?.mode ?? 'auto'
  if (!project || mode === 'auto') return
  const scratch = host.workspace.scratch(agent)
  const inProject =
    (path === project.path || path.startsWith(`${project.path}/`)) && !path.startsWith(`${scratch}/`)
  if (!inProject) return
  const where = relative(project.path, path)
  if (mode === 'read-only')
    throw new Error(
      `${project.name} is read-only for agents: you can read it but not change ${where}. Put drafts in your scratch directory and describe the change instead.`,
    )
  if (!(await host.requestApproval(agent, tool, `${tool === 'fs_edit' ? 'edit' : 'write'} ${where}`)))
    throw new Error(
      `the person did not approve changing ${where}; ask them (ask_user) or take another approach`,
    )
}

/** In an "ask" project, a command runs only if it starts with an allowed prefix or the person approves it. */
async function guardProjectCommand(host: ColonyHost, agent: string, tool: string, command: string) {
  const permissions = host.spec.chat?.project?.permissions
  if (permissions?.mode !== 'ask') return
  const line = command.trim()
  // "bun test && rm -rf src" starts with an allowed prefix but runs more: anything chained, piped, substituted or
  // redirected always asks.
  const simple = !/[;&|`<>\n]|\$\(/.test(line)
  if (simple && permissions.allow.some((prefix) => line === prefix || line.startsWith(`${prefix} `))) return
  if (!(await host.requestApproval(agent, tool, line.length > 300 ? `${line.slice(0, 300)}…` : line)))
    throw new Error('the person did not approve this command; ask them (ask_user) or take another approach')
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
    description: 'Read the colony mission, acceptance criteria, deadline, and roster.',
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
    name: 'read_board',
    tier: 'read',
    description: 'Read the most recent shared board posts.',
    parameters: type({ 'limit?': type('number').describe('How many recent posts (default 30)') }),
    async run(args, _agent, host) {
      const posts = host.state().board.slice(-(args.limit ?? 30))
      return posts.map((p) => `#${p.seq} ${p.agent}: ${p.text}`).join('\n') || '(board is empty)'
    },
  },
  {
    name: 'post',
    tier: 'write',
    description:
      'Post a short message everyone on the team can read: announcements, blockers, decisions others need. Mention ' +
      '@name to wake someone. For one-to-one detail use send_mail; for lasting knowledge use append_note.',
    parameters: type({ text: type('string').describe('Message text').atLeastLength(1) }),
    async run(args, agent, host) {
      const known = new Set(Object.keys(host.state().agents))
      const mentions = [...new Set([...args.text.matchAll(MENTION)].map((m) => m[1] as string))].filter((m) =>
        known.has(m),
      )
      const e = await host.append({
        type: 'board/posted',
        actor: agentActor(agent),
        payload: { agent, text: args.text, mentions },
      })
      return `posted #${e.seq}${mentions.length ? ` (notified ${mentions.join(', ')})` : ''}`
    },
  },
  {
    name: 'append_note',
    tier: 'write',
    description:
      'Append to the shared notes, the team\'s lasting memory for this round. Use "finding" for facts others can ' +
      'reuse (with sources), "decision" for choices and assumptions, "plan" for the single plan (one per colony), ' +
      '"status" sparingly. Notes are append-only: to fix one, append a new note with `corrects` set to its id.',
    parameters: type({
      text: type('string').atLeastLength(1),
      'section?': type("'plan' | 'decision' | 'finding' | 'status'"),
      'corrects?': type('string').describe('Event id of the note this one corrects'),
    }),
    async run(args, agent, host) {
      const e = first(
        await host.appendAtomic((s) => {
          const plan = s.notes.find((n) => n.section === 'plan')
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
    description: 'Read all shared notes in order.',
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
    name: 'send_mail',
    tier: 'write',
    description:
      'Send a direct message to one agent (wakes it). Use for detail only it needs: a handoff, a question about its ' +
      'output, a correction. Do not use it to ask for status; task changes and verdicts are announced automatically.',
    parameters: type({
      to: type('string'),
      'subject?': type('string'),
      body: type('string').atLeastLength(1),
    }),
    async run(args, agent, host) {
      if (!host.state().agents[args.to]) throw new Error(`no such agent: ${args.to}`)
      if (args.to === agent) throw new Error('you cannot mail yourself')
      await host.append({
        type: 'mail/sent',
        actor: agentActor(agent),
        payload: { from: agent, to: args.to, subject: args.subject ?? '', body: args.body },
      })
      return `mail sent to ${args.to}`
    },
  },
  {
    name: 'read_mail',
    tier: 'read',
    description: 'Read mail sent to you.',
    parameters: type({ 'limit?': type('number') }),
    async run(args, agent, host) {
      const mail = host
        .state()
        .mail.filter((m) => m.to === agent)
        .slice(-(args.limit ?? 20))
      return (
        mail.map((m) => `from ${m.from}${m.subject ? ` [${m.subject}]` : ''}: ${m.body}`).join('\n') ||
        '(no mail)'
      )
    },
  },
  {
    name: 'list_agents',
    tier: 'read',
    description: 'List agents with their status, role, and current task.',
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
    description: 'List all tasks with status, owner, revision, and blockers.',
    parameters: type({}),
    async run(_args, _agent, host) {
      const tasks = Object.values(host.state().tasks).filter((t) => t.status !== 'deleted')
      return tasks.map(taskLine).join('\n') || '(no tasks yet)'
    },
  },
  {
    name: 'create_task',
    tier: 'write',
    description:
      'Create a task on the shared task graph. The description is the whole brief the doer gets, so make it stand ' +
      'alone: Objective, Deliverable (files and format), Approach (steps, sources, constraints, quality bar), Done ' +
      'when (checks it must pass), Not in scope. `assignee` wakes only that agent; `outputs` names the files it will ' +
      'produce (nobody else may publish them meanwhile); blockedBy only for real dependencies. Create independent ' +
      'tasks in the same step so they run in parallel.',
    parameters: type({
      subject: type('string').atLeastLength(1),
      'description?': type('string'),
      'assignee?': type('string').describe('Agent to do it; it is woken with the task'),
      'outputs?': type('string').array().describe('Artifact names this task will produce'),
      'blockedBy?': type('string').array().describe('Task ids that must be verified first'),
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
    description: 'Claim a pending or rejected task. Pass the revision you read; stale claims are refused.',
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
      return `claimed ${taskLine((e.payload as EventPayloads['task/changed']).task)}`
    },
  },
  {
    name: 'assign_task',
    tier: 'write',
    description: 'Give a pending or rejected task to an agent; it is woken with the task.',
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
    description: 'Give up a task you own so someone else can claim it.',
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
    name: 'submit_task',
    tier: 'write',
    description:
      'Submit a task you own for verification, listing the published artifacts that complete it. Check them against ' +
      'the task first (re-read its Done when); a reviewer verifies them and a rejection comes back with reasons.',
    parameters: type({ id: type('string'), revision: type('number'), artifacts: type('string').array() }),
    async run(args, agent, host) {
      if (args.id === 'task-final') throw new Error(FINAL_HINT)
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
      return `${args.id} submitted; the verifier will report back`
    },
  },
  {
    name: 'publish_artifact',
    tier: 'write',
    description:
      'Publish a deliverable file for the person (a new version if it exists; earlier versions are kept). Publish ' +
      'finished, working files only, not drafts or notes to yourself; use a clear name with the right extension ' +
      '(report.md, index.html, src/app.ts). Give `content`, or `fromScratch` to publish a file you built and tested ' +
      'in your scratch directory.',
    parameters: type({
      name: type('string').describe('Artifact path, e.g. index.html or src/app.ts'),
      'content?': type('string'),
      'fromScratch?': type('string').describe(
        'Path of a file in your working directory (or scratch) to publish',
      ),
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
    description: 'Read an artifact (latest version unless `version` is given).',
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
    description: 'List artifacts and their latest versions.',
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
    description: 'Check time left, budget, idle agents, and unclaimed or blocked tasks.',
    parameters: type({}),
    async run(_args, _agent, host) {
      return observeFacts(host)
    },
  },
  {
    name: 'request_final_verification',
    tier: 'write',
    description:
      'Ask the verifier to check the colony output against the acceptance criteria. The colony completes only if every check passes.',
    parameters: type({ summary: type('string').describe('What was built and where') }),
    async run(args, agent, host) {
      return host.requestFinalVerification(agent, args.summary)
    },
  },
  {
    name: 'fs_write',
    tier: 'write',
    description:
      'Write a whole file in your working directory (the project, when the chat has one; otherwise your scratch). ' +
      'To change part of an existing file, use fs_edit.',
    parameters: type({ path: type('string'), content: type('string') }),
    async run(args, agent, host) {
      const path = host.workspace.resolveInWorkdir(agent, args.path)
      await guardProjectEdit(host, agent, 'fs_write', path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, args.content)
      return `wrote ${args.path} (${Buffer.byteLength(args.content)} bytes)`
    },
  },
  {
    name: 'fs_edit',
    tier: 'write',
    description:
      'Change part of a file in your working directory by replacing an exact snippet, instead of rewriting the whole ' +
      'file. `old` must appear exactly once (copy it from fs_read, with enough surrounding lines to be unique); set ' +
      '`all` to replace every occurrence. Make several edits in one step for several changes.',
    parameters: type({
      path: type('string'),
      old: type('string').atLeastLength(1),
      new: type('string'),
      'all?': type('boolean'),
    }),
    async run(args, agent, host) {
      const path = host.workspace.resolveInWorkdir(agent, args.path)
      await guardProjectEdit(host, agent, 'fs_edit', path)
      const text = readFileSync(path, 'utf8')
      const count = text.split(args.old).length - 1
      if (count === 0)
        throw new Error(`old text not found in ${args.path}; re-read the file and copy the snippet exactly`)
      if (count > 1 && !args.all)
        throw new Error(
          `old text appears ${count} times in ${args.path}; include more surrounding lines, or set all`,
        )
      writeFileSync(
        path,
        args.all ? text.split(args.old).join(args.new) : text.replace(args.old, () => args.new),
      )
      return `edited ${args.path} (${args.all ? count : 1} replacement${count > 1 && args.all ? 's' : ''})`
    },
  },
  {
    name: 'fs_read',
    tier: 'read',
    description:
      'Read a file in your working directory (the project, when the chat has one) or your scratch directory.',
    parameters: type({ path: type('string') }),
    async run(args, agent, host) {
      return clip(readFileSync(host.workspace.resolveInWorkdir(agent, args.path), 'utf8'))
    },
  },
  {
    name: 'fs_list',
    tier: 'read',
    description:
      'List files in your working directory (the project, when the chat has one; otherwise your scratch directory). ' +
      'Dependency and build folders (node_modules, .git, dist, ...) are skipped.',
    parameters: type({ 'path?': type('string') }),
    async run(args, agent, host) {
      const root = host.workspace.workdir(agent)
      const dir = host.workspace.resolveInWorkdir(agent, args.path ?? '.')
      const out: string[] = []
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name === '.tmp' || SKIP_DIRS.has(entry.name) || out.length > 500) continue
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
    description:
      'Search file contents in your working directory with a regular expression (ripgrep syntax), respecting ' +
      '.gitignore. Use it to find where something is defined or used before reading files: function names, error ' +
      'strings, config keys, imports. Narrow with `glob` (e.g. "*.ts") and widen with `context` lines. For finding ' +
      'files by name use glob; for reading a whole file use fs_read.',
    parameters: type({
      pattern: type('string').atLeastLength(1).describe('Regular expression, e.g. "function\\s+parseSlash"'),
      'path?': type('string').describe('Folder or file to search, relative to your working directory'),
      'glob?': type('string').describe('Only files matching this, e.g. "*.tsx" or "src/**/*.ts"'),
      'ignoreCase?': 'boolean',
      'context?': type('number').describe('Lines of context around each match (default 0, max 5)'),
      'filesOnly?': type('boolean').describe('List matching files instead of lines'),
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
    description:
      'Find files by name pattern in your working directory, newest first, respecting .gitignore: "**/*.test.ts", ' +
      '"src/**/Button*", "*.md". Use it to locate files before reading them; fs_list shows a whole folder instead.',
    parameters: type({
      pattern: type('string').atLeastLength(1),
      'path?': type('string').describe('Folder to search, relative to your working directory'),
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
    description:
      'Search the web for current information. Returns a synthesized answer with citations, or ranked results with ' +
      'titles, URLs, dates, and snippets. Start broad (2-6 words), then narrow with what you learn; run several ' +
      'independent searches in the same step. Use recency for fast-moving topics. Snippets are not enough to cite ' +
      'numbers or quotes: open the source with web_fetch. Skip it for things you know reliably.',
    parameters: type({
      query: type('string').atLeastLength(2),
      'limit?': type('number').describe('Max results (default 6, max 10)'),
      'recency?': type("'day' | 'week' | 'month' | 'year'").describe('Only results from this period'),
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
        ? `Note: your query names ${stale.join(', ')}, but today is ${new Date().toISOString().slice(0, 10)}. Results from then may be out of date; search for current information unless you need the past.\n\n`
        : ''
      return clip(`${note}${text.trim() || `No results for "${args.query}".`}`)
    },
  },
  {
    name: 'web_fetch',
    tier: 'read',
    description:
      'Read a public URL in full as clean text. Web pages, PDFs and documents, GitHub repos/issues, npm/PyPI packages, ' +
      'arXiv papers, Stack Overflow, and more get dedicated readers. Use it to verify a fact or number before you rely ' +
      'on it, and prefer primary sources (official docs, the original paper or announcement) over summaries.',
    parameters: type({ url: type('string').describe('http(s) URL') }),
    async run(args, agent, host) {
      const page = await host.web.read(args.url)
      const head = `Source: ${page.url} (${page.method}, ${page.contentType})`
      if (page.output.length <= PAGE_EXCERPT) return `${head}\n\n${page.output}`
      // Like Manus: keep context small and the rest recoverable. The full page goes to a scratch file the agent
      // can read or grep, and only an excerpt enters the conversation.
      const self = host.spec.agents.find((a) => a.name === agent)
      if (!self || !toolsFor(host.spec, self).includes('fs_read'))
        return clip(`${head}\n\n${page.output}`, 16_000)
      const name = `web/${pageFileName(page.url)}.md`
      const path = host.workspace.resolveInScratch(agent, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${head}\n\n${page.output}`)
      // In a project the shell starts in the project, so point at the scratch copy by its full path.
      const where = host.workspace.project ? path : name
      return `${head}\n(${page.output.length} chars; the full text is saved as ${where}: fs_read it, or grep -n "term" ${where} in the shell)\n\n${page.output.slice(0, PAGE_EXCERPT)}\n…`
    },
  },
  {
    name: 'reply_user',
    tier: 'write',
    description:
      'Send a message to the person. final: true is the complete answer and starts verification automatically. ' +
      'Use ask_user for a question you need answered.',
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
    name: 'ask_user',
    tier: 'write',
    description:
      'Ask the person something the colony cannot proceed without. The round pauses until they answer; stop working ' +
      'after asking. Only for real blockers: otherwise make a sensible assumption and say so.',
    parameters: type({ question: type('string').atLeastLength(3) }),
    async run(args, agent, host) {
      const last = host.state().chatMessages.at(-1)
      if (last?.question) throw new Error('a question to the person is already open; wait for the answer')
      await host.append({
        type: 'chat/reply',
        actor: agentActor(agent),
        payload: { agent, text: args.question, final: false, question: true },
      })
      return 'question sent; the round pauses until the person answers. Stop now.'
    },
  },
  {
    name: 'read_docs',
    tier: 'read',
    description:
      'Read the Myrmidon harness docs: how this colony runs, how to do excellent work here, team modes, tasks and ' +
      'notes, verification, talking to the person, limits, and every tool. Call with no page to list them.',
    parameters: type({
      'page?': type('string').describe('overview, modes, coordination, verification, chat, limits, or tools'),
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
    description:
      'Add a specialist worker for a kind of work no current teammate covers. Describe its role and focus and pick ' +
      'the model that fits; it gets a call sign (returned) and sleeps until you assign it a task.',
    parameters: type({
      role: type('string')
        .atLeastLength(2)
        .atMostLength(40)
        .describe('Short role, e.g. researcher or frontend'),
      focus: type('string').atLeastLength(10).describe('What this worker is responsible for'),
      'model?': type('string').describe('One of the allowed worker models; defaults to the first'),
    }),
    async run(args, agent, host) {
      return host.spawnWorker(agent, args.role, args.focus, args.model)
    },
  },
  {
    name: 'dismiss_worker',
    tier: 'write',
    description:
      'Let a worker go when this conversation no longer needs its skill. It stops now (its open tasks are released) ' +
      'and does not join later rounds. Workers you keep stay with you, with their memory, across the conversation.',
    parameters: type({ name: type('string'), reason: type('string').atLeastLength(3) }),
    async run(args, agent, host) {
      return host.dismissWorker(agent, args.name, args.reason)
    },
  },
  {
    name: 'update_todo',
    tier: 'write',
    description:
      'Your working checklist for multi-step work, like a todo.md: write the whole list each time, marking finished ' +
      'items done. It is echoed back so your goals stay in view as the work grows, and stopping with open items gets ' +
      'you a reminder. Use it for jobs of three or more steps; skip it for one-step answers.',
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
    description:
      'Open a URL in your browser tab (a real headless Chrome) and get the page as an accessibility snapshot with ' +
      'element refs. Use it for pages that need JavaScript, interaction, or a visual check; for reading static ' +
      'pages web_fetch is faster. `artifact:<name>` opens a file the colony published (e.g. artifact:index.html), ' +
      'to test what you built.',
    parameters: type({ url: type('string').describe('http(s) URL, or artifact:<name>') }),
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
    name: 'browser_snapshot',
    tier: 'read',
    description:
      'Read your browser tab again as an accessibility snapshot. Take one after anything changes the page; element ' +
      'refs (e1, e2, ...) from older snapshots stop working after navigation or re-rendering.',
    parameters: type({}),
    async run(_args, agent, host) {
      return pageSnapshot(await browserTab(host, agent))
    },
  },
  {
    name: 'browser_click',
    tier: 'write',
    description: 'Click an element by its ref from the latest snapshot. Returns the new snapshot.',
    parameters: type({ ref: type('string').describe('e.g. e12') }),
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
    description:
      'Type into a field by its ref (replacing what is there). Set submit to press Enter afterwards. Returns the new ' +
      'snapshot. Never type passwords, payment details, or other secrets.',
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
    description:
      'Press a key in the page (Enter, Escape, Tab, ArrowDown, PageDown, ...). Returns the new snapshot.',
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
    description:
      'Screenshot your browser tab (the viewport, or the whole page with fullPage) to check layout and visual ' +
      'quality. Models that can see images get the picture.',
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
    description:
      'Console messages, uncaught page errors, failed requests, and HTTP errors from your tab since you last asked. ' +
      'Check it after opening a page you built: a clean console is part of done.',
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
    description:
      'Evaluate a JavaScript expression in the page and get the result as JSON, e.g. ' +
      '`document.querySelectorAll("li").length` or `[...document.links].map(a => a.href)`. Runs in the page only.',
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
    description:
      "Start a long-running process, usually the project's dev server (e.g. `bun run dev`, `npm run dev`, " +
      '`python -m http.server 8000`), in the sandbox. It returns once the server answers: on `port` if you give one ' +
      '(it is also passed as $PORT), otherwise at the first local URL the command prints. Then open that URL with ' +
      'browser_open to check the app the way a person would; the person can watch it in the Computer view. Read ' +
      'output with server_logs; stop it with stop_server. Never use shell for servers: shell waits for commands to end.',
    parameters: type({
      command: type('string').atLeastLength(1),
      'name?': type('string').describe('Short name, e.g. "web" (default "dev")'),
      'port?': type('number').describe('Port it listens on, if known'),
    }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('servers need the OS sandbox')
      const name = (args.name ?? 'dev').trim()
      if (!/^[a-z0-9][a-z0-9-]{0,20}$/i.test(name))
        throw new Error('name: letters, digits and dashes, up to 21')
      if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535))
        throw new Error('port must be between 1024 and 65535')
      await guardProjectCommand(host, agent, 'start_server', args.command)
      const url = await host.startServer(agent, name, args.command, args.port)
      return `${name} is serving at ${url}. Open it with browser_open; read its output with server_logs.`
    },
  },
  {
    name: 'server_logs',
    tier: 'read',
    description:
      'The latest output (stdout and stderr) of a server you started with start_server: build errors, requests, crashes.',
    parameters: type({ 'name?': type('string').describe('Default "dev"') }),
    async run(args, _agent, host) {
      const out = host.serverLogs((args.name ?? 'dev').trim())
      return clip(out.trim().split('\n').slice(-200).join('\n') || '(no output yet)')
    },
  },
  {
    name: 'stop_server',
    tier: 'exec',
    description: 'Stop a server you started with start_server. Servers also stop when the round ends.',
    parameters: type({ 'name?': type('string').describe('Default "dev"') }),
    async run(args, agent, host) {
      const name = (args.name ?? 'dev').trim()
      await host.stopServer(name, `stopped by ${agent}`)
      return `stopped ${name}`
    },
  },
  {
    name: 'run_checks',
    tier: 'exec',
    description:
      "Run the project's own checks in the sandbox and get a short pass/fail summary with the failing output: its " +
      '`check` script if it has one, otherwise typecheck, lint and test (whatever its package.json, Cargo.toml, go.mod ' +
      'or pyproject defines). Run it after you change code and before you say you are done, then fix what fails. ' +
      '`only` runs one check by name (e.g. "test", or "build", which is never run by default).',
    parameters: type({ 'only?': type('string').describe('check, typecheck, lint, test, or build') }),
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
    description:
      'Make a reusable tool for work you (or your team) will repeat: a short script with typed inputs, which then ' +
      `appears as ${MADE_PREFIX}<name> for every agent with shell in this colony. Use it when the same multi-step ` +
      'command or parsing job comes up more than once (convert a CSV, query an API, check a page, score output); ' +
      'for one-off work just use shell. The script reads its inputs as JSON from the MYR_INPUT environment variable ' +
      'and prints its result to stdout; a non-zero exit means failure. It runs in the same sandbox as shell. ' +
      '`test` is a JSON object of example inputs: the tool is run with it once and is only created if that run ' +
      "succeeds. Calling create_tool again with your own tool's name replaces it.",
    parameters: type({
      name: type('string').describe('snake_case, e.g. csv_to_json'),
      description: type('string').describe('What it does and when to use it'),
      inputs: type({
        name: type('string'),
        type: type('string').describe('string, number or boolean'),
        'description?': type('string'),
        'optional?': 'boolean',
      }).array(),
      language: type('string').describe('typescript (run with bun), python, or bash'),
      source: type('string'),
      test: type('string').describe('JSON object of example inputs, e.g. {"path": "data.csv"}'),
    }),
    async run(args, agent, host) {
      const tool = checkedTool(args)
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
      return `Created ${MADE_PREFIX}${tool.name}; the team can call it now. Test run:\n${r.output}`
    },
  },
  {
    name: 'shell',
    tier: 'exec',
    description:
      'Run a shell command in the OS sandbox. It starts in your working directory (the project, when the chat has ' +
      'one; otherwise your scratch) and may write only there and in your scratch. Use it to ' +
      'build and test what you make: run scripts and tests, install packages locally, check syntax (node --check, ' +
      'python -m py_compile, bun build), and inspect output. Published artifacts are readable at $MYR_MIRROR/artifacts. ' +
      'Read errors carefully and fix the cause rather than retrying the same command.',
    parameters: type({ command: type('string'), 'timeoutSeconds?': type('number') }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('shell is disabled: no OS sandbox')
      const cwd = host.workspace.workdir(agent)
      await guardProjectCommand(host, agent, 'shell', args.command)
      const r = await host.sandbox.run({
        command: args.command,
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
  return [
    `time left: ${left}s of ${Math.round(s.budget.wallMs / 1000)}s`,
    s.budget.costUsd !== undefined ? `cost: $${spent.toFixed(3)} of $${s.budget.costUsd}` : null,
    `tasks: ${tasks.length} total, unclaimed ${pending.join(', ') || 'none'}, blocked ${blocked.join(', ') || 'none'}, rejected ${rejected.join(', ') || 'none'}`,
    `idle agents: ${idle.join(', ') || 'none'}`,
    `artifacts: ${Object.keys(s.artifacts).join(', ') || 'none'}`,
    `final verifications: ${s.verdicts.filter((v) => v.target === 'colony').length} run, last ${s.verdicts.filter((v) => v.target === 'colony').at(-1)?.pass ? 'passed' : 'not passed'}`,
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
export function buildAgentTools(agent: string, allowed: readonly string[], host: ColonyHost): AgentTool[] {
  const allow = new Set(allowed)
  const mcp = allow.has('mcp') ? host.mcpTools().map((t) => logged(agent, t, host)) : []
  const made =
    allow.has('shell') && (host.sandbox.kind !== 'none' || host.unsafeNoSandbox)
      ? Object.values(host.state().madeTools).map((t) => logged(agent, madeTool(agent, t, host), host))
      : []
  return [...harnessTools(agent, allow, host), ...mcp, ...made]
}

/** Runs a made tool's script in the caller's sandbox, with its inputs as JSON in MYR_INPUT. */
async function runMadeTool(
  tool: MadeTool,
  input: Record<string, unknown>,
  agent: string,
  host: ColonyHost,
): Promise<{ ok: boolean; output: string }> {
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

/** An MCP tool, recorded in the log like the harness's own tools and refused once the colony has ended. */
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
        payload: { agent, callId, tool: tool.name, args: params ?? {} },
      })
      let result: AgentToolResult
      try {
        if (host.state().status !== 'running') throw new Error('the colony is no longer running')
        if (host.huddling())
          throw new Error('the swarm is still huddling: post your proposal (post) and stop')
        result = await tool.execute(callId, params as never, signal)
      } catch (err) {
        result = {
          content: [{ type: 'text', text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
      await host.append({
        type: 'tool/result',
        actor,
        payload: { agent, callId, tool: tool.name, ok: !result.isError, output: clip(text, 8_000) },
      })
      return result
    },
  } as AgentTool
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
          try {
            if (!allow.has(def.name)) throw new Error(`${def.name} is not allowed for ${agent}`)
            if (host.state().status !== 'running') throw new Error('the colony is no longer running')
            if (host.huddling() && !HUDDLE_TOOLS.has(def.name))
              throw new Error(
                'the swarm is still huddling: post your proposal (post) and stop; work starts once every peer has proposed',
              )
            const run = () => def.run(params ?? {}, agent, host)
            const result = def.tier === 'read' ? await run() : await inCallOrder(host, agent, run)
            output = typeof result === 'string' ? result : result.text
            if (typeof result !== 'string') images = result.images
          } catch (err) {
            ok = false
            output = `ERROR: ${err instanceof Error ? err.message : String(err)}`
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
