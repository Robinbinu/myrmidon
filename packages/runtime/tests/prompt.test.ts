import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newColonyId } from '@myrmidon/core'
import { emptyColonyState, foldColony } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import { bootRuntime, ChatService, ModelResolver, type Runtime } from '../src/index.ts'
import { type Environment, kickoff, startsAwake, toolsFor } from '../src/patterns.ts'
import { assemble } from '../src/prompt/assemble.ts'
import { factsFor, modelFamily } from '../src/prompt/facts.ts'
import { lint, viewOf } from '../src/prompt/lint.ts'
import { HEADINGS, SECTIONS, tierOf } from '../src/prompt/sections.ts'
import type { AgentSpec, ColonySpec } from '../src/spec.ts'
import { toolDescription } from '../src/tools.ts'

// Labels the interface shows the person; none of them may reach an agent.
const TITLE = 'Quokka Ledger Zephyr'
const CHAT_ID = 'chat-zephyrquokka'
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const judge = { verifier: 'llm-judge' as const, model: 'mock/judge', rubric: 'r', threshold: 0.7 }
const lead: AgentSpec = { name: 'lead', role: 'lead', model: 'anthropic/claude-sonnet' }
const pax: AgentSpec = { name: 'pax', role: 'worker', model: 'openai/gpt-5', specialty: 'researcher' }
const asked: AgentSpec = { ...pax, focus: 'Find how many ants live in a typical colony.' }
const kai: AgentSpec = { name: 'kai', role: 'worker', model: 'mock/kai', specialty: 'coder' }
const peers: AgentSpec[] = [
  { name: 'ana', role: 'peer', model: 'mock/a' },
  { name: 'bo', role: 'peer', model: 'mock/b' },
]
const orchestrated = { mode: 'orchestrated' as const, maxWorkers: 2, workerModels: ['mock/kai'] }
const teamRound = chat({ tier: 'team', agents: [lead, kai], team: orchestrated })
// A lead the person also gave the hands-on tools its crewmates have.
const handsOn: AgentSpec = {
  ...lead,
  tools: [
    ...toolsFor(teamRound, lead),
    'web_search',
    'web_fetch',
    'browser_open',
    'shell',
    'fs_read',
    'fs_write',
  ],
}
const onCall = { ...orchestrated, maxWorkers: 0, crewmates: [pax] }
const swarm = { mode: 'swarm' as const, maxWorkers: 0, workerModels: ['mock/a'] }
const site = { id: 'p1', name: 'site', path: '/tmp/site' }
const inProject = (mode: 'auto' | 'ask' | 'read-only') => ({
  project: { ...site, permissions: { mode, allow: mode === 'ask' ? ['git status'] : [] } },
})

function chat(
  p: Partial<ColonySpec> & { agents: AgentSpec[] },
  extra: Partial<NonNullable<ColonySpec['chat']>> = {},
): ColonySpec {
  return {
    name: TITLE,
    mission: 'Build a small web page about ants',
    pattern: 'lead-workers',
    acceptance: [judge],
    budget: { wallMs: 60_000, maxTurns: 10 },
    observer: { intervalMs: 1000 },
    tier: 'solo',
    chat: { chatId: CHAT_ID, round: 3, request: 'Build a small web page about ants', history: '', ...extra },
    ...p,
  } as ColonySpec
}

const colony = newColonyId()
const worktree = { workdir: `/data/colonies/${colony}/worktrees/kai`, branch: 'myr/kai' }

/** The rounds an agent can be in, as [label, spec, agent, environment overrides]. */
const matrix: [string, ColonySpec, AgentSpec, Partial<Environment>?][] = [
  ['answer', chat({ tier: 'answer', agents: [lead], acceptance: [] }, { escalate: ['solo', 'team'] }), lead],
  ['answer in a project', chat({ tier: 'answer', agents: [lead] }, inProject('auto')), lead],
  ['solo lead with crewmates on call', chat({ agents: [lead], team: onCall }, { escalate: ['team'] }), lead],
  ['crewmate on call', chat({ agents: [lead, asked], team: onCall }), asked],
  ['crewmate on call in a project', chat({ agents: [lead, asked], team: onCall }, inProject('auto')), asked],
  ['team lead', chat({ tier: 'team', agents: [lead, kai], team: orchestrated }), lead],
  [
    'team lead with hands-on tools',
    chat({ tier: 'team', agents: [handsOn, kai], team: orchestrated }, inProject('auto')),
    handsOn,
  ],
  ['team worker', chat({ tier: 'team', agents: [lead, kai], team: orchestrated }), kai],
  [
    'team worker in a worktree',
    chat({ tier: 'team', agents: [lead, kai], team: orchestrated }, inProject('auto')),
    kai,
    { worktree },
  ],
  [
    'team worker the person wrote to',
    chat({ tier: 'team', agents: [lead, kai], team: orchestrated }, { addressed: ['kai'] }),
    kai,
  ],
  [
    'swarm peer',
    chat({ tier: 'team', pattern: 'blackboard', agents: peers, team: swarm }),
    peers[0] as AgentSpec,
  ],
  ['solo in a read-only project', chat({ agents: [lead] }, inProject('read-only')), lead],
  ['solo in an ask-first project', chat({ agents: [lead] }, inProject('ask')), lead],
  ['solo in a project', chat({ agents: [lead] }, { ...inProject('auto'), memory: ['- Likes tea.'] }), lead],
  [
    'solo with full access',
    chat({ agents: [lead], fullAccess: true }, inProject('auto')),
    lead,
    { sandbox: 'unconfined' },
  ],
  ['solo on a voice call', chat({ agents: [lead] }, { voice: true }), lead],
  ['solo a channel member opened', chat({ agents: [lead], askAll: true }), lead],
  ['solo with plan first', chat({ agents: [lead], planFirst: true, review: 'auto' }), lead],
  ['colony lead', { ...chat({ agents: [lead, kai] }), chat: undefined, tier: undefined } as ColonySpec, lead],
  [
    'colony worker',
    { ...chat({ agents: [lead, kai] }), chat: undefined, tier: undefined } as ColonySpec,
    kai,
  ],
  [
    'colony peer',
    { ...chat({ pattern: 'blackboard', agents: peers }), chat: undefined, tier: undefined } as ColonySpec,
    peers[0] as AgentSpec,
  ],
]

const base: Environment = {
  sandbox: 'sandbox-exec',
  web: true,
  browser: true,
  boundary: 'b0',
  skills: [{ name: 'cert-expiry', description: 'Check when TLS certificates expire.' }],
}

function envFor(spec: ColonySpec, extra: Partial<Environment> = {}): Environment {
  const project = spec.chat?.project
    ? {
        project: {
          checks: [{ name: 'test', command: 'bun test' }],
          layout: 'src/',
          instructions: { files: ['AGENTS.md'], text: 'Run bun test before you finish.', nested: [] },
        } as never,
      }
    : {}
  return { ...base, ...project, ...extra }
}

const views = matrix.map(([label, spec, agent, extra]) => {
  const facts = factsFor(spec, agent, envFor(spec, extra))
  return {
    label,
    spec,
    agent,
    view: viewOf(facts, kickoff(spec, emptyColonyState(colony), false, agent.name)),
  }
})

test('every agent is told only of tools it has, in its prompt and its first message', () => {
  const found = views.flatMap(({ label, view }) =>
    lint(view)
      .filter((f) => f.check === 'unknown-tools')
      .map((f) => `${label} (${f.where}): ${f.text}`),
  )
  expect(found).toEqual([])
})

test("the chat's title and id reach no agent: not its prompt, first message, tools or paths", () => {
  const found = views.flatMap(({ label, view }) =>
    lint(view, { markers: [TITLE, slug(TITLE), CHAT_ID] })
      .filter((f) => f.check === 'interface-metadata')
      .map((f) => `${label} (${f.where}): ${f.text}`),
  )
  expect(found).toEqual([])
  // Colony ids name directories agents see, so they are opaque.
  expect(newColonyId()).not.toContain(slug(TITLE))
  expect(newColonyId()).toMatch(/^colony-[a-z0-9]+-[0-9a-f]{8}$/)
})

test('no two sections of a prompt say the same sentence', () => {
  const found = views.flatMap(({ label, view }) =>
    lint(view)
      .filter((f) => f.check === 'repeated-sentences')
      .map((f) => `${label} (${f.where}): ${f.text}`),
  )
  expect(found).toEqual([])
})

test('a crewmate called with ask_crewmate reads its own role and opens with its job alone', () => {
  const { spec, agent, view } = views.find((v) => v.label === 'crewmate on call') ?? {}
  if (!spec || !agent || !view) throw new Error('no crewmate')
  const prompt = view.system.join('\n')
  expect(prompt).toContain('This round: one job for lead')
  expect(prompt).not.toContain('This round: solo')
  expect(view.kickoff).toBe('Find how many ants live in a typical colony.')
  expect(startsAwake(spec, agent)).toBe(true)
  // One on call that was not asked yet sleeps.
  expect(startsAwake(spec, pax)).toBe(false)
})

test('descriptions that depend on the round say what holds in it', () => {
  const facts = (label: string) => views.find((v) => v.label === label)?.view.facts
  expect(toolDescription('shell', facts('solo with full access'))).toContain('full access (no sandbox)')
  expect(toolDescription('shell', facts('solo in a project'))).toContain('in the OS sandbox')
  expect(toolDescription('reply_user', facts('answer'))).toContain('nobody reviews it')
  expect(toolDescription('reply_user', facts('solo in a project'))).toContain(
    'an independent reviewer checks it',
  )
  expect(toolDescription('reply_user', facts('solo with plan first'))).toContain('(request_review)')
  // The answer tier is never told how to scope a build it cannot do.
  expect(views.find((v) => v.label === 'answer')?.view.system.join('\n')).not.toContain('before building')
  // Deferred tools say how to load them.
  expect(views.find((v) => v.label === 'solo in a project')?.view.system.join('\n')).toContain(
    '(load with find_tools("create_tool"))',
  )
})

test('assembly: one block per tier, headings in skeleton order, with a manifest of versions', () => {
  // Sections stay in registry order, and the registry follows the headings' order.
  const order = Object.keys(HEADINGS)
  const positions = SECTIONS.map((s) => order.indexOf(s.heading))
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
  expect(SECTIONS.map(tierOf)).toEqual(SECTIONS.map((s) => HEADINGS[s.heading].tier))
  expect(new Set(SECTIONS.map((s) => s.key)).size).toBe(SECTIONS.length)
  const facts = factsFor(
    chat({ agents: [lead] }, inProject('auto')),
    { ...lead, instructions: 'Be brief.' },
    envFor(chat({ agents: [lead] }, inProject('auto'))),
  )
  const { system, manifest } = assemble(facts)
  expect(system).toHaveLength(3)
  const at = (text: string) => system.findIndex((b) => b.includes(text))
  expect(system[0]?.startsWith('# You\nYou are "lead"')).toBe(true)
  const stable = system[0] ?? ''
  const headings = [...stable.matchAll(/^# (.+)$/gm)].map((m) => m[1])
  expect(headings).toEqual([
    'You',
    'How you finish',
    'Safety and permissions',
    'How to work',
    'Talking to the person',
  ])
  expect(at('<instructions>\nBe brief.')).toBe(1)
  expect(at('<project_instructions source="AGENTS.md">')).toBe(1)
  expect(at('Today is')).toBe(2)
  // Project rules are stable, so they sit with the method, not in the environment.
  expect(stable).toContain("How to change the person's project")
  expect(manifest.agent).toBe('lead')
  expect(manifest.family).toBe('anthropic')
  expect(manifest.sections.map((s) => s.key)).toContain('project-rules')
  expect(manifest.sections.every((s) => s.version >= 1 && /^[0-9a-f]{12}$/.test(s.hash))).toBe(true)
  expect(manifest.totalTokens).toBeGreaterThan(500)
  expect(modelFamily('openai/gpt-5-codex')).toBe('openai-codex')
  expect(modelFamily('ollama/qwen3:8b')).toBe('qwen')
  expect(modelFamily('mock/x')).toBe('other')
})

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-prompt-'))
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

test('a renamed chat: the title reaches no agent in later rounds, and the colony id carries no request', async () => {
  const resolver = new ModelResolver()
  const seen: string[] = []
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      seen.push(JSON.stringify([ctx.systemPrompt, ctx.messages, ctx.tools]))
      return { content: [tool('reply_user', { text: 'Done.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo' })
  const config = {
    mode: 'orchestrated' as const,
    leadModel: 'mock/lead',
    roster: [],
    judgeModel: 'mock/lead',
  }
  const first = await chats.send('Write zq9 xv7 notes', config)
  const until = async (id: string, done: (n: number) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const s = foldColony(id, await runtime.ctx.log.read(id as never))
      if (done(s.rounds.length) && s.status !== 'running' && s.status !== 'created') return s
      await Bun.sleep(50)
    }
    throw new Error('the round did not finish')
  }
  await until(first.colonyId, (n) => n >= 1)
  expect(first.colonyId).not.toContain('zq9')
  await chats.rename(first.chatId, TITLE)
  seen.length = 0
  const second = await chats.send('And a summary', config, first.chatId)
  await until(second.colonyId, (n) => n >= 2)
  expect(seen.length).toBeGreaterThan(0)
  for (const call of seen) expect(call.toLowerCase()).not.toContain(TITLE.toLowerCase())
  // The prompt manifest went into the log when the agent started.
  const manifests = (await runtime.ctx.log.read(second.colonyId as never)).filter(
    (e) => e.type === 'agent/prompt',
  )
  expect(manifests.length).toBeGreaterThan(0)
  await chats.stopAll()
})

test("a lead knows its crewmates' tools and never thinks the team lacks one they have", () => {
  const text = (label: string) => views.find((v) => v.label === label)?.view.system.join('\n') ?? ''
  // Without hands-on tools of its own, the lead hands research and building to the crewmates who have them.
  expect(text('team lead')).toContain('- kai: coder (mock/kai); tools: web, browser, shell, files')
  expect(text('team lead')).toContain(
    'You have no web, browser, shell or files tools yourself, but your crewmates do',
  )
  expect(text('team lead')).not.toContain('# How to work\nIn order of importance')
  // With them, it may do small pieces itself but still delegates independent work, and works by the method.
  expect(text('team lead with hands-on tools')).not.toContain('You have no')
  expect(text('team lead with hands-on tools')).toContain('You may do a small piece yourself')
  expect(text('team lead with hands-on tools')).toContain('In order of importance')
  // A solo lead's crewmates on call are listed with their tools too.
  expect(text('solo lead with crewmates on call')).toContain(
    '- pax: researcher (openai/gpt-5); tools: web, browser, shell, files',
  )
})

test('one rule per role: workers assume and record, messages change work, one ending, a stated precedence', () => {
  const text = (label: string) => views.find((v) => v.label === label)?.view.system.join('\n') ?? ''
  for (const { label, view } of views) {
    const prompt = view.system.join('\n')
    // C2 and the old metaphor: messages are for changing someone's work, never chatter.
    expect(prompt, label).not.toContain('WhatsApp')
    expect(prompt, label).not.toContain('all through the work')
    // C5: everyone in a chat knows what overrides the defaults, once.
    if (view.facts.mode.chat) {
      expect(prompt.match(/override these defaults/g), label).toHaveLength(1)
      expect(prompt, label).toContain('except safety and permissions')
    }
    // C3: one ending, under How you finish.
    expect(prompt.match(/^# How you finish$/gm), label).toHaveLength(1)
  }
  // C1: a worker assumes and records instead of asking.
  expect(text('team worker')).not.toContain('Ask a quick question instead of guessing')
  expect(text('team worker')).toContain('make a sensible assumption, record it as a "decision" note')
  // C3: a crewmate on call has one way to finish, a team worker another.
  expect(text('crewmate on call').match(/answer lead once/g)).toHaveLength(1)
  expect(text('crewmate on call')).not.toContain('reply with one short line')
  expect(text('team worker').match(/reply with one short line/g)).toHaveLength(1)
  // C4: a worker talks to the person only when written to directly.
  expect(text('team worker')).toContain(
    'You talk to the person only when they write to you directly, with reply_person',
  )
  expect(text('team worker')).not.toContain('You cannot talk to the person')
  // C6: one rule for when to ask, in the speaker's section, and the first move points at it.
  expect(text('solo in a project').match(/Ask only when the result depends/g)).toHaveLength(1)
  expect(text('solo in a project')).toContain('ask first if the result depends on the person')
  // C7: "the job" is the agent's own task, not the request.
  expect(text('team worker')).toContain('Your job is the task, not the whole request')
  expect(text('swarm peer')).toContain('Your job is that task, not the whole request')
  // Safety and permissions sit near the top, before the method.
  const solo = text('solo in a project')
  expect(solo.indexOf('# Safety and permissions')).toBeLessThan(solo.indexOf('# How to work'))
  expect(solo.indexOf('# How to work')).toBeLessThan(solo.indexOf('# Talking to the person'))
})

test('the lint itself catches an absent tool, a leaked label and a repeated rule', () => {
  const view = views.find((v) => v.label === 'answer')?.view
  if (!view) throw new Error('no answer view')
  const rule = 'Ask the person first before you build anything at all.'
  const broken = {
    ...view,
    sections: [
      ...view.sections,
      { key: 'x', heading: 'method' as const, text: `Then call create_plugin. ${rule}` },
      { key: 'y', heading: 'method' as const, text: rule },
    ],
    kickoff: `${TITLE}: go`,
  }
  expect(lint(broken, { markers: [TITLE] }).map((f) => `${f.check} ${f.where}`)).toEqual([
    'unknown-tools x',
    'interface-metadata kickoff',
    'repeated-sentences x, y',
  ])
})
