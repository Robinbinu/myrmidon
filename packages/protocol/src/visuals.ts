/**
 * Visual answers: blocks an agent writes in a reply as fenced code, which the app draws (a chart, a diagram, a table, a
 * JSON tree, an SVG figure, a small interactive widget). The fence is the text fallback: a channel, a voice call or a
 * copy of the message gets the words around it and, through {@link visualFallback}, a line naming what was drawn.
 */

/** The fence languages the app draws, by what each holds. */
export const VISUAL_LANGS = {
  /** A Vega-Lite spec (JSON) with its data inline. */
  chart: 'chart',
  /** Mermaid source: flowchart, sequence, state, class, ER, gantt, pie, timeline… */
  mermaid: 'mermaid',
  /** `{ "columns": [...], "rows": [[...]] }`, or an array of objects. */
  table: 'table',
  /** Any JSON value, shown as a tree that folds. */
  tree: 'json-tree',
  /** A static SVG figure. */
  svg: 'svg',
  /** An HTML page run in a sandboxed frame: no network, no access to the app. */
  widget: 'widget',
} as const

export type VisualKind = keyof typeof VISUAL_LANGS

const BY_LANG = new Map<string, VisualKind>(
  Object.entries(VISUAL_LANGS).map(([kind, lang]) => [lang, kind as VisualKind]),
)

/** The visual a fence's language names, if it names one. */
export function visualKind(lang: string): VisualKind | undefined {
  return BY_LANG.get(lang.trim().toLowerCase())
}

/** A visual's own title, when its source names one: a chart's `title`, a table's `caption`, a widget's `<title>`. */
export function visualTitle(kind: VisualKind, body: string): string | undefined {
  if (kind === 'widget') return /<title>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim() || undefined
  if (kind === 'mermaid' || kind === 'svg') {
    const title =
      /^\s*(?:title\s+|accTitle:\s*)(.{1,120})$/m.exec(body)?.[1] ??
      /<title>([^<]{1,120})<\/title>/.exec(body)?.[1]
    return title?.trim() || undefined
  }
  try {
    const value = JSON.parse(body) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const v = value as Record<string, unknown>
    const named = kind === 'table' ? v.caption : v.title
    if (typeof named === 'string') return named.slice(0, 120).trim() || undefined
    if (named && typeof named === 'object' && typeof (named as { text?: unknown }).text === 'string')
      return (named as { text: string }).text.slice(0, 120).trim() || undefined
  } catch {}
  return undefined
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)[^\n]*$/

/**
 * `markdown` with each visual's fence put as one line (`label(kind, title)`), for places that cannot draw it: a
 * channel's message, a reply read aloud, a copy as text. Mermaid is kept as it is (its source reads as a list of steps),
 * and a fence that never closes is left alone, as is every other code block.
 */
export function visualFallback(
  markdown: string,
  label: (kind: VisualKind, title: string | undefined) => string,
  keep: readonly VisualKind[] = ['mermaid'],
): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const open = FENCE.exec(line)
    if (!open) {
      out.push(line)
      continue
    }
    const marker = open[2] as string
    let end = i + 1
    while (end < lines.length && !(lines[end] as string).trimStart().startsWith(marker)) end++
    const kind = visualKind(open[3] ?? '')
    if (end >= lines.length || !kind || keep.includes(kind)) {
      // An ordinary code block (or an unclosed one) passes through whole, so a fence inside it is not read as one.
      out.push(...lines.slice(i, Math.min(end + 1, lines.length)))
      i = end
      continue
    }
    out.push(`${open[1] ?? ''}${label(kind, visualTitle(kind, lines.slice(i + 1, end).join('\n')))}`)
    i = end
  }
  return out.join('\n')
}
