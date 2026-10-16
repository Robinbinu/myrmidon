import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { REVIEW_FILES } from '../src/config.ts'
import { bootRuntime, ChatService, ModelResolver, type Runtime } from '../src/index.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-review-'))
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

async function waitFor(colonyId: string) {
  for (let i = 0; i < 400; i++) {
    const s: ColonyState = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (s.status !== 'running' && s.status !== 'created') return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not end')
}

/** A solo round in auto review that writes `files` files and answers without asking for a review. */
async function round(files: number) {
  const { SettingsStore } = await import('../src/settings.ts')
  const { ProjectStore } = await import('../src/projects.ts')
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), verification: { ...settings.get().verification, reviewer: 'auto' } })
  const folder = mkdtempSync(join(tmpdir(), 'myr-review-project-'))
  const projects = new ProjectStore(home)
  const project = projects.setPermissions(projects.add(folder).id, { mode: 'auto', allow: [] })
  const resolver = new ModelResolver()
  let call = 0
  const lead = createMockModel({
    handler: () => {
      call += 1
      if (call === 1)
        return {
          content: Array.from({ length: files }, (_, i) =>
            tool('fs_write', { path: `src/f${i}.ts`, content: `export const f${i} = ${i}\n` }),
          ),
        }
      return { content: [tool('reply_user', { text: 'Wrote the files.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "fine"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo', settings, projects })
  const { colonyId } = await chats.send(
    'Write the files',
    { mode: 'orchestrated', leadModel: 'mock/lead', roster: [], judgeModel: 'mock/judge' },
    undefined,
    { project: project.id },
  )
  const s = await waitFor(colonyId)
  const log = await runtime.ctx.log.read(colonyId as never)
  await chats.stopAll()
  rmSync(folder, { recursive: true, force: true })
  return { s, reviews: log.filter((e) => e.type === 'verifier/requested').length }
}

test('auto review reviews an answer after a multi-file change the agent did not ask about', async () => {
  const many = await round(REVIEW_FILES)
  expect(many.s.status).toBe('completed')
  expect(many.reviews).toBe(1)
  expect(many.s.verdicts.at(-1)?.verifierId).not.toBe('delivered')
})

test('auto review leaves a one-file change to the agent', async () => {
  const one = await round(1)
  expect(one.s.status).toBe('completed')
  expect(one.reviews).toBe(0)
  expect(one.s.verdicts.map((v) => v.verifierId)).toEqual(['delivered'])
})
