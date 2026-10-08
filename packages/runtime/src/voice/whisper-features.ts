/**
 * Whisper's log-mel features (as transformers' WhisperFeatureExtractor makes them), for Smart Turn, whose model is a
 * Whisper encoder: 16 kHz audio padded on the right (or cut, keeping the end) to `seconds`, normalized to zero mean
 * and unit variance over its real part, then a 400-point STFT every 160 samples (Hann window, reflect-padded),
 * 80 Slaney mel bands up to 8 kHz, log10, floored 8 below the peak, and scaled as (x + 4) / 4.
 */

const RATE = 16_000
const N_FFT = 400
const HOP = 160
const BINS = N_FFT / 2 + 1
export const MELS = 80

let tables: { cos: Float32Array; sin: Float32Array; window: Float32Array; mel: Float32Array } | undefined

/** The DFT twiddles, the periodic Hann window and the mel filter bank, built once. */
function build() {
  if (tables) return tables
  const cos = new Float32Array(BINS * N_FFT)
  const sin = new Float32Array(BINS * N_FFT)
  for (let k = 0; k < BINS; k++)
    for (let n = 0; n < N_FFT; n++) {
      const a = (2 * Math.PI * k * n) / N_FFT
      cos[k * N_FFT + n] = Math.cos(a)
      sin[k * N_FFT + n] = Math.sin(a)
    }
  const window = Float32Array.from(
    { length: N_FFT },
    (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT),
  )
  tables = { cos, sin, window, mel: melFilters() }
  return tables
}

/** Slaney's mel scale: linear below 1 kHz, logarithmic above. */
const hzToMel = (hz: number) => (hz < 1000 ? (3 * hz) / 200 : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27))
const melToHz = (mel: number) =>
  mel < 15 ? (200 * mel) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15))

/** Triangular filters, Slaney-normalized, as [mel][bin]. */
function melFilters(): Float32Array {
  const lo = hzToMel(0)
  const hi = hzToMel(RATE / 2)
  const freqs = Array.from({ length: MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (MELS + 1)))
  const fft = Array.from({ length: BINS }, (_, i) => ((RATE / 2) * i) / (BINS - 1))
  const out = new Float32Array(MELS * BINS)
  for (let m = 0; m < MELS; m++) {
    const [a, b, c] = [freqs[m] ?? 0, freqs[m + 1] ?? 0, freqs[m + 2] ?? 0]
    const norm = 2 / (c - a)
    for (let k = 0; k < BINS; k++) {
      const f = fft[k] ?? 0
      const down = (f - a) / (b - a)
      const up = (c - f) / (c - b)
      out[m * BINS + k] = Math.max(0, Math.min(down, up)) * norm
    }
  }
  return out
}

/** Features for the last `seconds` of `audio` (16 kHz floats), as [MELS][frames] with frames = seconds × 100. */
export function whisperFeatures(audio: Float32Array, seconds = 8): Float32Array {
  const { cos, sin, window, mel } = build()
  const length = seconds * RATE
  const real = audio.subarray(Math.max(0, audio.length - length))
  // Normalized over the real audio; the padding stays zero.
  let mean = 0
  for (const x of real) mean += x
  mean /= Math.max(1, real.length)
  let variance = 0
  for (const x of real) variance += (x - mean) ** 2
  variance /= Math.max(1, real.length)
  const scale = 1 / Math.sqrt(variance + 1e-7)
  const padded = new Float32Array(length + N_FFT)
  const half = N_FFT / 2
  for (let i = 0; i < real.length; i++) padded[half + i] = ((real[i] ?? 0) - mean) * scale
  // Reflect padding at both ends, as numpy's "reflect".
  for (let i = 1; i <= half; i++) {
    padded[half - i] = padded[half + i] ?? 0
    padded[half + length - 1 + i] = padded[half + length - 1 - i] ?? 0
  }
  const frames = length / HOP
  const out = new Float32Array(MELS * frames)
  const power = new Float32Array(BINS)
  const frame = new Float32Array(N_FFT)
  // Frames past the audio (and its reflection) are all zero: their power is zero, so skip the transform.
  const lastLive = Math.ceil((real.length + N_FFT) / HOP)
  let peak = Number.NEGATIVE_INFINITY
  for (let t = 0; t < frames; t++) {
    if (t <= lastLive) {
      const start = t * HOP
      for (let n = 0; n < N_FFT; n++) frame[n] = (padded[start + n] ?? 0) * (window[n] ?? 0)
      for (let k = 0; k < BINS; k++) {
        let re = 0
        let im = 0
        const row = k * N_FFT
        for (let n = 0; n < N_FFT; n++) {
          const x = frame[n] ?? 0
          re += x * (cos[row + n] ?? 0)
          im -= x * (sin[row + n] ?? 0)
        }
        power[k] = re * re + im * im
      }
    } else power.fill(0)
    for (let m = 0; m < MELS; m++) {
      let sum = 0
      const row = m * BINS
      for (let k = 0; k < BINS; k++) sum += (mel[row + k] ?? 0) * (power[k] ?? 0)
      const v = Math.log10(Math.max(sum, 1e-10))
      out[m * frames + t] = v
      if (v > peak) peak = v
    }
  }
  const floor = peak - 8
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i] ?? 0, floor) + 4) / 4
  return out
}
