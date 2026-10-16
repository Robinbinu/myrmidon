/**
 * Magic words in the person's message, after omp's magic keywords (modes/magic-keywords.ts, pi-tui
 * prompt/magic-keywords.ts and prompt/markdown-prose.ts): a standalone lowercase word in prose changes how the round
 * runs. Never inside a fenced code block, an inline code span or an HTML/XML section, and never bound into an
 * identifier, path or call (`ultrathink.ts`, `my-orchestrate`, `orchestrate()`), as in omp.
 */

/** The words, as omp spells them: `ultrathink` (the highest effort the model has), `orchestrate` (a crew in parallel). */
export const MAGIC_WORDS = ['ultrathink', 'orchestrate'] as const
export type MagicWord = (typeof MAGIC_WORDS)[number]

// After omp's LEFT_BOUNDARY / RIGHT_BOUNDARY: letters, digits, _ . / \ - and :: bind the word into code.
const LEFT = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`
const RIGHT = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`
const MATCHERS = new Map(MAGIC_WORDS.map((w) => [w, new RegExp(`${LEFT}${w}${RIGHT}`, 'u')]))

/** A fence opening or closing line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^( {0,3})(`{3,}|~{3,})/

/**
 * `text` with every non-prose region blanked to spaces (same length): fenced code blocks, inline code spans, and
 * HTML/XML tags with what they enclose. A simpler cut of omp's maskNonProse: an unclosed tag masks only itself, an
 * unmatched backtick run is literal text.
 */
export function maskNonProse(text: string): string {
  const masked = new Uint8Array(text.length)
  let fence = ''
  let at = 0
  for (const line of text.split('\n')) {
    const open = FENCE.exec(line)
    if (fence || open) masked.fill(1, at, at + line.length)
    if (fence) {
      const marker = open?.[2] ?? ''
      if (marker[0] === fence[0] && marker.length >= fence.length && !line.slice(open?.[0].length).trim())
        fence = ''
    } else if (open?.[2] && !(open[2][0] === '`' && line.slice(open[0].length).includes('`'))) fence = open[2]
    at += line.length + 1
  }
  for (let i = 0; i < text.length; i++) {
    if (masked[i]) continue
    if (text[i] === '`') {
      let run = i
      while (text[run] === '`') run++
      const ticks = text.slice(i, run)
      let close = text.indexOf(ticks, run)
      while (close >= 0 && text[close + ticks.length] === '`')
        close = text.indexOf(ticks, close + ticks.length + 1)
      if (close >= 0) {
        masked.fill(1, i, close + ticks.length)
        i = close + ticks.length - 1
      } else i = run - 1
      continue
    }
    if (text[i] === '<') {
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)[^<>]*>/.exec(text.slice(i))
      if (!tag) continue
      const end = i + tag[0].length
      masked.fill(1, i, end)
      if (tag[1] || tag[0].endsWith('/>')) {
        i = end - 1
        continue
      }
      const closing = `</${tag[2]}>`
      const close = text.indexOf(closing, end)
      if (close >= 0) {
        const stop = close + closing.length
        masked.fill(1, end, stop)
        i = stop - 1
      } else i = end - 1
    }
  }
  let out = ''
  for (let i = 0; i < text.length; i++) out += masked[i] && text[i] !== '\n' ? ' ' : text[i]
  return out
}

/** The magic words `text` says in prose, in MAGIC_WORDS order. */
export function magicWordsIn(text: string): MagicWord[] {
  const candidates = MAGIC_WORDS.filter((w) => MATCHERS.get(w)?.test(text))
  if (!candidates.length) return []
  const prose = maskNonProse(text)
  return candidates.filter((w) => MATCHERS.get(w)?.test(prose))
}
