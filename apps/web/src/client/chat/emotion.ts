import { LEAD_COLOR } from '@myrmidon/protocol'
import type { Mood } from '../ui/pixel.tsx'

/** What the mascot shows: an eye shape, an eye colour, and a word on its status line. */
export interface Emotion {
  readonly mood: Mood
  readonly color: string
  readonly label: string
}

export const EMOTIONS = {
  ready: { mood: 'idle', color: LEAD_COLOR, label: 'ready' },
  listening: { mood: 'listening', color: '#ffe2a8', label: 'listening' },
  curious: { mood: 'thinking', color: '#7fdcff', label: 'curious' },
  focused: { mood: 'working', color: '#f4f4f6', label: 'focused' },
  concerned: { mood: 'waiting', color: '#ff8a4c', label: 'on it' },
  love: { mood: 'love', color: '#ff7eb6', label: 'love' },
  happy: { mood: 'happy', color: '#c6f432', label: 'hehe' },
  proud: { mood: 'happy', color: '#c6f432', label: 'done!' },
  wink: { mood: 'wink', color: '#ffcf5c', label: 'wink' },
  surprised: { mood: 'surprised', color: '#7fdcff', label: 'oh!' },
  dizzy: { mood: 'surprised', color: '#ff7eb6', label: 'whoa' },
  sad: { mood: 'error', color: '#ff6369', label: 'oh no' },
  sleepy: { mood: 'sleep', color: '#6f7fb8', label: 'zzz' },
  night: { mood: 'idle', color: '#8fa0d8', label: 'late night' },
  busy: { mood: 'working', color: LEAD_COLOR, label: 'working' },
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
    return { ...EMOTIONS.busy, label: s.working === 1 ? '1 crew working' : `${s.working} crews working` }
  }
  if (s.latest && s.latest.agoMs < 120_000) {
    if (s.latest.status === 'completed') return EMOTIONS.proud
    if (s.latest.status === 'failed') return EMOTIONS.sad
  }
  if (s.hour < 5) return EMOTIONS.night
  return EMOTIONS.ready
}
