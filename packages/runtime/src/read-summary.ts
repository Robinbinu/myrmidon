import { READ_SUMMARY_FOLD, READ_SUMMARY_MAX_BYTES } from './config.ts'
import { summarizeCodeAsync } from './omp/natives.ts'

/**
 * A long source file's structure, as omp's read gives it first (tools/read-summary.ts, pi-tui formatReadSummary):
 * tree-sitter keeps declarations and signatures and folds bodies and long comments, and the agent reads the ranges it
 * needs. Prose is not summarized, as in omp: its sections are the content.
 */

/** A row of the summary: a kept line, a fold, or a folded body between the lines that open and close it. */
type Row =
  | { readonly kind: 'line'; readonly line: number; readonly text: string }
  | { readonly kind: 'fold'; readonly start: number; readonly end: number }
  | {
      readonly kind: 'pair'
      readonly start: number
      readonly end: number
      readonly head: string
      readonly tail: string
    }

export interface CodeSummary {
  readonly rows: readonly Row[]
  /** Lines shown in full (a folded pair's opening and closing lines included). */
  readonly seen: readonly number[]
  /** The folded ranges, a pair's from its opening to its closing line, so reading one shows the whole block. */
  readonly folds: readonly { readonly start: number; readonly end: number }[]
  readonly foldedLines: number
}

const PROSE = /\.(md|markdown|mdx|txt)$/i
const PAIRS: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
const PAIR_TAIL = /^[;,)\]}]*$/

/** `{ … }`-style: the kept line before a fold opens a bracket the kept line after it closes. */
function closes(head: string, tail: string): boolean {
  const closer = PAIRS[head.trimEnd().slice(-1)]
  const end = tail.trim()
  return closer !== undefined && end.startsWith(closer) && PAIR_TAIL.test(end.slice(closer.length))
}

/**
 * The structure of `text` (the file at `path`, which picks the language), or none when it is prose, too large, in a
 * language the addon has no grammar for, does not parse, or has nothing to fold.
 */
export async function summarizeSource(text: string, path: string): Promise<CodeSummary | undefined> {
  if (PROSE.test(path) || Buffer.byteLength(text) > READ_SUMMARY_MAX_BYTES) return undefined
  // The summary only saves reading: a file the addon cannot take apart is read as lines instead, as in omp.
  const result = await summarizeCodeAsync({ code: text, path, ...READ_SUMMARY_FOLD }).catch(() => undefined)
  if (!result?.parsed || !result.elided) return undefined
  const flat: Row[] = []
  for (const s of result.segments) {
    if (s.kind === 'elided') flat.push({ kind: 'fold', start: s.startLine, end: s.endLine })
    else if (s.text)
      for (const [i, t] of s.text.split('\n').entries())
        flat.push({ kind: 'line', line: s.startLine + i, text: t })
  }
  const rows: Row[] = []
  for (let i = 0; i < flat.length; i++) {
    const row = flat[i] as Row
    const prev = rows.at(-1)
    const next = flat[i + 1]
    if (
      row.kind === 'fold' &&
      prev?.kind === 'line' &&
      next?.kind === 'line' &&
      closes(prev.text, next.text)
    ) {
      rows.pop()
      rows.push({ kind: 'pair', start: prev.line, end: next.line, head: prev.text, tail: next.text })
      i++
    } else rows.push(row)
  }
  const seen: number[] = []
  const folds: { start: number; end: number }[] = []
  let foldedLines = 0
  for (const r of rows) {
    if (r.kind === 'line') seen.push(r.line)
    else if (r.kind === 'pair') {
      seen.push(r.start, r.end)
      folds.push({ start: r.start, end: r.end })
      foldedLines += Math.max(0, r.end - r.start - 1)
    } else {
      folds.push({ start: r.start, end: r.end })
      foldedLines += r.end - r.start + 1
    }
  }
  return { rows, seen, folds, foldedLines }
}

/**
 * The summary as text: kept lines numbered `N<mark>line` (`:` as hashline rows, `|` otherwise), a fold as `…`, and a
 * folded block as `start-end<mark>head … tail`, which no edit can anchor on.
 */
export function renderSummary(summary: CodeSummary, mark: ':' | '|'): string {
  return summary.rows
    .map((r) =>
      r.kind === 'line'
        ? `${r.line}${mark}${r.text}`
        : r.kind === 'fold'
          ? '…'
          : `${r.start}-${r.end}${mark}${r.head.trimEnd()} … ${r.tail.trim()}`,
    )
    .join('\n')
}
