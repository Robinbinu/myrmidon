import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import { MemoryStore } from '../src/memory.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'
import { SkillProposalStore } from '../src/skill-learning.ts'
import { SkillLibrary } from '../src/skills.ts'

let home: string
let claude: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-learn-'))
  claude = mkdtempSync(join(tmpdir(), 'myr-learn-claude-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  for (const dir of [home, claude]) rmSync(dir, { recursive: true, force: true })
})

const call = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})
const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/agent',
  roster: [],
  judgeModel: 'mock/judge',
}

async function ended(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (!['running', 'created'].includes(s.status)) return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not end')
}

/** An agent that runs `script` one step at a time; returns each step's tool results as the agent saw them. */
function setup(script: MockContent[][]) {
  const resolver = new ModelResolver()
  const results: string[] = []
  let step = 0
  const agent = createMockModel({
    handler: (ctx: LlmContext) => {
      const last = ctx.messages.at(-1) as { role: string; content?: unknown }
      if (last?.role === 'toolResult') results.push(JSON.stringify(last.content))
      return { content: script[step++] ?? [call('reply_user', { text: 'Done.', final: true })] }
    },
  })
  resolver.register('mock/agent', { model: agent.model, streamFn: agent.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const skills = new SkillLibrary(home, claude)
  const skillProposals = new SkillProposalStore(home)
  const memory = new MemoryStore(home)
  const chats = new ChatService(runtime, {
    resolver,
    classify: async () => 'solo',
    skills,
    skillProposals,
    memory,
  })
  return { chats, results, skills, skillProposals, memory }
}

const SKILL = {
  name: 'release-notes',
  description: 'Use when writing release notes from merged pull requests',
  body: '1. List merged PRs since the last tag.\n2. Group them by area.',
}

test('learn proposes the lesson as a memory and its procedure as a learned skill; both wait for the person', async () => {
  const { chats, results, skills, skillProposals, memory } = setup([
    [
      call('learn', {
        lesson: 'Release notes come from merged PRs since the last tag, grouped by area',
        scope: 'everywhere',
        why: 'the person asked for notes twice this way',
        skill: { action: 'create', ...SKILL },
      }),
    ],
  ])
  const { colonyId } = await chats.send('Write the release notes', config)
  const s = await ended(colonyId)
  expect(results[0]).toContain('lesson proposed')
  expect(results[0]).toContain('skill proposed the new skill release-notes')
  // The lesson is a memory of kind lesson, not kept yet.
  const lesson = memory.list().find((m) => m.kind === 'lesson')
  expect(lesson?.status).toBe('proposed')
  // The skill is a proposal the chat shows, by the agent, and nothing is written until the person keeps it.
  const proposal = Object.values(s.skillProposals)[0]
  expect(proposal).toMatchObject({ name: 'release-notes', by: 'lead' })
  expect(proposal?.kept).toBeUndefined()
  expect(skills.learned()).toHaveLength(0)
  await chats.decideSkill(proposal?.id ?? '', true)
  expect(skills.learned().map((x) => x.name)).toEqual(['release-notes'])
  expect(skillProposals.get(proposal?.id ?? '')?.status).toBe('kept')
  await chats.stopAll()
})

test('manage_skill updates and retires only learned skills, never the person’s own, as proposals', async () => {
  const { chats, results, skills } = setup([
    [
      call('manage_skill', {
        action: 'update',
        ...SKILL,
        body: '1. List merged PRs.\n2. Link each.',
        why: 'links help',
      }),
    ],
    [call('manage_skill', { action: 'create', ...SKILL, why: 'again' })],
    [
      call('manage_skill', {
        action: 'update',
        name: 'deploy',
        description: 'x',
        body: 'y',
        why: 'mine now',
      }),
    ],
    [call('manage_skill', { action: 'delete', name: 'release-notes', why: 'superseded' })],
    [call('manage_skill', { action: 'create', name: 'Bad Name', description: 'x', body: 'y', why: 'z' })],
  ])
  skills.write(SKILL.name, SKILL.description, SKILL.body)
  // The person's own Claude Code skill.
  mkdirSync(join(claude, 'deploy'), { recursive: true })
  writeFileSync(
    join(claude, 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: How we deploy\n---\n\nRun make deploy.\n',
  )
  const { colonyId } = await chats.send('Tidy up the skills', config)
  const s = await ended(colonyId)
  expect(results[0]).toContain('proposed the change to release-notes')
  expect(results[1]).toContain('exists already: use action \\"update\\"')
  expect(results[2]).toContain("is the person's own")
  expect(results[3]).toContain('proposed retiring release-notes')
  expect(results[4]).toContain('not a skill name')
  const [update, retire] = Object.values(s.skillProposals).sort((a, b) => a.seq - b.seq)
  // An update carries what the skill says now, for the diff; a retirement keeps its instructions to show.
  expect(update?.update?.body).toBe(SKILL.body)
  expect(retire).toMatchObject({ remove: true, body: SKILL.body })
  await chats.decideSkill(retire?.id ?? '', true)
  expect(skills.learned()).toHaveLength(0)
  expect(skills.archived().map((x) => x.name)).toEqual(['release-notes'])
  // The person's own skill is untouched.
  expect(skills.list().find((x) => x.name === 'deploy')?.source).toBe('claude')
  await chats.stopAll()
})
