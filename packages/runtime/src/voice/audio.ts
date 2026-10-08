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
