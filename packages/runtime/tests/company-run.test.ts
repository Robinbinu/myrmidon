import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import {
  bootRuntime,
  ChatService,
  type Classify,
  CompanyStore,
  ModelResolver,
  type Runtime,
  type TeamConfig,
} from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-company-run-'))
  runtime = await bootRuntime(home)
})
afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})
type Step = MockContent[] | ((ctx: LlmContext) => MockContent[])

function scripted(
  resolver: ModelResolver,
  ref: string,
  script: Step[] | ((ctx: LlmContext) => MockContent[]),
) {
  let call = 0
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      if (typeof script === 'function') return { content: script(ctx) }
      const step = script[call++]
      return { content: typeof step === 'function' ? step(ctx) : (step ?? ['ok']) }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

function judge(resolver: ModelResolver) {
  const m = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
}

const fixed =
  (tier: 'answer' | 'solo' | 'team'): Classify =>
  async () =>
    tier

async function waitFor(
  colonyId: string,
  until = (s: ColonyState) => s.status !== 'running' && s.status !== 'created',
) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

/** A two-stage company: the writer drafts, the checker checks the draft; the boss leads. */
const tiny = (start: 'lead' | 'playbook') => ({
  name: 'Tiny press',
  kind: 'publishing',
  description: 'A writer and a checker.',
  head: 'boss',
  start,
  budget: { perRunUsd: 2 },
  roles: [
    { name: 'boss', title: 'Editor in chief', tier: 'frontier', prompt: 'Check every stage.' },
    {
      name: 'writer',
      title: 'Writer',
      tier: 'smart',
      access: 'no-shell',
      stage: 'draft',
      prompt: 'Write it.',
    },
    {
      name: 'checker',
      title: 'Fact checker',
      tier: 'fast',
      access: 'read-only',
      stage: 'check',
      prompt: 'Check it.',
    },
  ],
  playbook: [
    { id: 'draft', title: 'Draft it', output: 'draft.md', brief: 'Write the draft.' },
    { id: 'check', title: 'Check it', after: ['draft'], output: 'check.md', brief: 'Check the draft.' },
  ],
})

const config = (company: string): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
  company,
  tierModels: { smart: 'mock/smart', fast: 'mock/fast' },
})

/** A stage owner: claims its task, publishes its output, submits. */
const stageWorker = (task: string, output: string): Step[] => [
  [tool('claim_task', { id: task, revision: 1 })],
  [tool('publish_artifact', { name: output, content: `# ${output}\nDone.` })],
  [tool('submit_task', { id: task, revision: 2, artifacts: [output] })],
  ['Submitted.'],
]

test('a company run: each role its own crewmate, the playbook as tasks, a stage wakes only when the one before is done', async () => {
  const companies = new CompanyStore(home)
  const saved = companies.save(tiny('playbook'))
  const resolver = new ModelResolver()
  const seen: { system?: string; tools?: string[] } = {}
  let proposed = false
  scripted(resolver, 'mock/lead', (ctx) => {
    seen.system ??= ctx.systemPrompt?.join('\n') ?? ''
    seen.tools ??= ctx.tools?.map((t) => t.name)
    // The last stage's verdict reaches the lead once the checker's work is verified.
    const last = JSON.stringify(ctx.messages.at(-1) ?? '')
    if (last.includes('task-2') && !proposed) {
      proposed = true
      return [
        tool('propose_company_change', {
          change: 'hire',
          role: 'designer',
          why: 'The draft needed a layout and nobody owns layout.',
          evidence: 'task-1 shipped plain text; the request asked for a formatted page.',
          title: 'Layout designer',
        }),
        tool('reply_user', { text: 'Drafted and checked.', final: true }),
      ]
    }
    return ['Waiting on the stages.']
  })
  scripted(resolver, 'mock/smart', stageWorker('task-1', 'draft.md'))
  scripted(resolver, 'mock/fast', stageWorker('task-2', 'check.md'))
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, companies, classify: fixed('solo'), quietMs: 500 })
  const { colonyId } = await chats.send('Write a note about ants', config(saved.id))
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  // Each role joined as its own agent, on its tier's model, with its access narrowing its tools.
  expect(s.agents.lead?.info).toMatchObject({ model: 'mock/lead', specialty: 'Editor in chief' })
  expect(s.agents.writer?.info).toMatchObject({ role: 'worker', model: 'mock/smart', specialty: 'Writer' })
  expect(s.agents.checker?.info.model).toBe('mock/fast')
  expect(s.agents.writer?.info.tools).not.toContain('shell')
  expect(s.agents.checker?.info.tools).not.toContain('fs_write')
  expect(s.company).toMatchObject({ id: saved.id, name: 'Tiny press', version: 1 })
  // The playbook went on the board as dependent tasks, each for the role that owns its stage, and both were done.
  expect(Object.values(s.tasks).map((t) => [t.id, t.assignee, t.blockedBy, t.status])).toEqual([
    ['task-1', 'writer', [], 'verified'],
    ['task-2', 'checker', ['task-1'], 'verified'],
  ])
  expect(seen.system).toContain('task-2: check, owned by checker, after task-1')
  expect(seen.tools).toContain('propose_company_change')
  expect(seen.tools).not.toContain('add_crewmate')
  // The checker slept until the draft was verified: its first turn comes after that verdict.
  const log: MyrEvent[] = await runtime.ctx.log.read(colonyId as never)
  const verified = log.find(
    (e) =>
      e.type === 'task/changed' &&
      (e.payload as EventPayloads['task/changed']).task.id === 'task-1' &&
      (e.payload as EventPayloads['task/changed']).task.status === 'verified',
  )
  const checkerTurn = log.find(
    (e) => e.type === 'agent/turn' && (e.payload as EventPayloads['agent/turn']).agent === 'checker',
  )
  expect(checkerTurn && verified && checkerTurn.seq > verified.seq).toBe(true)
  // The company's own cap bounds the run.
  expect((log[0]?.payload as EventPayloads['colony/created'] | undefined)?.budget.costUsd).toBe(2)

  // The lead's proposal waits for the person; approving it saves a new version with the new role.
  const proposal = Object.values(s.companyProposals)[0]
  expect(proposal).toMatchObject({ change: 'hire', role: 'designer', company: { id: saved.id, version: 1 } })
  const decided = await chats.decideCompanyProposal(colonyId, proposal?.id ?? '', true)
  expect(decided.version).toBe(2)
  expect(companies.get(saved.id)?.roles.map((r) => r.name)).toEqual(['boss', 'writer', 'checker', 'designer'])
  expect(companies.history(saved.id)[0]?.note).toContain('Approved: hire designer')
  const after = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
  expect(after.companyProposals[proposal?.id ?? '']?.decided).toMatchObject({ approved: true, version: 2 })
  await expect(chats.decideCompanyProposal(colonyId, proposal?.id ?? '', true)).rejects.toThrow(
    'already decided',
  )
  await chats.stopAll()
})

test('a company that starts with its lead: the roles are on call, nothing is on the board, nobody else wakes', async () => {
  const companies = new CompanyStore(home)
  const saved = companies.save(tiny('lead'))
  const resolver = new ModelResolver()
  const seen: { system?: string; tools?: string[] } = {}
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      seen.system = ctx.systemPrompt?.join('\n') ?? ''
      seen.tools = ctx.tools?.map((t) => t.name)
      return [tool('reply_user', { text: 'Ants are insects.', final: true })]
    },
  ])
  scripted(resolver, 'mock/smart', [])
  scripted(resolver, 'mock/fast', [])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, companies, classify: fixed('solo'), quietMs: 500 })
  const { colonyId } = await chats.send('What are ants?', config(saved.id))
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(Object.keys(s.tasks)).toEqual([])
  expect(Object.keys(s.agents)).toEqual(['lead'])
  expect(seen.tools).toContain('ask_crewmate')
  expect(seen.system).toContain('escalate to the team')
  expect(seen.system).toContain('- writer: Writer, owns the draft stage')
  // A company that was removed stops the next message with why.
  companies.remove(saved.id)
  await expect(chats.send('again', config(saved.id))).rejects.toThrow('no longer exists')
  await chats.stopAll()
})
