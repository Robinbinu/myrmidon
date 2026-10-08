import { copy } from '../copy.ts'

/**
 * What a speech engine's error means for the person, and what to do about it. The raw message (uv's or the model
 * server's last lines, an HTTP status) is for details only.
 */
export function engineTrouble(engine: 'phonon' | 'kitten', raw: string): { cause: string; fix: string } {
  const t = copy.settings.voice.trouble
  if (engine === 'kitten') return t.kitten
  return /\buv is not installed\b/.test(raw) ? t.noUv : t.phonon
}
