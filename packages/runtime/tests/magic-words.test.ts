import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import { magicWordsIn } from '../src/magic-words.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { clampThinkingLevelForModel } from '../src/omp/catalog.ts'
import { createMockModel } from '../src/omp/mock.ts'

test('magic words count only as standalone prose: never in code, markup, paths or identifiers, as in omp', () => {
  expect(magicWordsIn('ultrathink: why does the parser drop the last token?')).toEqual(['ultrathink'])
  expect(magicWordsIn('Please orchestrate the migration, and ultrathink.')).toEqual([
    'ultrathink',
    'orchestrate',
  ])
  expect(magicWordsIn('"orchestrate" the four phases')).toEqual(['orchestrate'])
  // Code spans, fences, XML/HTML sections.
  expect(magicWordsIn('rename `ultrathink` to deep')).toEqual([])
  expect(magicWordsIn('see:\n```ts\nconst orchestrate = 1\n```\nthanks')).toEqual([])
  expect(magicWordsIn('<note>ultrathink</note> fix it')).toEqual([])
  // Bound into identifiers, paths, calls and other words; and only lowercase, as omp matches.
  expect(magicWordsIn('open src/ultrathink.ts and call orchestrate() in my-orchestrate')).toEqual([])
  expect(magicWordsIn('ultrathinking about orchestrated runs')).toEqual([])
  expect(magicWordsIn('ULTRATHINK now')).toEqual([])
  // Prose beside a code span still counts.
  expect(magicWordsIn('ultrathink about `parse()`')).toEqual(['ultrathink'])
})

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-magic-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

async function ended(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (!['running', 'created'].includes(s.status)) return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not end')
}

/** A lead that answers at once, keeping each call's opening message and the effort it was asked to think at. */
function setup() {
  const resolver = new ModelResolver()
  const seen: { opening: string; reasoning: unknown }[] = []
  const lead = createMockModel({
    id: 'thinker',
    reasoning: true,
    handler: (ctx: LlmContext, options) => {
      const messages = ctx.messages as { role: string; content: unknown }[]
      seen.push({ opening: JSON.stringify(messages[0]?.content), reasoning: options?.reasoning })
      return {
        content: [{ type: 'toolCall', name: 'reply_user', arguments: { text: 'Done.', final: true } }],
      }
    },
  })
  // A model with a thinking dial, as the catalog describes Claude's: the mock itself has none.
  Object.assign(lead.model, { thinking: resolver.resolve('anthropic/claude-sonnet-4-6').model.thinking })
  resolver.register('mock/thinker', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'answer' })
  return { chats, seen, lead }
}

const config: TeamConfig = {
  mode: 'swarm',
  leadModel: 'mock/thinker',
  roster: [],
  judgeModel: 'mock/judge',
  thinking: 'low',
}

test('ultrathink thinks at the highest effort the model has, whatever the round or the picker says', async () => {
  const { chats, seen, lead } = setup()
  const plain = await chats.send('What does parse() return?', config)
  await ended(plain.colonyId)
  const quick = seen.at(-1)?.reasoning
  const deep = await chats.send('ultrathink: what does parse() return?', config)
  await ended(deep.colonyId)
  const top = clampThinkingLevelForModel(lead.model as never, 'max' as never)
  expect(top).toBeDefined()
  expect(quick).not.toBe(top)
  expect(seen.at(-1)?.reasoning).toBe(top)
  expect(seen.at(-1)?.opening).toContain('Multi-step reasoning: think carefully')
  // In a code span it is just a word.
  await ended((await chats.send('rename `ultrathink` in the parser', config)).colonyId)
  expect(seen.at(-1)?.reasoning).toBe(quick)
  await chats.stopAll()
})

test('orchestrate makes the round a team round led with room for a crew, and tells the lead the contract', async () => {
  const { chats, seen } = setup()
  const { colonyId } = await chats.send('orchestrate the move of every handler to the new router', config)
  const s = await ended(colonyId)
  // The chat's team picker said swarm and the classifier said a direct answer: orchestrate means a lead with a crew.
  expect(s.tier).toBe('team')
  expect(s.agents.lead?.info.role).toBe('lead')
  // The lead hears it; its new crewmate does not.
  const opening = seen.find((c) => c.opening.includes('[user] orchestrate'))?.opening ?? ''
  expect(Object.values(s.agents).some((a) => a.info.role === 'worker')).toBe(true)
  expect(opening).toContain('The person asked you to orchestrate')
  expect(opening).toContain('Check each phase before the next')
  expect(opening).toContain('add_crewmate')
  // Said in code, the round is sized as usual.
  const quiet = await chats.send('what does `orchestrate` mean in this codebase?', config)
  expect((await ended(quiet.colonyId)).tier).toBe('answer')
  await chats.stopAll()
})
