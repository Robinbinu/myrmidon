/**
 * Kitten TTS in a process of its own (run by KittenTts). kitten-tts-js's bundled eSpeak makes every unhandled
 * promise rejection fatal once loaded, and synthesis is CPU work, so neither belongs in the server.
 *
 * Started as `bun kitten-worker.ts <model folder>`; reads one JSON request per line on stdin
 * (`{ id, text, voice, speed }`) and answers each with one line on stdout: `{ id, rate, pcm }` (base64 16-bit mono)
 * or `{ id, error }`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'

interface Kitten {
  generate(
    text: string,
    opts: { voice?: string; speed?: number },
  ): Promise<{ data: Float32Array; sampling_rate: number }>
}
// The package exports these, but its type declarations leave out the constructor and the voice loader.
const { KittenTTS, loadNpz } = (await import('kitten-tts-js')) as unknown as {
  KittenTTS: new (session: unknown, voices: unknown, config: unknown) => Kitten
  loadNpz(buffer: ArrayBuffer): Promise<unknown>
}

const dir = process.argv[2]
if (!dir) throw new Error('usage: kitten-worker.ts <model folder>')
const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
  model_file: string
  voices?: string
}
// Built here rather than with KittenTTS.from_pretrained, which asks the native runtime for its WebAssembly backend.
const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(join(dir, config.model_file))))
const voicesFile = readFileSync(join(dir, config.voices ?? 'voices.npz'))
const tts = new KittenTTS(
  session,
  await loadNpz(
    voicesFile.buffer.slice(
      voicesFile.byteOffset,
      voicesFile.byteOffset + voicesFile.byteLength,
    ) as ArrayBuffer,
  ),
  config,
)
process.stdout.write(`${JSON.stringify({ ready: true })}\n`)

const decoder = new TextDecoder()
let buffered = ''
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true })
  const parts = buffered.split('\n')
  buffered = parts.pop() ?? ''
  for (const line of parts) {
    if (!line.trim()) continue
    const req = JSON.parse(line) as { id: number; text: string; voice?: string; speed?: number }
    try {
      const audio = await tts.generate(req.text, {
        ...(req.voice ? { voice: req.voice } : {}),
        ...(req.speed ? { speed: req.speed } : {}),
      })
      const pcm = Int16Array.from(audio.data, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))))
      const bytes = new Uint8Array(pcm.buffer)
      process.stdout.write(
        `${JSON.stringify({ id: req.id, rate: audio.sampling_rate, pcm: Buffer.from(bytes).toString('base64') })}\n`,
      )
    } catch (err) {
      process.stdout.write(
        `${JSON.stringify({ id: req.id, error: err instanceof Error ? err.message : String(err) })}\n`,
      )
    }
  }
}
