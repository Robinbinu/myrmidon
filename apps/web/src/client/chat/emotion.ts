import { LEAD_COLOR } from '@myrmidon/protocol'
import { copy } from '../copy.ts'
import type { Mood } from '../ui/pixel.tsx'

/** What the mascot shows: an eye shape, an eye colour (hex, or a `var(--mood-…)` token), and a word on its status line. */
export interface Emotion {
  readonly mood: Mood
  readonly color: string
  readonly label: string
}

export const EMOTIONS = {
  ready: { mood: 'idle', color: LEAD_COLOR, label: copy.mascot.ready },
  listening: { mood: 'listening', color: 'var(--mood-listening)', label: copy.mascot.listening },
  curious: { mood: 'thinking', color: 'var(--mood-curious)', label: copy.mascot.curious },
  focused: { mood: 'working', color: 'var(--mood-focused)', label: copy.mascot.focused },
  concerned: { mood: 'waiting', color: 'var(--mood-concerned)', label: copy.mascot.concerned },
  love: { mood: 'love', color: 'var(--mood-love)', label: copy.mascot.love },
  happy: { mood: 'happy', color: 'var(--mood-happy)', label: copy.mascot.happy },
  proud: { mood: 'happy', color: 'var(--mood-happy)', label: copy.mascot.proud },
  wink: { mood: 'wink', color: 'var(--mood-wink)', label: copy.mascot.wink },
  surprised: { mood: 'surprised', color: 'var(--mood-curious)', label: copy.mascot.surprised },
  dizzy: { mood: 'surprised', color: 'var(--mood-love)', label: copy.mascot.dizzy },
  confused: { mood: 'surprised', color: 'var(--mood-love)', label: copy.mascot.confused },
  sneeze: { mood: 'idle', color: 'var(--mood-wink)', label: copy.mascot.sneeze },
  charging: { mood: 'surprised', color: 'var(--mood-happy)', label: copy.mascot.charging },
  popped: { mood: 'surprised', color: 'var(--mood-wink)', label: copy.mascot.popped },
  onCall: { mood: 'listening', color: LEAD_COLOR, label: copy.mascot.onCall },
  sad: { mood: 'error', color: 'var(--mood-sad)', label: copy.mascot.sad },
  sleepy: { mood: 'sleep', color: 'var(--mood-sleepy)', label: copy.mascot.sleepy },
  night: { mood: 'idle', color: 'var(--mood-night)', label: copy.mascot.night },
  busy: { mood: 'working', color: LEAD_COLOR, label: copy.mascot.busy },
} as const satisfies Record<string, Emotion>

const WARM = /\b(thanks?|thank you|thx|love|awesome|amazing|great|nice|cool|brilliant|perfect)\b|❤|♥|🙏|😊/
const ALARM = /\b(urgent|asap|broken|bug|crash(es|ed)?|error|fail(s|ed|ing)?|fix|wrong|down|outage)\b|!{2,}/
const ASK = /^(how|why|what|which|who|when|where|can|could|should|is|are|do|does)\b/

/** Reads the mood of what the user is typing, so the mascot reacts before anything is sent. */
export function readDraft(text: string): Emotion {
  const t = text.trim().toLowerCase()
  if (!t) return EMOTIONS.ready
  if (WARM.test(t)) return EMOTIONS.love
  if (ALARM.test(t)) return EMOTIONS.concerned
  if (t.endsWith('?') || ASK.test(t)) return EMOTIONS.curious
  if (t.length > 160) return EMOTIONS.focused
  return EMOTIONS.listening
}

export interface Surroundings {
  /** Colonies running right now, across all chats. */
  readonly working: number
  /** The most recent chat's latest status and how long ago it changed. */
  readonly latest?: { readonly status: string; readonly agoMs: number }
  readonly hour: number
}

/** The resting mood, from what the colony is doing and the time of day. */
export function ambient(s: Surroundings): Emotion {
  if (s.working > 0) {
    return { ...EMOTIONS.busy, label: copy.mascot.crewsWorking(s.working) }
  }
  if (s.latest && s.latest.agoMs < 120_000) {
    if (s.latest.status === 'completed') return EMOTIONS.proud
    if (s.latest.status === 'failed') return EMOTIONS.sad
  }
  if (s.hour < 5) return EMOTIONS.night
  return EMOTIONS.ready
}
