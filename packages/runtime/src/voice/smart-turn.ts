import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { VOICE_SMART_TURN_SHA256, VOICE_SMART_TURN_URL } from '../config.ts'
import { fetchBytes } from './download.ts'
import { MELS, whisperFeatures } from './whisper-features.ts'

/** How sure (0–1) a model is that the person has finished their turn, from its audio so far. */
export interface TurnJudge {
  finished(audio: Int16Array): Promise<number>
}

const SECONDS = 8

/**
 * Smart Turn v3 (Pipecat, pipecat-ai/smart-turn-v3, BSD-2-Clause): a Whisper-tiny encoder that hears from the last
 * 8 s of a turn whether the person has finished their thought, so a short pause can end a finished sentence while
 * "I think we should…" keeps listening. 8.7 MB, downloaded once into `<home>/voice` and checked against its pinned
 * hash; about 50 ms a turn on a laptop CPU.
 */
export class SmartTurn implements TurnJudge {
  private _session?: Promise<InferenceSession>
  private _ort?: typeof import('onnxruntime-node')
  private readonly _file: string

  constructor(
    home: string,
    private readonly url = VOICE_SMART_TURN_URL,
    private readonly sha256 = VOICE_SMART_TURN_SHA256,
  ) {
    this._file = join(home, 'voice', 'smart-turn-v3.2-cpu.onnx')
  }

  get ready(): boolean {
    return existsSync(this._file)
  }

  /** Downloads (once) and loads the model. */
  load(): Promise<InferenceSession> {
    this._session ??= this._load().catch((err) => {
      this._session = undefined
      throw err
    })
    return this._session
  }

  async finished(audio: Int16Array): Promise<number> {
    const session = await this.load()
    const ort = this._ort
    if (!ort) throw new Error('the turn model is not loaded')
    const features = whisperFeatures(
      Float32Array.from(audio, (x) => x / 32768),
      SECONDS,
    )
    const out = await session.run({
      input_features: new ort.Tensor('float32', features, [1, MELS, SECONDS * 100]),
    })
    // Named logits, but the exported model ends in a sigmoid: this is already a probability.
    return Number((out.logits as Tensor).data[0] ?? 0)
  }

  private async _load(): Promise<InferenceSession> {
    if (!existsSync(this._file)) {
      const bytes = await fetchBytes(this.url, 'the turn model')
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== this.sha256) throw new Error(`the turn model download did not match its hash (${got})`)
      mkdirSync(join(this._file, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(`${this._file}.part`, bytes)
      renameSync(`${this._file}.part`, this._file)
    }
    this._ort ??= await import('onnxruntime-node')
    return this._ort.InferenceSession.create(new Uint8Array(readFileSync(this._file)))
  }
}
