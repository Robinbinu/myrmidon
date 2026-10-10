import { expect, test } from 'bun:test'
import { emptyColonyState, type MyrEvent } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import type { ColonyHost } from '../src/host.ts'
import { ModelResolver } from '../src/models.ts'
import { prompts } from '../src/prompts.ts'
import { TOOL_DEFS } from '../src/tools.ts'
import { citedUrls, doneWhen, relevantExcerpt, Verifier, workKinds } from '../src/verifier.ts'

const call = (tool: string): MyrEvent => ({ type: 'tool/call', payload: { tool } }) as unknown as MyrEvent

test('the kind of work comes from the tools used and the files delivered', () => {
  expect(workKinds([call('web_search'), call('web_fetch')], ['report.md'], false)).toEqual([
    'research',
    'writing',
  ])
  expect(workKinds([call('fs_edit')], [], true)).toEqual(['code'])
  // A scratch edit outside a project is not code; a delivered script is.
  expect(workKinds([call('fs_write')], [], false)).toEqual(['writing'])
  expect(workKinds([], ['game/index.html'], false)).toEqual(['code'])
  expect(workKinds([call('browser_open'), call('browser_click')], [], false)).toEqual(['browser'])
  // Inputs the person or a fetch put in the workspace are not deliverables.
  expect(workKinds([], ['uploads/data.py', 'web/page.html'], false)).toEqual(['writing'])
})

test('cited URLs are public, deduplicated, and stripped of trailing punctuation', () => {
  const text =
    'See [the docs](https://example.org/guide). Also https://example.org/guide#intro and ' +
    'https://news.example.com/a?id=2, plus http://localhost:3000/x and https://example.org/guide/.'
  expect(citedUrls(text)).toEqual(['https://example.org/guide', 'https://news.example.com/a?id=2'])
})

test('a long page is cut to its opening and the passages matching the claim', () => {
  const page = `Title: Rocket crate\n${'filler text '.repeat(400)}Downloads: 14,203,511 total, version 0.5.1 released May 2024.${' more filler'.repeat(400)}`
  const excerpt = relevantExcerpt(
    page,
    'Rocket 0.5.1 has 14,203,511 downloads (https://crates.io/crates/rocket)',
    1_500,
  )
  expect(excerpt.length).toBeLessThan(1_700)
  expect(excerpt).toStartWith('Title: Rocket crate')
  expect(excerpt).toContain('14,203,511')
  expect(relevantExcerpt('short page', 'anything')).toBe('short page')
})

test("a task's review checks it against its own Done when, and the judge knows the pass mark", () => {
  const brief = [
    'Goal: a pricing section.',
    'Context: prices are in notes/pricing.md.',
    'Done when: three cards show the prices;',
    '  the page opens with no console errors.',
    'Not yours: the header.',
  ].join('\n')
  expect(doneWhen(brief)).toBe('three cards show the prices;\n  the page opens with no console errors.')
  // Written on one line, as in create_task's example.
  expect(doneWhen('Goal: x. Done when: it builds and the test passes. Not yours: docs.')).toBe(
    'it builds and the test passes.',
  )
  expect(doneWhen('Done when: last head.')).toBe('last head.')
  expect(doneWhen('Write the report.')).toBeUndefined()
  const task = prompts.judge.task('Pricing', brief, doneWhen(brief))
  expect(task).toContain('Its "Done when" is your checklist')
  expect(prompts.judge.task('Pricing', 'Write it.')).not.toContain('checklist')
  expect(prompts.judge.threshold(0.7)).toStartWith('Passing is 0.70 or more.')
  expect(prompts.judge.threshold(0.7)).toContain('about 0.3 when')
  expect(prompts.judge.role).toContain('the replies sent to the person')
})

/** A round's host with one submitted task, recording what the verifier appends; `judge` turns task review on. */
function taskRound(task: { outputs?: string[]; artifacts?: string[] }, judge?: { seen: string[] }) {
  const state = emptyColonyState('c')
  state.tasks['task-1'] = {
    id: 'task-1',
    revision: 3,
    subject: 'Report what the board shows',
    description: 'Goal: say what is on the board. Deliverable: a note and a message to lead, no files.',
    status: 'submitted',
    owner: 'juno',
    blockedBy: [],
    artifacts: task.artifacts ?? [],
    ...(task.outputs ? { outputs: task.outputs } : {}),
  }
  state.notes.push({
    id: 'n1',
    seq: 1,
    time: '',
    agent: 'juno',
    text: 'The board shows two tasks.',
    section: 'finding',
  } as never)
  const appended: { type: string; payload: unknown }[] = []
  const resolver = new ModelResolver()
  if (judge) {
    const m = createMockModel({
      handler: (ctx: LlmContext) => {
        judge.seen.push(JSON.stringify(ctx.messages))
        return { content: ['{"score": 0.9, "reasons": "complete"}'] }
      },
    })
    resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
  }
  const host = {
    id: 'c',
    state: () => state,
    spec: { taskJudge: judge ? 'mock/judge' : undefined },
    log: { read: async () => [] },
    projectDiff: async () => '',
    workspace: { workdir: () => '/nowhere', scratch: () => '/nowhere' },
    sandbox: { kind: 'none' },
    append: async (d: { type: string; payload: unknown }) => {
      appended.push(d)
      return d
    },
    appendAtomic: async (build: (s: typeof state) => { type: string; payload: unknown }[]) => {
      const drafts = build(state)
      appended.push(...drafts)
      return drafts
    },
  } as unknown as ColonyHost
  const status = () =>
    (appended.find((e) => e.type === 'task/changed')?.payload as { task: { status: string } } | undefined)
      ?.task.status
  return { host, resolver, status }
}

test('a task that names no outputs passes on its note and message; one that names outputs needs them', async () => {
  const noFiles = taskRound({})
  const outcome = await new Verifier(noFiles.host, noFiles.resolver).verifyTask('task-1')
  expect(outcome.pass).toBe(true)
  expect(noFiles.status()).toBe('verified')

  const withFiles = taskRound({ outputs: ['report.md'] })
  const missing = await new Verifier(withFiles.host, withFiles.resolver).verifyTask('task-1')
  expect(missing.pass).toBe(false)
  expect(missing.evidence).toContain('report.md')
  expect(withFiles.status()).toBe('rejected')
})

test('with task review on, the judge of a task with no files reads its notes, not every file in the round', async () => {
  const judge = { seen: [] as string[] }
  const round = taskRound({}, judge)
  round.host.state().artifacts['other.md'] = [
    { version: 1, blob: 'x', size: 1, mediaType: 'text/markdown', author: 'orion' } as never,
  ]
  const outcome = await new Verifier(round.host, round.resolver).verifyTask('task-1')
  expect(outcome.pass).toBe(true)
  expect(judge.seen.join('\n')).toContain('The board shows two tasks.')
  expect(judge.seen.join('\n')).not.toContain('other.md')
})

test('submit_task refuses at once a task that names outputs when none are submitted, and takes one that names none', async () => {
  const submit = TOOL_DEFS.find((d) => d.name === 'submit_task')
  const held = (outputs?: string[]) => {
    const state = emptyColonyState('c')
    state.tasks['task-1'] = {
      id: 'task-1',
      revision: 2,
      subject: 'Report',
      description: 'Goal: report.',
      status: 'in_progress',
      owner: 'juno',
      blockedBy: [],
      artifacts: [],
      ...(outputs ? { outputs } : {}),
    }
    const asked: string[] = []
    const host = {
      state: () => state,
      mergeWork: async () => [],
      appendAtomic: async (build: (s: typeof state) => unknown[]) => build(state),
      requestTaskVerification: (id: string) => asked.push(id),
    } as unknown as ColonyHost
    return { host, asked }
  }
  const named = held(['report.md'])
  await expect(submit?.run({ id: 'task-1', revision: 2, artifacts: [] }, 'juno', named.host)).rejects.toThrow(
    'report.md',
  )
  expect(named.asked).toEqual([])
  const none = held()
  expect(await submit?.run({ id: 'task-1', revision: 2, artifacts: [] }, 'juno', none.host)).toContain(
    'task-1 submitted',
  )
  expect(none.asked).toEqual(['task-1'])
})
