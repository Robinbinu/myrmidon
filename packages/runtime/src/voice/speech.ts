import { VOICE_SPOKEN_SENTENCES } from '../config.ts'
import { prompts } from '../prompts.ts'

/** Words a reply's first clause needs before it is spoken on its own, without waiting for the sentence to end. */
const FIRST_CLAUSE_WORDS = 4

/**
 * Turns a reply that is still being written into speech, a piece at a time (as Pipecat feeds its text-to-speech):
 * give it the text so far, get back what can be said now. A sentence is said once it ends; the reply's first clause
 * as soon as it has a few words and a comma, so the first sound comes sooner; markdown, links and inline code are
 * read as plain words, a code block (held until it closes) as a pointer to the chat; and after `limit` sentences
 * the rest is left to the chat.
 */
export class SpeechSplitter {
  private _used = 0
  private _said = 0
  private _stopped = false

  constructor(private readonly options: { limit?: number; firstClause?: boolean } = {}) {}

  /** `text` is the whole reply so far; `done` once it is complete. */
  push(text: string, done: boolean): string[] {
    const out: string[] = []
    while (!this._stopped) {
      const piece = this._next(text.slice(this._used), done)
      if (!piece) break
      this._used += piece.used
      const spoken = clean(piece.text)
      if (!spoken) continue
      out.push(spoken)
      this._said += 1
      if (this.options.limit && this._said >= this.options.limit && this._used < text.trimEnd().length) {
        out.push(prompts.voice.direct.rest)
        this._stopped = true
      }
    }
    return out
  }

  private _next(rest: string, done: boolean): { text: string; used: number } | undefined {
    if (!rest.trim()) return undefined
    const fence = rest.indexOf('```')
    if (fence === 0 || (fence > 0 && !rest.slice(0, fence).trim())) {
      // A code block: said as a pointer once it closes.
      const close = rest.indexOf('```', fence + 3)
      if (close < 0) return done ? { text: prompts.voice.direct.code, used: rest.length } : undefined
      return { text: prompts.voice.direct.code, used: close + 3 }
    }
    const scope = fence > 0 ? rest.slice(0, fence) : rest
    const end = /[.!?…](?=\s)|\n/.exec(scope)
    if (end) return { text: scope.slice(0, end.index + 1), used: end.index + 1 }
    if (this.options.firstClause && this._said === 0) {
      const clause = /[,;:—–](?=\s)/.exec(scope)
      if (clause && scope.slice(0, clause.index).trim().split(/\s+/).length >= FIRST_CLAUSE_WORDS)
        return { text: scope.slice(0, clause.index + 1), used: clause.index + 1 }
    }
    if (fence > 0) return { text: scope, used: fence }
    return done ? { text: rest, used: rest.length } : undefined
  }
}

/** Markdown as words: headings, bullets and emphasis dropped, links and inline code by their text, URLs as a pointer. */
function clean(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, prompts.voice.direct.link)
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A finished reply as speech, capped at VOICE_SPOKEN_SENTENCES (the rest is in the chat). */
export function speakable(text: string): string[] {
  return new SpeechSplitter({ limit: VOICE_SPOKEN_SENTENCES }).push(text, true)
}
