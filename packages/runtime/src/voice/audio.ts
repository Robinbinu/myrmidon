/** 16-bit mono PCM as a WAV file, which every transcription endpoint accepts. */
export function wav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const v = new DataView(bytes.buffer)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  new Int16Array(bytes.buffer, 44, pcm.length).set(pcm)
  return bytes
}

/** Reads a WAV file of 16-bit or 32-bit float PCM into 16-bit mono (the first channel). */
export function parseWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let at = 12
  let format = 0
  let channels = 1
  let sampleRate = 0
  let bits = 16
  while (at + 8 <= bytes.length) {
    const id = tag(at)
    const size = v.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      format = v.getUint16(body, true)
      channels = v.getUint16(body + 2, true)
      sampleRate = v.getUint32(body + 4, true)
      bits = v.getUint16(body + 14, true)
    } else if (id === 'data') {
      // Streamed WAVs leave the data size unset (0 or 0xFFFFFFFF): the data runs to the end.
      const end = size === 0 || size === 0xffffffff ? bytes.length : Math.min(bytes.length, body + size)
      const frame = (bits / 8) * channels
      const count = Math.floor((end - body) / frame)
      const pcm = new Int16Array(count)
      for (let i = 0; i < count; i++) {
        const o = body + i * frame
        if (format === 3 && bits === 32) pcm[i] = clamp16(v.getFloat32(o, true))
        else if (format === 1 && bits === 16) pcm[i] = v.getInt16(o, true)
        else throw new Error(`unsupported WAV format ${format}/${bits}-bit`)
      }
      return { pcm, sampleRate }
    }
    at = body + size + (size % 2)
  }
  throw new Error('the WAV file has no audio')
}

/** Float samples in [-1, 1] as 16-bit. */
export function toInt16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, clamp16)
}

function clamp16(x: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(x * 32767)))
}

/**
 * Cuts the quiet a speech engine leaves around a sentence (Kitten leaves most of a second before it), keeping a little
 * so sentences played back to back still breathe.
 */
export function trimSilence(
  pcm: Int16Array,
  sampleRate: number,
  keepStartMs = 50,
  keepEndMs = 150,
): Int16Array {
  const window = Math.max(1, Math.round(sampleRate / 100))
  const loud = (from: number) => {
    let sum = 0
    const end = Math.min(pcm.length, from + window)
    for (let i = from; i < end; i++) sum += (pcm[i] ?? 0) ** 2
    return Math.sqrt(sum / Math.max(1, end - from)) >= SILENCE_RMS
  }
  let start = 0
  while (start < pcm.length && !loud(start)) start += window
  if (start >= pcm.length) return pcm
  let end = pcm.length
  while (end > start && !loud(Math.max(start, end - window))) end -= window
  const from = Math.max(0, start - Math.round((keepStartMs / 1000) * sampleRate))
  const to = Math.min(pcm.length, end + Math.round((keepEndMs / 1000) * sampleRate))
  return pcm.subarray(from, to)
}

/** Below this level (RMS of 16-bit samples) a 10 ms stretch of synthesized speech counts as quiet. */
const SILENCE_RMS = 300

/** G.711 μ-law's bias and the largest magnitude it codes (ITU-T G.711, as Sun's g711.c). */
const MULAW_BIAS = 0x84
const MULAW_CLIP = 32635

/** 16-bit samples as G.711 μ-law bytes, a phone line's 8 kHz audio (Twilio Media Streams' `audio/x-mulaw`). */
export function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i] ?? 0
    const sign = sample < 0 ? 0x80 : 0
    if (sign) sample = -sample
    sample = Math.min(sample, MULAW_CLIP) + MULAW_BIAS
    let exponent = 7
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--
    const mantissa = (sample >> (exponent + 3)) & 0x0f
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff
  }
  return out
}

/** G.711 μ-law bytes as 16-bit samples. */
export function mulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const u = ~(bytes[i] ?? 0) & 0xff
    const exponent = (u >> 4) & 0x07
    const magnitude = ((((u & 0x0f) << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS
    out[i] = u & 0x80 ? -magnitude : magnitude
  }
  return out
}

/** Zero crossings of the resampling kernel on each side: more is a sharper filter, and more work per sample. */
const RESAMPLE_ZEROS = 8

/**
 * Changes a stream's sample rate as it arrives (a phone line's 8 kHz up to the 16 kHz the speech detector and the
 * turn model expect, or a voice's 24 kHz down to the line's 8 kHz), with a Hann-windowed sinc. Going down, the
 * kernel is widened to cut at the new rate's Nyquist, so what the line cannot carry does not fold back in as noise.
 * Each push keeps the input the next samples still need, so a stream sent in 20 ms frames has no seams.
 */
export class Resampler {
  private readonly _ratio: number
  private readonly _cutoff: number
  /** The kernel's half-width, in input samples. */
  readonly half: number
  private _buf: Float32Array
  /** The stream position of `_buf[0]`; quiet is assumed before the stream starts. */
  private _first: number
  private _made = 0

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    this._ratio = from / to
    this._cutoff = Math.min(1, to / from)
    this.half = Math.ceil(RESAMPLE_ZEROS / this._cutoff)
    this._buf = new Float32Array(this.half)
    this._first = -this.half
  }

  push(pcm: Int16Array): Int16Array {
    if (this.from === this.to) return pcm
    const buf = new Float32Array(this._buf.length + pcm.length)
    buf.set(this._buf)
    buf.set(pcm, this._buf.length)
    const end = this._first + buf.length
    const out: number[] = []
    for (;;) {
      const center = this._made * this._ratio
      if (Math.floor(center + this.half) >= end) break
      let sum = 0
      let weight = 0
      for (let j = Math.ceil(center - this.half); j <= center + this.half; j++) {
        const x = j - center
        const t = this._cutoff * x
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
        const w = sinc * 0.5 * (1 + Math.cos((Math.PI * x) / this.half))
        sum += (buf[j - this._first] ?? 0) * w
        weight += w
      }
      out.push(weight ? sum / weight : 0)
      this._made++
    }
    const keep = Math.max(this._first, Math.floor(this._made * this._ratio - this.half))
    this._buf = buf.slice(keep - this._first)
    this._first = keep
    return Int16Array.from(out, (x) => Math.max(-32768, Math.min(32767, Math.round(x))))
  }
}

/** A whole clip at another sample rate (one sentence of speech), its end followed by quiet. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm
  const r = new Resampler(from, to)
  const length = Math.floor((pcm.length * to) / from)
  const head = r.push(pcm)
  const tail = r.push(new Int16Array(r.half + 1))
  const out = new Int16Array(length)
  out.set(head.subarray(0, length))
  if (head.length < length) out.set(tail.subarray(0, length - head.length), head.length)
  return out
}
