import type { VisualKind } from '@myrmidon/protocol'
import { copy } from '../../copy.ts'
import { CHART_MAX_ROWS, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, VISUAL_MAX_CHARS } from '../../ui-config.ts'

/**
 * The typed specs of visual answers, checked before anything is drawn. Each fence's text becomes one of these or an
 * error saying why not; the block then shows as code with that reason, so a bad spec still reads as text.
 */

export type Cell = string | number | boolean | null

export type Visual =
  | { readonly kind: 'chart'; readonly spec: Record<string, unknown> }
  | { readonly kind: 'mermaid'; readonly source: string }
  | {
      readonly kind: 'table'
      readonly columns: readonly string[]
      readonly rows: readonly (readonly Cell[])[]
      readonly caption?: string
    }
  | { readonly kind: 'tree'; readonly value: unknown }
  | { readonly kind: 'svg'; readonly svg: string }
  | { readonly kind: 'widget'; readonly html: string }

export type Parsed =
  | { readonly ok: true; readonly visual: Visual }
  | { readonly ok: false; readonly error: string }

const say = copy.visuals.errors
const fail = (error: string): Parsed => ({ ok: false, error })
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function json(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

/** Checks a fence's text for the visual `kind` names. */
export function parseVisual(kind: VisualKind, body: string): Parsed {
  const text = body.trim()
  if (!text) return fail(say.empty)
  const max = VISUAL_MAX_CHARS[kind]
  if (text.length > max) return fail(say.tooLarge(max))
  switch (kind) {
    case 'chart':
      return parseChart(text)
    case 'mermaid':
      // Init directives set themes and fonts; the app's theme is the one that holds, in light and dark.
      return { ok: true, visual: { kind, source: text.replace(/%%\{[\s\S]*?\}%%\s*/g, '') } }
    case 'table':
      return parseTable(text)
    case 'tree': {
      const v = json(text)
      return v.ok ? { ok: true, visual: { kind, value: v.value } } : fail(say.notJson)
    }
    case 'svg': {
      const svg = sanitizeSvg(text)
      return svg ? { ok: true, visual: { kind, svg } } : fail(say.notSvg)
    }
    case 'widget':
      return { ok: true, visual: { kind, html: text } }
  }
}

const COMPOSITE = ['mark', 'layer', 'hconcat', 'vconcat', 'concat', 'facet', 'repeat'] as const

/**
 * A Vega-Lite spec with its data inline. Anything that names an address (`url` data, `href` links, image marks) is
 * refused here, and the renderer's loader refuses every load as well, so a chart can never reach the network.
 */
function parseChart(text: string): Parsed {
  const v = json(text)
  if (!v.ok) return fail(say.notJson)
  if (!isRecord(v.value)) return fail(say.notObject)
  const spec = v.value
  if (typeof spec.$schema === 'string' && !spec.$schema.includes('vega-lite')) return fail(say.chartNotLite)
  if (!COMPOSITE.some((k) => k in spec)) return fail(say.chartNoMark)
  let rows = 0
  let addressed = false
  const walk = (node: unknown, depth: number) => {
    if (addressed || depth > 64) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (!isRecord(node)) return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'url' || key === 'href') addressed = true
      if (key === 'values' && Array.isArray(value)) rows += value.length
      walk(value, depth + 1)
    }
  }
  walk(spec, 0)
  if (addressed) return fail(say.chartUrl)
  if (rows > CHART_MAX_ROWS) return fail(say.chartRows(CHART_MAX_ROWS))
  return { ok: true, visual: { kind: 'chart', spec } }
}

/** A table cell as text, number, yes/no or empty; anything else is shown as its JSON. */
export function cellOf(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const named = (v: unknown) => (v === undefined || v === null ? undefined : String(cellOf(v) ?? ''))

/**
 * A table's column: a name, or a description of one (`{"key": "park", "label": "Park"}`, as table libraries write
 * them; `field`, `accessor`, `id`, `name`, `title` and `header` read the same way). `key` finds it in a record,
 * `label` heads it.
 */
function columnOf(c: unknown): { key: string; label: string } {
  if (!isRecord(c)) {
    const name = named(c) ?? ''
    return { key: name, label: name }
  }
  const key = named(c.key ?? c.field ?? c.accessor ?? c.id ?? c.name ?? c.label ?? c.title) ?? ''
  return { key, label: named(c.label ?? c.title ?? c.header ?? c.name) ?? key }
}

/**
 * Rows of records (each record's keys, in the order they first appear, are the columns), rows of lists (the first is
 * the header unless `columns` names them), or `{ columns, rows, caption }`.
 */
export function tableOf(value: unknown): Parsed {
  let given: { key: string; label: string }[] | undefined
  let rows: unknown[]
  let caption: string | undefined
  if (Array.isArray(value)) rows = value
  else if (isRecord(value) && Array.isArray(value.rows)) {
    rows = value.rows
    if (Array.isArray(value.columns)) given = value.columns.map(columnOf)
    if (typeof value.caption === 'string') caption = value.caption
  } else return fail(say.tableShape)
  if (rows.length === 0) return fail(say.tableEmpty)
  let columns: string[]
  let out: Cell[][]
  if (rows.every(isRecord)) {
    const keys = given?.map((c) => c.key) ?? [...new Set(rows.flatMap((r) => Object.keys(r)))]
    columns = given?.map((c) => c.label) ?? keys
    out = rows.map((r) => keys.map((k) => cellOf(r[k])))
  } else if (rows.every(Array.isArray)) {
    const lists = [...(rows as unknown[][])]
    const header = given ? given.map((c) => c.label) : (lists.shift() ?? []).map((c) => named(c) ?? '')
    const width = Math.max(header.length, ...lists.map((r) => r.length))
    while (header.length < width) header.push('')
    columns = header
    out = lists.map((r) => header.map((_, i) => cellOf(r[i])))
  } else return fail(say.tableShape)
  if (out.length > TABLE_MAX_ROWS || columns.length > TABLE_MAX_COLUMNS)
    return fail(say.tableSize(TABLE_MAX_ROWS, TABLE_MAX_COLUMNS))
  return { ok: true, visual: { kind: 'table', columns, rows: out, ...(caption ? { caption } : {}) } }
}

function parseTable(text: string): Parsed {
  const v = json(text)
  return v.ok ? tableOf(v.value) : fail(say.notJson)
}

/** Elements an SVG figure may not carry: scripts, embedded pages, and motion (figures are static). */
const SVG_DROPPED = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'handler',
  'listener',
])

/**
 * An SVG figure with what could run or reach out taken away: scripts, event attributes, embedded HTML, motion, and
 * links to anything but its own parts or inline pictures. It is drawn as an image as well, where none of these run;
 * this keeps the copy and the download as harmless as the drawing.
 */
export function sanitizeSvg(text: string): string | undefined {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (root?.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return
  const all = [root, ...Array.from(root.getElementsByTagName('*'))]
  for (const el of all) {
    if (SVG_DROPPED.has(el.nodeName.toLowerCase())) {
      el.parentNode?.removeChild(el)
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (
        (name === 'href' || name.endsWith(':href')) &&
        !/^(#|data:image\/(png|jpeg|gif|webp);)/i.test(value)
      )
        el.removeAttribute(attr.name)
      else if (/url\(\s*['"]?(?!#)/i.test(value)) el.removeAttribute(attr.name)
    }
  }
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(root)
}
