import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import type { ColonyState, EventDraft, EventPayloads, TaskSnapshot } from '@myrmidon/protocol'
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { type } from '@oh-my-pi/pi-ai'
import chatDoc from '../docs/chat.md' with { type: 'text' }
import coordinationDoc from '../docs/coordination.md' with { type: 'text' }
import limitsDoc from '../docs/limits.md' with { type: 'text' }
import modesDoc from '../docs/modes.md' with { type: 'text' }
import overviewDoc from '../docs/overview.md' with { type: 'text' }
import verificationDoc from '../docs/verification.md' with { type: 'text' }
import { agentActor, type ColonyHost } from './host.ts'
import { toolsFor } from './patterns.ts'
import { assertArtifactName } from './workspace.ts'

const MAX_ARTIFACT_BYTES = 512 * 1024
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
 * Tool calls from one assistant message run concurrently, but an agent planning several tasks at once
 * expects them to be created in the order it wrote them, so later ones can name earlier ids in blockedBy.
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
    description: 'Post to the shared board. Mention agents with @name to wake them.',
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
      'Append to the shared notes. Notes are append-only: to fix a note, append a new one with `corrects` set to its id. ' +
      'section: "plan" (only one per colony), "decision", "finding", or "status".',
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
    description: 'Send a direct message to one agent. It wakes the recipient.',
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
      'Create a task on the shared task graph. `assignee` wakes only that agent; `outputs` names the files the task ' +
      'will produce (nobody else may publish them while it is in progress).',
    parameters: type({
      subject: type('string').atLeastLength(1),
      'description?': type('string'),
      'assignee?': type('string').describe('Agent to do it; it is woken with the task'),
      'outputs?': type('string').array().describe('Artifact names this task will produce'),
      'blockedBy?': type('string').array().describe('Task ids that must be verified first'),
    }),
    async run(args, agent, host) {
      const e = first(
        await inCallOrder(host, agent, () =>
          host.appendAtomic((s) => {
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
                  t.status !== 'deleted' &&
                  t.status !== 'verified' &&
                  similar(t.subject, args.subject) >= 0.6,
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
        ),
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
    description: 'Submit a task you own for verification, listing the artifacts that complete it.',
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
      'Publish a new version of a shared artifact (a file of the colony output). Earlier versions are kept. ' +
      'Give `content`, or `fromScratch` to publish a file from your scratch directory.',
    parameters: type({
      name: type('string').describe('Artifact path, e.g. index.html or src/app.ts'),
      'content?': type('string'),
      'fromScratch?': type('string').describe('Path inside your scratch directory'),
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
        bytes = readFileSync(host.workspace.resolveInScratch(agent, args.fromScratch))
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
    description: 'Write a file in your private scratch directory.',
    parameters: type({ path: type('string'), content: type('string') }),
    async run(args, agent, host) {
      const path = host.workspace.resolveInScratch(agent, args.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, args.content)
      return `wrote ${args.path} (${Buffer.byteLength(args.content)} bytes)`
    },
  },
  {
    name: 'fs_read',
    tier: 'read',
    description: 'Read a file in your private scratch directory.',
    parameters: type({ path: type('string') }),
    async run(args, agent, host) {
      return clip(readFileSync(host.workspace.resolveInScratch(agent, args.path), 'utf8'))
    },
  },
  {
    name: 'fs_list',
    tier: 'read',
    description: 'List files in your private scratch directory.',
    parameters: type({ 'path?': type('string') }),
    async run(args, agent, host) {
      const root = host.workspace.scratch(agent)
      const dir = host.workspace.resolveInScratch(agent, args.path ?? '.')
      const out: string[] = []
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name === '.tmp' || out.length > 500) continue
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
    name: 'web_search',
    tier: 'read',
    description:
      'Search the web. Returns an answer synthesized from current sources with citations, or ranked results ' +
      'with titles, URLs, and snippets. Use web_fetch to read a source in full.',
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
      return clip(text.trim() || `No results for "${args.query}".`)
    },
  },
  {
    name: 'web_fetch',
    tier: 'read',
    description:
      'Read a public URL as clean text: web pages, PDFs and documents, GitHub repos/issues, npm/PyPI packages, ' +
      'arXiv papers, Stack Overflow, and more get dedicated readers.',
    parameters: type({ url: type('string').describe('http(s) URL') }),
    async run(args, _agent, host) {
      const page = await host.web.read(args.url)
      return clip(`Source: ${page.url} (${page.method}, ${page.contentType})\n\n${page.output}`)
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
      'Read the Myrmidon harness docs: how this colony runs, team modes, tasks and notes, verification, talking to ' +
      'the person, limits, and every tool. Call with no page to list them.',
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
    name: 'shell',
    tier: 'exec',
    description:
      'Run a shell command in your scratch directory inside the OS sandbox. It may write only to your scratch ' +
      'directory. The shared artifacts are readable at $MYR_MIRROR/artifacts.',
    parameters: type({ command: type('string'), 'timeoutSeconds?': type('number') }),
    async run(args, agent, host) {
      if (host.sandbox.kind === 'none' && !host.unsafeNoSandbox)
        throw new Error('shell is disabled: no OS sandbox')
      const cwd = host.workspace.scratch(agent)
      const r = await host.sandbox.run({
        command: args.command,
        cwd,
        writable: [cwd],
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
            const result = await def.run(params ?? {}, agent, host)
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
