import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { VOICE_VAD_SHA256, VOICE_VAD_URL } from '../config.ts'
import { fetchBytes } from './download.ts'

/** Samples Silero VAD takes per chunk at 16 kHz (32 ms), and the samples of the chunk before that go with each. */
export const VAD_CHUNK = 512
const VAD_CONTEXT = 64

/** How likely a 32 ms chunk of 16 kHz audio is speech, 0–1. */
export interface SpeechDetector {
  /** A detector for one stream: it carries the model's state from chunk to chunk. */
  stream(): { chance(chunk: Float32Array): Promise<number> }
}

/**
 * Silero VAD (snakers4/silero-vad, MIT): a 1.3 MB ONNX speech detector (its 16 kHz model) that tells speech from noise, music and
 * tones, where a level alone cannot. Downloaded once into `<home>/voice`, checked against its pinned hash, and run
 * with onnxruntime-node in this process (a chunk takes about 0.1 ms).
 */
export class SileroVad implements SpeechDetector {
  private _session?: Promise<InferenceSession>
  private _ort?: typeof import('onnxruntime-node')
  private readonly _file: string

  constructor(
    home: string,
    private readonly url = VOICE_VAD_URL,
    private readonly sha256 = VOICE_VAD_SHA256,
  ) {
    this._file = join(home, 'voice', 'silero_vad_16k_op15.onnx')
  }

  get ready(): boolean {
    return existsSync(this._file)
  }

  /** Downloads (once) and loads the model; later calls share it. */
  load(): Promise<InferenceSession> {
    this._session ??= this._load().catch((err) => {
      this._session = undefined
      throw err
    })
    return this._session
  }

  stream() {
    let state: Tensor | undefined
    let context = new Float32Array(VAD_CONTEXT)
    return {
      chance: async (chunk: Float32Array): Promise<number> => {
        const session = await this.load()
        const ort = this._ort
        if (!ort) throw new Error('the speech detector is not loaded')
        // Silero (v5 on) reads each chunk with the end of the one before it.
        const input = new Float32Array(VAD_CONTEXT + chunk.length)
        input.set(context, 0)
        input.set(chunk, VAD_CONTEXT)
        context = chunk.slice(-VAD_CONTEXT)
        const out = await session.run({
          input: new ort.Tensor('float32', input, [1, input.length]),
          state: state ?? new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]),
          sr: new ort.Tensor('int64', BigInt64Array.from([16_000n]), []),
        })
        state = out.stateN as Tensor
        return Number((out.output as Tensor).data[0] ?? 0)
      },
    }
  }

  private async _load(): Promise<InferenceSession> {
    if (!existsSync(this._file)) {
      const bytes = await fetchBytes(this.url, 'the speech detector')
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== this.sha256) throw new Error(`the speech detector download did not match its hash (${got})`)
      mkdirSync(join(this._file, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(`${this._file}.part`, bytes)
      renameSync(`${this._file}.part`, this._file)
    }
    this._ort ??= await import('onnxruntime-node')
    return this._ort.InferenceSession.create(new Uint8Array(readFileSync(this._file)))
  }
}
