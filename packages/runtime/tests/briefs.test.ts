import { expect, test } from 'bun:test'
import { type Environment, skillsFor, startsAwake, toolsFor } from '../src/patterns.ts'
import { systemPrompt } from '../src/prompt/assemble.ts'
import type { AgentSpec, ColonySpec } from '../src/spec.ts'
import { TOOL_DEFS } from '../src/tools.ts'

const judge = { verifier: 'llm-judge' as const, model: 'mock/judge', rubric: 'r', threshold: 0.7 }
const lead: AgentSpec = { name: 'lead', role: 'lead', model: 'mock/lead' }
const pax: AgentSpec = { name: 'pax', role: 'worker', model: 'mock/pax', specialty: 'researcher' }
const kai: AgentSpec = { name: 'kai', role: 'worker', model: 'mock/kai', specialty: 'coder' }

function chat(
  p: Partial<ColonySpec> & { agents: AgentSpec[] },
  extra: Partial<NonNullable<ColonySpec['chat']>> = {},
) {
  return {
    name: 'Ants',
    mission: 'Build a small web page about ants',
    pattern: 'lead-workers',
    acceptance: [judge],
    budget: { wallMs: 60_000, maxTurns: 10 },
    observer: { intervalMs: 1000 },
    tier: 'solo',
    chat: { chatId: 'c1', round: 1, request: 'Build a small web page about ants', history: '', ...extra },
    ...p,
  } as ColonySpec
}

const project = { project: { id: 'p1', name: 'site', path: '/tmp/site' } }
const readOnly = {
  project: { ...project.project, permissions: { preset: 'read-only' as const, rules: [] } },
}
const swarm = { mode: 'swarm' as const, maxWorkers: 0, workerModels: ['mock/a'] }
const orchestrated = { mode: 'orchestrated' as const, maxWorkers: 2, workerModels: ['mock/kai'] }
const peers: AgentSpec[] = [
  { name: 'ana', role: 'peer', model: 'mock/a' },
  { name: 'bo', role: 'peer', model: 'mock/b' },
]

/** Every role a round can give an agent, as [label, spec, agent]. */
const roles: [string, ColonySpec, AgentSpec][] = [
  ['answer', chat({ tier: 'answer', agents: [lead], acceptance: [] }, { escalate: ['solo'] }), lead],
  ['answer in a project', chat({ tier: 'answer', agents: [lead] }, { ...project, escalate: ['solo'] }), lead],
  ['answer in a read-only project', chat({ tier: 'answer', agents: [lead] }, readOnly), lead],
  ['solo in a read-only project', chat({ agents: [lead] }, readOnly), lead],
  ['solo', chat({ agents: [lead] }), lead],
  ['solo that may escalate', chat({ agents: [lead] }, { escalate: ['team'] }), lead],
  [
    'solo lead with crewmates on call',
    chat({ agents: [lead], team: { ...orchestrated, maxWorkers: 0, crewmates: [pax] } }),
    lead,
  ],
  [
    'solo lead with crewmates, may escalate',
    chat(
      { agents: [lead], team: { ...orchestrated, maxWorkers: 0, crewmates: [pax] } },
      { escalate: ['team'] },
    ),
    lead,
  ],
  [
    'crewmate asked by a solo lead',
    chat({ agents: [lead, pax], team: { ...orchestrated, maxWorkers: 0, crewmates: [pax] } }),
    pax,
  ],
  [
    'crewmate in a project',
    chat({ agents: [lead, pax], team: { ...orchestrated, maxWorkers: 0, crewmates: [pax] } }, project),
    pax,
  ],
  ['team lead', chat({ tier: 'team', agents: [lead, kai], team: orchestrated }), lead],
  ['team worker', chat({ tier: 'team', agents: [lead, kai], team: orchestrated }), kai],
  ['team worker in a project', chat({ tier: 'team', agents: [lead, kai], team: orchestrated }, project), kai],
  [
    'swarm peer',
    chat({ tier: 'team', pattern: 'blackboard', agents: peers, team: swarm }),
    peers[0] as AgentSpec,
  ],
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

const env: Environment = {
  sandbox: 'sandbox-exec',
  web: true,
  browser: true,
  boundary: 'b0',
  skills: [{ name: 'cert-expiry', description: 'Check when TLS certificates expire.' }],
}

/** A round in a project also knows the project's checks and layout. */
const envFor = (spec: ColonySpec): Environment =>
  spec.chat?.project
    ? { ...env, project: { checks: [{ name: 'test', command: 'bun test' }], layout: 'src/' } as never }
    : env

const names = TOOL_DEFS.map((d) => d.name)
/**
 * Tool names a prompt mentions: a name with an underscore anywhere; a one-word name (message, shell, propose), which
 * is also an English word, when it is called or introduced as a tool (`name(`, `name:`, `with name`, `use name`).
 */
function mentioned(prompt: string): string[] {
  return names.filter((n) =>
    new RegExp(
      n.includes('_') ? `(?<![\\w-])${n}(?![\\w-])` : `(?<![\\w-])${n}[(:]|\\b(with|use) ${n}\\b`,
    ).test(prompt),
  )
}

test('every role is told only of tools it has', () => {
  const wrong = roles.flatMap(([label, spec, agent]) => {
    const prompt = systemPrompt(spec, agent, envFor(spec)).join('\n')
    const has = new Set(toolsFor(spec, agent))
    const missing = mentioned(prompt).filter((n) => !has.has(n))
    return missing.length ? [`${label}: ${missing.join(', ')}`] : []
  })
  expect(wrong).toEqual([])
})

test('every tool a prompt names exists, under the same name', () => {
  const known = new Set(names)
  const unknown = roles.flatMap(([label, spec, agent]) => {
    const prompt = systemPrompt(spec, agent, envFor(spec)).join('\n')
    // snake_case words, which is how every tool is named, minus parameters and placeholders.
    const named = [...prompt.matchAll(/(?<![\w$-])([a-z]+_[a-z_]+)(?![\w-])/g)].map((m) => m[1] ?? '')
    return [...new Set(named)]
      .filter((n) => !known.has(n) && !/^(tool_|mcp_)/.test(n) && !['reply_to'].includes(n))
      .map((n) => `${label}: ${n}`)
  })
  expect(unknown).toEqual([])
})

test("a crewmate's brief matches its real situation: its job, the lead, one way to finish", () => {
  const [, spec, agent] = roles.find(([l]) => l === 'crewmate asked by a solo lead') ?? []
  if (!spec || !agent) throw new Error('no crewmate role')
  const prompt = systemPrompt(spec, agent, env).join('\n')
  expect(prompt).not.toContain('This round: solo (one agent, all tools)')
  expect(prompt).toContain('This round: one job for lead')
  expect(prompt).toContain('override these defaults')
  expect(prompt).not.toContain('reply with one short line')
  expect(prompt.match(/answer lead once/g)).toHaveLength(1)
  // It wakes for its job, not for the person's request.
  expect(startsAwake(spec, agent)).toBe(false)
  // Workers on a team are told their task overrides the defaults too.
  const [, team, worker] = roles.find(([l]) => l === 'team worker') ?? []
  if (!team || !worker) throw new Error('no team worker')
  expect(systemPrompt(team, worker, env).join('\n')).toContain('override these defaults')
  // Nobody is told twice not to fabricate.
  for (const [, s, a] of roles)
    expect(
      systemPrompt(s, a, env)
        .join('\n')
        .match(/[Ff]abricate/g)?.length ?? 0,
    ).toBeLessThanOrEqual(1)
})

test('the agent that answers the person is told its reviewer setting', () => {
  const speaker = (p: Partial<ColonySpec>) =>
    systemPrompt(chat({ agents: [lead], ...p }), lead, env).join('\n')
  expect(speaker({ review: 'off' })).toContain('Reviewer: off.')
  expect(speaker({ acceptance: [] })).toContain('Reviewer: off.')
  expect(speaker({ review: 'auto' })).toContain('Reviewer: auto (judge: mock/judge).')
  expect(speaker({ review: 'always' })).toContain('Reviewer: always (judge: mock/judge).')
  expect(speaker({})).toContain('Reviewer: always (judge: mock/judge).')
  // With no reviewer, nobody is told a verifier decides.
  const team = chat({ tier: 'team', agents: [lead, kai], team: orchestrated, review: 'off' })
  expect(systemPrompt(team, lead, env).join('\n')).not.toContain('decided by an independent verifier')
  // Task submitters are told how their tasks are checked.
  expect(systemPrompt(team, kai, env).join('\n')).toContain('Reviewer: no judge reads your tasks')
  expect(systemPrompt({ ...team, taskJudge: 'mock/judge' }, kai, env).join('\n')).toContain(
    'checked by a judge (mock/judge)',
  )
})

test('skills the request needs come with descriptions; the rest by name', () => {
  const skills = [
    { name: 'haiku-style', description: 'How the person likes haiku written.' },
    { name: 'cleanmymac', description: 'Free disk space on a Mac.' },
    { name: 'sentry-cli', description: 'Use the Sentry CLI to view issues and events.' },
  ]
  expect(skillsFor('Write a haiku about ants', skills).map((s) => s.name)).toEqual(['haiku-style'])
  expect(skillsFor('Show me the latest Sentry issues', skills).map((s) => s.name)).toEqual(['sentry-cli'])
  expect(skillsFor('Which skills do you have?', skills)).toHaveLength(3)
  const prompt = systemPrompt(chat({ agents: [lead] }, { request: 'Write a haiku about ants' }), lead, {
    ...env,
    skills,
  }).join('\n')
  expect(prompt).toContain('- haiku-style: How the person likes haiku written.')
  expect(prompt).not.toContain('Free disk space')
  expect(prompt).toContain('cleanmymac, sentry-cli')
})

test('a lead with no crewmates says plainly that the chat has none and how to add some, not "solo round"', () => {
  const prompt = systemPrompt(chat({ agents: [lead] }), lead, env).join('\n')
  expect(prompt).toContain(
    'This round: you alone, with every tool. No crewmates unless the person adds some with Crewmates in the message box.',
  )
  expect(prompt).not.toMatch(/This round: solo/)
  const onCall = chat({ agents: [lead], team: { ...orchestrated, crewmates: [kai] } })
  expect(systemPrompt(onCall, lead, env).join('\n')).toContain(
    'This round: you, with every tool, and 1 crewmate on call',
  )
})
