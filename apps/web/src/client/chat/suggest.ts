import {
  SUGGEST_MAX_CHARS,
  SUGGEST_MIN_COUNT,
  SUGGEST_MIN_HISTORY_CHARS,
  SUGGEST_MIN_WORD_PREFIX,
} from '../ui-config.ts'
import { SEED_PHRASES } from './suggest-seeds.ts'

/**
 * Ghost-text suggestions for the composer, free, offline and quick enough for every keystroke, the way Warp and fish
 * suggest from history. Strategies are tried in turn until one has something, as zsh-autosuggestions chains them:
 *
 * - `prevMatch` (zsh's match_prev_cmd): a past message that starts with what is typed and followed the same message
 *   the person sent just before this one;
 * - `history` (Warp, fish, zsh): a past message that starts with what is typed, most recent first;
 * - `nextWord`: after a space, the word that most often followed the last two words (or the last one), once that has
 *   been seen at least `SUGGEST_MIN_COUNT` times;
 * - `completeWord`: the rest of a half-typed word, from words the person uses, ranked by what follows the word before.
 *
 * Counts come from the person's messages plus a few built-in phrases, so it suggests on the first day too.
 */
export interface Suggester {
  /** The ghost text to show after `text` (`prev`: the person's last message in this chat), or nothing. */
  suggest(text: string, prev?: string): string | undefined
  /** Takes in a message just sent, so it is suggested back at once. */
  learn(text: string, prev?: string): void
}

export type Strategy = 'prevMatch' | 'history' | 'nextWord' | 'completeWord'
/** The chain the composer uses. */
export const STRATEGIES: readonly Strategy[] = ['history', 'nextWord', 'completeWord']

/** A past message, with the person's message before it in the same chat when known. */
export type Said = string | { readonly text: string; readonly prev?: string }

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu

type Counts = Map<string, number>
const bump = (m: Map<string, Counts>, key: string, word: string) => {
  const c = m.get(key) ?? new Map<string, number>()
  c.set(word, (c.get(word) ?? 0) + 1)
  m.set(key, c)
}
const best = (
  c: Counts | undefined,
  fits: (w: string) => boolean = () => true,
): [string, number] | undefined => {
  let top: [string, number] | undefined
  for (const [w, n] of c ?? []) if (fits(w) && (!top || n > top[1])) top = [w, n]
  return top
}

/** Cuts a long suggestion at the last word that fits, and at the first line break. */
function trim(rest: string): string {
  const line = rest.split('\n')[0] ?? ''
  if (line.length <= SUGGEST_MAX_CHARS) return line
  const cut = line.slice(0, SUGGEST_MAX_CHARS)
  const space = cut.lastIndexOf(' ')
  return space > 0 ? cut.slice(0, space) : cut
}

/** `said`: the person's past messages, most recent first. */
export function buildSuggester(
  said: readonly Said[],
  seeds: readonly string[] = SEED_PHRASES,
  strategies: readonly Strategy[] = STRATEGIES,
): Suggester {
  const history: { lower: string; text: string; prev?: string }[] = []
  const unigrams: Counts = new Map()
  const bigrams = new Map<string, Counts>()
  const trigrams = new Map<string, Counts>()
  // The spelling the person uses most for each word, so a suggestion reads as they write it.
  const forms = new Map<string, Counts>()

  const count = (text: string) => {
    const words = [...text.matchAll(WORD)].map((m) => m[0])
    words.forEach((word, i) => {
      const w = word.toLowerCase()
      unigrams.set(w, (unigrams.get(w) ?? 0) + 1)
      bump(forms, w, word)
      const a = words[i - 1]?.toLowerCase()
      const b = words[i - 2]?.toLowerCase()
      if (a) bump(bigrams, a, w)
      if (a && b) bump(trigrams, `${b} ${a}`, w)
    })
  }
  const form = (w: string) => best(forms.get(w))?.[0] ?? w
  const entry = (text: string, prev?: string) => ({
    lower: text.toLowerCase(),
    text,
    ...(prev ? { prev: prev.trim().toLowerCase() } : {}),
  })

  for (const item of said) {
    const { text, prev } = typeof item === 'string' ? { text: item, prev: undefined } : item
    if (!text.trim() || text.startsWith('/')) continue
    history.push(entry(text, prev))
    count(text)
  }
  for (const text of seeds) count(text)

  const fromHistory = (text: string, lower: string, prev?: string) => {
    if (text.trim().length < SUGGEST_MIN_HISTORY_CHARS) return undefined
    const want = prev?.trim().toLowerCase()
    const past = history.find(
      (h) =>
        h.lower.length > lower.length && h.lower.startsWith(lower) && (want === undefined || h.prev === want),
    )
    const rest = past ? trim(past.text.slice(text.length)) : ''
    return rest.trim() ? rest : undefined
  }
  const run: Record<Strategy, (text: string, lower: string, prev?: string) => string | undefined> = {
    prevMatch: (text, lower, prev) => (prev?.trim() ? fromHistory(text, lower, prev) : undefined),
    history: (text, lower) => fromHistory(text, lower),
    nextWord: (text, lower) => {
      if (!/\s$/.test(text)) return undefined
      const [b, a] = [...lower.matchAll(WORD)].map((m) => m[0]).slice(-2)
      const next =
        (a && b ? best(trigrams.get(`${b} ${a}`)) : undefined) ?? (a ? best(bigrams.get(a)) : undefined)
      return next && next[1] >= SUGGEST_MIN_COUNT ? form(next[0]) : undefined
    },
    completeWord: (_text, lower) => {
      const partial = /[\p{L}\p{N}'’_-]+$/u.exec(lower)?.[0] ?? ''
      if (partial.length < SUGGEST_MIN_WORD_PREFIX) return undefined
      const words = [...lower.matchAll(WORD)].map((m) => m[0])
      const longer = (w: string) => w.length > partial.length && w.startsWith(partial)
      const before = words.length > 1 ? words[words.length - 2] : undefined
      const done = (before ? best(bigrams.get(before), longer) : undefined) ?? best(unigrams, longer)
      return done ? form(done[0]).slice(partial.length) : undefined
    },
  }

  return {
    learn(text, prev) {
      if (!text.trim() || text.startsWith('/')) return
      history.unshift(entry(text, prev))
      count(text)
    },
    suggest(text, prev) {
      if (!text.trim() || text.startsWith('/')) return undefined
      const lower = text.toLowerCase()
      for (const strategy of strategies) {
        const ghost = run[strategy](text, lower, prev)
        if (ghost) return ghost
      }
      return undefined
    },
  }
}

/** What Tab takes from a suggestion: its next word (with any space before it) and a space after. */
export function nextWord(ghost: string): string {
  const word = /^\s*\S+/.exec(ghost)?.[0] ?? ghost
  return `${word} `
}
