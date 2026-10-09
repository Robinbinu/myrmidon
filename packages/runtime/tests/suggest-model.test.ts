import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type NextLogits, NextWordModel, predictWord, type WordTokenizer } from '../src/suggest-model.ts'

// A toy vocabulary: each id is one piece, as a byte-level tokenizer would decode it.
const PIECES = ['please', ' fix', ' the', ' bug', 's', ' test', '.', '\n', ' ok', 'ay']
const tokenizer: WordTokenizer = {
  encode: (text) => {
    const ids: number[] = []
    let rest = text
    while (rest) {
      const id = PIECES.findIndex((p) => rest.startsWith(p))
      if (id < 0) throw new Error(`no piece for ${rest}`)
      ids.push(id)
      rest = rest.slice(PIECES[id]?.length)
    }
    return ids
  },
  decode: (ids) => ids.map((id) => PIECES[id]).join(''),
}

/** Logits that put `p` on the token `next(ids)` names and spread the rest evenly. */
function scripted(next: (ids: readonly number[]) => number, p = 0.9): NextLogits & { seen: number[][] } {
  const seen: number[][] = []
  const fn = async (ids: readonly number[]) => {
    seen.push([...ids])
    const rest = (1 - p) / (PIECES.length - 1)
    return Float32Array.from(PIECES, (_, i) => Math.log(i === next(ids) ? p : rest))
  }
  return Object.assign(fn, { seen })
}

test('predictWord reads the draft without its trailing space and returns the word the model expects', async () => {
  const logits = scripted(() => 2)
  expect(await predictWord('please fix ', logits, tokenizer)).toBe('the')
  expect(logits.seen[0]).toEqual([0, 1])
})

test('a word may take several tokens and stops at the next space', async () => {
  // " ok" then "ay" makes "okay"; the following " the" starts another word.
  const order = [8, 9, 2]
  const logits = scripted((ids) => order[ids.length - 2] ?? 2)
  expect(await predictWord('please fix', logits, tokenizer)).toBe('okay')
  expect(logits.seen).toHaveLength(3)
})

test('nothing is offered when the model is unsure of the first token', async () => {
  expect(
    await predictWord(
      'please fix ',
      scripted(() => 2, 0.2),
      tokenizer,
    ),
  ).toBeUndefined()
})

test('punctuation ends a word without joining it, and is never a word itself', async () => {
  // " bug" then "." offers "bug": the full stop is the person's to type.
  const order = [3, 6]
  const then = scripted((ids) => order[ids.length - 3] ?? 6)
  expect(await predictWord('please fix the', then, tokenizer)).toBe('bug')
  expect(
    await predictWord(
      'please fix',
      scripted(() => 6),
      tokenizer,
    ),
  ).toBeUndefined()
  expect(
    await predictWord(
      'please fix',
      scripted(() => 7),
      tokenizer,
    ),
  ).toBeUndefined()
  expect(
    await predictWord(
      '',
      scripted(() => 2),
      tokenizer,
    ),
  ).toBeUndefined()
})

test('a word still going at the token limit is left out, not offered cut short', async () => {
  // " bug" then "s" for ever never reaches a boundary within two tokens.
  const endless = scripted((ids) => (ids.length === 3 ? 3 : 4))
  expect(await predictWord('please fix the', endless, tokenizer, { maxTokens: 2 })).toBeUndefined()
  // " bug", "s", then a space: "bugs" is whole.
  const order = [3, 4, 2]
  const whole = scripted((ids) => order[ids.length - 3] ?? 2)
  expect(await predictWord('please fix the', whole, tokenizer, { maxTokens: 2 })).toBe('bugs')
})

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('the model is missing until downloaded, and asking its status downloads nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-suggest-model-'))
  homes.push(home)
  const model = new NextWordModel(home)
  expect(model.downloaded).toBe(false)
  expect(model.status()).toEqual({ state: 'missing', bytes: 16_870_096 })
})

// The real model: downloads Pythia-14M (17 MB) once into a temporary home. Opt in.
test.skipIf(!process.env.MYR_SUGGEST_E2E)(
  'Pythia-14M downloads, checks out and guesses a likely next word in a few milliseconds',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'myr-suggest-model-'))
    homes.push(home)
    const model = new NextWordModel(home)
    await model.load()
    expect(model.status().state).toBe('ready')
    expect(await model.next('Thank you so ')).toBe('much')
    expect(await model.next('as soon as ')).toBe('possible')
    // Many nouns could follow; none is likely enough to offer.
    expect(await model.next('Can you please fix the ')).toBeUndefined()
    const started = performance.now()
    for (let i = 0; i < 20; i++) await model.next('Can you please fix the ')
    expect((performance.now() - started) / 20).toBeLessThan(50)
  },
  120_000,
)
