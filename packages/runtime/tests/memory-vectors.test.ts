import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_PROMPT_COUNT } from '../src/config.ts'
import { MemoryStore } from '../src/memory.ts'
import { type Embedder, MeaningRecall } from '../src/memory-vectors.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-vectors-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

/** A toy embedding: one axis per topic, so "car" and "automobile" mean the same and share no word. */
const TOPICS: Record<string, string[]> = {
  vehicle: ['car', 'automobile', 'vehicle', 'drive'],
  food: ['pizza', 'lunch', 'eat', 'dinner'],
  code: ['typescript', 'bun', 'test', 'code'],
}
function toyEmbedder(calls: string[][]): Embedder {
  return {
    model: 'toy/embed',
    async embed(texts) {
      calls.push([...texts])
      return texts.map((t) => {
        const words = t.toLowerCase().match(/[a-z]+/g) ?? []
        return Object.values(TOPICS).map((topic) => words.filter((w) => topic.includes(w)).length + 0.01)
      })
    },
  }
}

function seed(store: MemoryStore) {
  const add = (text: string, kind = 'fact') =>
    store.add({ text, kind, status: 'active', source: { by: 'person' } })
  return {
    car: add('The family automobile is a blue Volvo.'),
    food: add('Friday lunch is pizza with the team.'),
    code: add('Run bun test from the repository root.', 'lesson'),
  }
}

test('without an embedding model, the async recall is word matching, unchanged', async () => {
  const calls: string[][] = []
  const store = new MemoryStore(home, new MeaningRecall(join(home, 'v.json'), () => undefined))
  const plain = new MemoryStore(home)
  seed(store)
  expect((await store.searchFor('car', 10)).map((m) => m.id)).toEqual(
    plain.search('car', 10).map((m) => m.id),
  )
  expect(await store.searchFor('car', 10)).toEqual([])
  expect(calls).toEqual([])
  expect(store.lookAlike(store.kept())).toBe(false)
})

test('with one, recall finds a memory that means the same in other words, and embeds each memory once', async () => {
  const calls: string[][] = []
  const store = new MemoryStore(home, new MeaningRecall(join(home, 'v.json'), () => toyEmbedder(calls)))
  const ids = seed(store)
  // "car" shares no word with "automobile": word matching finds nothing, meaning finds the Volvo.
  expect(store.search('my car', 10)).toEqual([])
  const found = await store.searchFor('my car', 10)
  expect(found[0]?.id).toBe(ids.car.id)
  expect(found.map((m) => m.id)).not.toContain(ids.food.id)
  // Three memories and the query; a second search embeds only its query.
  expect(calls.flat().length).toBe(4)
  await store.searchFor('what do we eat for dinner', 10)
  expect(calls.at(-1)).toEqual(['what do we eat for dinner'])
  expect(calls.flat().length).toBe(5)
  // An edited memory is embedded again; a removed one's vector is dropped.
  store.update(ids.food.id, { text: 'Friday dinner is pizza with the team.' })
  store.remove(ids.code.id)
  await store.searchFor('drive', 10)
  expect(calls.at(-2)).toEqual(['Friday dinner is pizza with the team.'])
  const file = JSON.parse(readFileSync(join(home, 'v.json'), 'utf8')) as { vectors: Record<string, unknown> }
  expect(Object.keys(file.vectors).sort()).toEqual([ids.car.id, ids.food.id].sort())
})

test('a failing embedding model falls back to word matching', async () => {
  const failing: Embedder = {
    model: 'toy/down',
    embed: async () => {
      throw new Error('503 from the provider')
    },
  }
  const store = new MemoryStore(home, new MeaningRecall(join(home, 'v.json'), () => failing))
  const ids = seed(store)
  const warn = console.warn
  console.warn = () => {}
  try {
    expect((await store.searchFor('pizza', 10)).map((m) => m.id)).toEqual([ids.food.id])
  } finally {
    console.warn = warn
  }
})

test("a round's prompt carries every memory while they fit, without calling the model", async () => {
  const calls: string[][] = []
  const store = new MemoryStore(home, new MeaningRecall(join(home, 'v.json'), () => toyEmbedder(calls)))
  seed(store)
  expect((await store.recallFor(undefined, 'my car')).length).toBe(3)
  expect(calls).toEqual([])
  // Past the room, the relevant ones are picked by meaning too.
  for (let i = 0; i < MEMORY_PROMPT_COUNT + 2; i++)
    store.add({
      text: `Unrelated note number ${i} about typescript code`,
      kind: 'fact',
      status: 'active',
      source: { by: 'person' },
    })
  const carried = await store.recallFor(undefined, 'my car')
  expect(carried.some((m) => m.text.includes('Volvo'))).toBe(true)
  expect(store.recall(undefined, 'my car').some((m) => m.text.includes('Volvo'))).toBe(false)
})

test('memories close in meaning look alike for tidying up, by the vectors already kept', async () => {
  const calls: string[][] = []
  const store = new MemoryStore(home, new MeaningRecall(join(home, 'v.json'), () => toyEmbedder(calls)))
  seed(store)
  // No vectors kept yet: nothing is embedded just to check.
  expect(store.lookAlike(store.kept())).toBe(false)
  await store.searchFor('car', 10)
  expect(store.lookAlike(store.kept())).toBe(false)
  store.add({ text: 'We drive the car to work.', kind: 'fact', status: 'active', source: { by: 'person' } })
  await store.searchFor('car', 10)
  expect(store.lookAlike(store.kept())).toBe(true)
})
