/**
 * A realtime speech-to-speech model (OpenAI Realtime, Gemini Live) as a call uses it: the person's audio in, the
 * model's speech, its transcripts and its tool calls out. One interface, so another provider is one more adapter.
 */
export interface RealtimeTool {
  readonly name: string
  readonly description: string
  /** JSON Schema (lowercase types), as the pipeline's tools are written. */
  readonly parameters: Record<string, unknown>
}

export interface RealtimeSetup {
  readonly instructions: string
  readonly tools: readonly RealtimeTool[]
  readonly voice: string
  readonly speed?: number
}

export type RealtimeEvent =
  /** The session is set up and takes audio. */
  | { readonly type: 'ready' }
  /** The person started speaking (`turn` names their turn); the model stops what it was saying. */
  | { readonly type: 'speech-started'; readonly turn: string }
  /** The person stopped speaking (for timing). */
  | { readonly type: 'speech-stopped' }
  /** The person's words in `turn`: so far, or `final`. */
  | { readonly type: 'heard'; readonly turn: string; readonly text: string; readonly final: boolean }
  /** The model's speech, as it comes. */
  | { readonly type: 'audio'; readonly pcm: Int16Array; readonly sampleRate: number }
  /** What the model said, once a part of its answer is done. */
  | { readonly type: 'said'; readonly text: string }
  | {
      readonly type: 'tool'
      readonly id: string
      readonly name: string
      readonly args: Record<string, unknown>
    }
  /** The model's answer is over (it may still be playing on the person's side). */
  | { readonly type: 'done' }
  /** The model was cut off (the person talked over it): what was sent to be played should stop. */
  | { readonly type: 'interrupted' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'closed'; readonly reason: string }

export interface RealtimeConnection {
  /** The sample rate `audio` takes. */
  readonly inputRate: number
  /** Opens the session; events arrive through `on` until `closed`. Rejects when it cannot open. */
  connect(setup: RealtimeSetup, on: (event: RealtimeEvent) => void): Promise<void>
  audio(pcm: Int16Array): void
  /** A tool call's result; the model answers once all of its answer's calls have theirs. */
  toolResult(id: string, name: string, output: string): void
  /**
   * A notice from Myrmidon (fixed wording, never the crew's or anyone else's text), and an answer asked for: how a
   * call says "the crew has news, call crew_updates" or "greet the person".
   */
  notice(text: string): void
  /** New instructions for the rest of the call, where the provider takes them mid-session. */
  instructions?(text: string): void
  /** Stops the model's answer (the person's side says they talked over it). */
  interrupt(): void
  close(): void
}

/** JSON Schema's lowercase types as Gemini's OpenAPI subset writes them (`OBJECT`, `STRING`…). */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).map(([k, v]) => [
      k,
      k === 'type' && typeof v === 'string'
        ? v.toUpperCase()
        : k === 'properties' && v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, geminiSchema(s)]),
            )
          : geminiSchema(v),
    ]),
  )
}

/** Samples from base64 16-bit little-endian PCM. */
export function pcmFrom(b64: string): Int16Array {
  const bytes = Buffer.from(b64, 'base64')
  const n = Math.floor(bytes.length / 2)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = bytes.readInt16LE(i * 2)
  return out
}
