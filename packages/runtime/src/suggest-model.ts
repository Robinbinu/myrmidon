import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Tokenizer } from '@huggingface/tokenizers'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import {
  SUGGEST_MODEL,
  SUGGEST_MODEL_CONTEXT_CHARS,
  SUGGEST_MODEL_MAX_TOKENS,
  SUGGEST_MODEL_MIN_P,
} from './config.ts'

/** The next token's probabilities after `ids`, as raw logits over the vocabulary. */
export type NextLogits = (ids: readonly number[]) => Promise<Float32Array>

export interface WordTokenizer {
  encode(text: string): readonly number[]
  decode(ids: readonly number[]): string
}

/** Letters, digits and the joiners words carry inside them. */
const WORDISH = /^[\p{L}\p{N}'’_-]*$/u
const WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’_-]*$/u

/**
 * The word a language model expects next after `text`, greedily, or undefined when it is not sure enough: the first
 * token must reach `minP`, and the word ends where the model would go on with a space, a new line or punctuation. A
 * word still going after `maxTokens` is left out rather than offered cut short.
 */
export async function predictWord(
  text: string,
  logits: NextLogits,
  tokenizer: WordTokenizer,
  {
    minP = SUGGEST_MODEL_MIN_P,
    maxTokens = SUGGEST_MODEL_MAX_TOKENS,
    contextChars = SUGGEST_MODEL_CONTEXT_CHARS,
  } = {},
): Promise<string | undefined> {
  // The model reads " word" as one token, so the trailing space goes and the first piece brings its own.
  const ids = [...tokenizer.encode(text.slice(-contextChars).trimEnd())]
  if (!ids.length) return undefined
  let word = ''
  for (let step = 0; ; step++) {
    const { id, p } = top(await logits(ids))
    if (step === 0 && p < minP) return undefined
    const piece = tokenizer.decode([id])
    const ends =
      piece.includes('\n') || !WORDISH.test((word + piece).trim()) || (step > 0 && /^\s/.test(piece))
    if (ends) break
    if (step === maxTokens) return undefined
    word += piece
    ids.push(id)
  }
  const w = word.trim()
  return WORD.test(w) && w.length >= 2 ? w : undefined
}

/** The likeliest token and its softmax probability. */
function top(logits: Float32Array): { id: number; p: number } {
  let id = 0
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i] ?? Number.NEGATIVE_INFINITY
    if (v > max) {
      max = v
      id = i
    }
  }
  let sum = 0
  for (const v of logits) sum += Math.exp(v - max)
  return { id, p: 1 / sum }
}

export type NextWordModelState = 'missing' | 'downloading' | 'ready' | 'failed'

/**
 * The composer's optional next-word model (`SUGGEST_MODEL`, Pythia-14M): downloaded once into `<home>/models` and
 * checked against its pinned hashes, then run on the CPU with onnxruntime, a few milliseconds a word.
 */
export class NextWordModel {
  private _loaded?: Promise<{ logits: NextLogits; tokenizer: WordTokenizer }>
  private _failed?: string
  private readonly _dir: string

  constructor(home: string) {
    this._dir = join(home, 'models', SUGGEST_MODEL.name)
  }

  get downloaded(): boolean {
    return SUGGEST_MODEL.files.every((f) => existsSync(join(this._dir, f.path)))
  }

  /** Whether it is on disk yet, its download size, and why it failed when it did. */
  status(): { state: NextWordModelState; bytes: number; error?: string } {
    const bytes = SUGGEST_MODEL.files.reduce((n, f) => n + f.bytes, 0)
    if (this._failed) return { state: 'failed', bytes, error: this._failed }
    if (this.downloaded) return { state: 'ready', bytes }
    return { state: this._loaded ? 'downloading' : 'missing', bytes }
  }

  /** Downloads (once) and loads the model; a failure is kept for `status` and the next call tries again. */
  load(): Promise<{ logits: NextLogits; tokenizer: WordTokenizer }> {
    this._failed = undefined
    this._loaded ??= this._load().catch((err) => {
      this._loaded = undefined
      this._failed = err instanceof Error ? err.message : String(err)
      throw err
    })
    return this._loaded
  }

  async next(text: string): Promise<string | undefined> {
    const { logits, tokenizer } = await this.load()
    return predictWord(text, logits, tokenizer)
  }

  private async _load(): Promise<{ logits: NextLogits; tokenizer: WordTokenizer }> {
    for (const f of SUGGEST_MODEL.files) await this._fetch(f)
    const [ort, { Tokenizer }] = await Promise.all([
      import('onnxruntime-node'),
      import('@huggingface/tokenizers'),
    ])
    const read = (path: string) => readFileSync(join(this._dir, path))
    const tok: Tokenizer = new Tokenizer(
      JSON.parse(read('tokenizer.json').toString('utf8')),
      JSON.parse(read('tokenizer_config.json').toString('utf8')),
    )
    const session = await ort.InferenceSession.create(new Uint8Array(read('onnx/model_quantized.onnx')))
    const { layers, heads, headSize } = SUGGEST_MODEL
    // Each call reads the whole (short) draft afresh, so the key/value cache it also wants is always empty.
    const past: Record<string, Tensor> = {}
    for (let i = 0; i < layers; i++)
      for (const kind of ['key', 'value'])
        past[`past_key_values.${i}.${kind}`] = new ort.Tensor('float32', new Float32Array(0), [
          1,
          heads,
          0,
          headSize,
        ])
    const logits: NextLogits = async (ids) => {
      const n = ids.length
      const long = (f: (i: number) => number) =>
        new ort.Tensor(
          'int64',
          BigInt64Array.from(ids, (_, i) => BigInt(f(i))),
          [1, n],
        )
      const out = await session.run({
        ...past,
        input_ids: long((i) => ids[i] ?? 0),
        attention_mask: long(() => 1),
        position_ids: long((i) => i),
      } satisfies InferenceSession.FeedsType)
      const all = (out.logits as Tensor).data as Float32Array
      const vocab = all.length / n
      return all.subarray((n - 1) * vocab, n * vocab)
    }
    return {
      logits,
      tokenizer: {
        encode: (text) => tok.encode(text, { add_special_tokens: false }).ids,
        decode: (ids) => tok.decode([...ids]),
      },
    }
  }

  private async _fetch(f: (typeof SUGGEST_MODEL.files)[number]): Promise<void> {
    const file = join(this._dir, f.path)
    if (existsSync(file)) return
    const res = await fetch(SUGGEST_MODEL.base + f.path)
    if (!res.ok) throw new Error(`downloading the suggestion model failed (${res.status})`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== f.sha256) throw new Error(`the suggestion model download did not match its hash (${got})`)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.part`, bytes)
    renameSync(`${file}.part`, file)
  }
}
