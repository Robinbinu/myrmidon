import { useMemo, useRef } from 'react'
import type { MascotLook } from '../mascot.ts'
import { MASCOT_SOUNDS as S } from '../ui-config.ts'

/**
 * The mascot's soft blips, made on the fly with the Web Audio API: no audio files. Nothing here touches Web Audio
 * until a sound is asked for with sounds on; the one AudioContext is made then and kept.
 */

export type Blip = 'type' | 'up' | 'down'

let context: AudioContext | undefined

function audio(): AudioContext | undefined {
  if (!context) {
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return undefined
    context = new Ctor()
  }
  // A context made before the person touched the page starts suspended; their next key or click lets it play.
  if (context.state === 'suspended') void context.resume().catch(() => {})
  return context
}

/** One note: a quick attack and a soft exponential tail, so it never clicks. */
function note(ctx: AudioContext, at: number, hz: number, ms: number, peak: number, wave: OscillatorType) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = wave
  osc.frequency.setValueAtTime(hz, at)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + ms / 1000 + 0.02)
}

/** Plays a blip at a volume: a typing tick, or two notes rising (pleased) or falling (not). */
export function playBlip(
  kind: Blip,
  volume: MascotLook['sounds']['volume'],
  random: () => number = Math.random,
) {
  const ctx = audio()
  if (!ctx) return
  const peak = S.volume[volume]
  const now = ctx.currentTime
  if (kind === 'type') {
    const [lo, hi] = S.typing.hz
    note(ctx, now, lo + (hi - lo) * random(), S.typing.ms, peak * 0.6, 'triangle')
    return
  }
  const [first, second] = kind === 'up' ? S.reaction.up : S.reaction.down
  note(ctx, now, first, S.reaction.ms, peak, 'sine')
  note(ctx, now + S.reaction.gapMs / 1000, second, S.reaction.ms, peak, 'sine')
}

/**
 * The blips the mascot makes, as its sound settings allow: `react` when it reacts, `type` while the person types (at
 * most every `typingEveryMs`). Both do nothing, and touch no audio, while sounds are off.
 */
export function useMascotSounds(sounds: MascotLook['sounds']): {
  react(kind: 'up' | 'down'): void
  type(): void
} {
  const lastType = useRef(0)
  return useMemo(
    () => ({
      react(kind) {
        if (sounds.enabled && sounds.reactions) playBlip(kind, sounds.volume)
      },
      type() {
        if (!sounds.enabled || !sounds.typing) return
        const now = Date.now()
        if (now - lastType.current < S.typingEveryMs) return
        lastType.current = now
        playBlip('type', sounds.volume)
      },
    }),
    [sounds.enabled, sounds.reactions, sounds.typing, sounds.volume],
  )
}
