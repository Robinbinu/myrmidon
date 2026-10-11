/**
 * The voice-over: what is said, by whom, and the frame it starts on. scripts/voice.mjs synthesizes each line once into
 * public/vo/<id>.mp3 (and its length into src/vo-manifest.json); Soundtrack.tsx plays them. Kept free of imports so the
 * script can read it with Node's own TypeScript support. `<break>` is SSML; captions stay as they are on screen.
 */

/** The film's narrator, and the voice Myrmidon speaks with on the phone. Azure standard neural voices. */
export const VOICES = {
  narrator: 'en-US-AndrewMultilingualNeural',
  myrmidon: 'en-US-AvaMultilingualNeural',
} as const
export type Speaker = keyof typeof VOICES

export interface VoLine {
  id: string
  speaker: Speaker
  /** Frame the line starts on, in the film. */
  at: number
  /** What is said; may hold SSML `<break time="…"/>` tags. */
  text: string
  /** Speaking rate, as SSML prosody (e.g. "-5%"). */
  rate?: string
}

export const VO_LINES: VoLine[] = [
  { id: 'tools', speaker: 'narrator', at: 50, text: 'Ten AI tools. Ten tabs. <break time="250ms"/> None of them talk to each other.' },
  { id: 'question', speaker: 'narrator', at: 452, text: 'What if one chat did all of it?' },
  { id: 'late', speaker: 'narrator', at: 812, text: 'It is late. Checkout is breaking. <break time="200ms"/> Text it from anywhere.' },
  { id: 'lead', speaker: 'narrator', at: 1262, text: 'A lead plans the work, <break time="150ms"/> and brings in a crew.' },
  { id: 'nova', speaker: 'narrator', at: 1566, text: 'One digs through the data.' },
  { id: 'iris', speaker: 'narrator', at: 1790, text: 'One reproduces the failure, on your Mac.' },
  { id: 'quill', speaker: 'narrator', at: 1992, text: 'One finds the bug, fixes it, and proves it.' },
  { id: 'check', speaker: 'narrator', at: 2398, text: "Then they check each other's work." },
  {
    id: 'trust',
    speaker: 'narrator',
    at: 2696,
    text: 'Sandboxed. <break time="350ms"/> Logged. <break time="350ms"/> Yours.',
    rate: '-8%',
  },
  {
    id: 'call',
    speaker: 'myrmidon',
    at: 3163,
    text: 'Found it: a rounding bug in euro checkout. <break time="200ms"/> Fixed, tested and deployed. <break time="200ms"/> Conversions are back.',
    rate: '+4%',
  },
  { id: 'reach', speaker: 'narrator', at: 3705, text: 'Reach it from thirty apps, on any model, <break time="150ms"/> with the plans you already pay for.' },
  { id: 'end', speaker: 'narrator', at: 4105, text: 'Myrmidon. <break time="300ms"/> One chat. <break time="200ms"/> A whole crew.', rate: '-6%' },
]
