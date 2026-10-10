import { SETTINGS_SEARCH } from '../ui-config.ts'
import { type ModelsTab, type Section, sectionInfo } from './pages.ts'
import {
  DYNAMIC,
  type DynamicSetting,
  type LiveData,
  type LiveSource,
  SETTINGS,
  type StaticSetting,
} from './registry.ts'

/** One thing search can find: a setting, or one item of a live list (a provider, a theme, an MCP server). */
export interface SearchEntry {
  /** The registry id: what the row on the page carries as data-setting-id. */
  id: string
  /** A live item's key: what its row carries as data-setting-key. */
  key?: string
  page: Section
  tab?: ModelsTab
  /** Page, then the headings down to the row. */
  trail: readonly string[]
  label: string
  help?: string
  keywords: readonly string[]
  dependsOn?: string
  /** A value to read rather than change, ranked a little below settings that match as well. */
  info?: boolean
}

/** Everything search can find right now: every setting, and each item of the live lists given. */
export function settingsIndex(live: Partial<LiveData> = {}): SearchEntry[] {
  const trail = (page: Section, path: readonly string[] = []) => [sectionInfo(page).label, ...path]
  const fixed = Object.entries(SETTINGS).map(([id, e]: [string, StaticSetting]) => ({
    id,
    page: e.page,
    ...(e.tab ? { tab: e.tab } : {}),
    trail: trail(e.page, e.path),
    label: e.label,
    ...(e.help ? { help: e.help } : {}),
    keywords: e.keywords ?? [],
    ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
    ...(e.control === 'info' ? { info: true } : {}),
  }))
  const items = Object.entries(DYNAMIC).flatMap(([id, d]) => {
    const e = d as unknown as DynamicSetting<LiveSource>
    const list = (live[e.source] ?? []) as readonly LiveData[LiveSource][number][]
    return list.map((x): SearchEntry => {
      const it = e.item(x)
      return {
        id,
        key: it.key,
        page: e.page,
        ...(e.tab ? { tab: e.tab } : {}),
        trail: trail(e.page, it.path ?? e.path),
        label: it.label,
        ...(it.help ? { help: it.help } : {}),
        keywords: [...(it.keywords ?? []), ...(e.keywords ?? [])],
        ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
      }
    })
  })
  return [...fixed, ...items]
}

/** Lower case, accents and punctuation gone, one space between words: "Colour-scheme" → "colour scheme". */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The fewest single-letter edits (insert, delete, change, swap two neighbours) from `a` to `b`, stopping past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, (prev2[j - 2] ?? 0) + 1)
      row.push(d)
      best = Math.min(best, d)
    }
    if (best > max) return max + 1
    prev2 = prev
    prev = row
  }
  return prev[b.length] ?? max + 1
}

/** How many typos a query word of this length may have and still count. */
const typosFor = (word: string) =>
  word.length >= SETTINGS_SEARCH.twoTyposFrom ? 2 : word.length >= SETTINGS_SEARCH.oneTypoFrom ? 1 : 0

/**
 * How well a text answers the query, both normalized, from 0 (not at all) to 100: the whole text, then its start,
 * then the start of one of its words, then every query word starting one of its words, then anywhere inside it, then
 * (the fallback) every query word matching a word of it with a typo or two, or the start of one.
 */
export function fieldScore(text: string, query: string): number {
  if (!text || !query) return 0
  if (text === query) return 100
  if (text.startsWith(query)) return 85
  if (text.includes(` ${query}`)) return 72
  const words = text.split(' ')
  const asked = query.split(' ')
  if (asked.every((q) => words.some((w) => w.startsWith(q)))) return 60
  if (text.includes(query)) return 45
  const near = asked.every((q) => {
    const max = typosFor(q)
    return (
      max > 0 &&
      words.some(
        (w) =>
          editDistance(q, w, max) <= max ||
          (w.length > q.length && editDistance(q, w.slice(0, q.length), max) <= max),
      )
    )
  })
  return near ? 25 : 0
}

/**
 * How much each part of an entry counts: its own label most, then the words people use for it, the headings it is
 * under, and its hint. A long keyword (a value's hint kept for search) counts as a hint does.
 */
const WEIGHTS = { label: 1, keyword: 0.9, trail: 0.7, help: 0.45, info: 0.8 } as const
const LONG_KEYWORD_WORDS = 4
/** What an entry scores when each query word starts a word somewhere in it, but no one part has them all. */
const SPREAD_SCORE = 30

interface Words {
  /** Every word of every part, for a query whose words are spread over them. */
  all: string[]
  label: string
  keywords: string[]
  /** The hint, and keywords long enough to be hints. */
  help: string[]
  trail: string[]
}

/** An entry's words, normalized once per index rather than on every key press. */
const normalized = new WeakMap<SearchEntry, Words>()
function wordsOf(entry: SearchEntry): Words {
  let n = normalized.get(entry)
  if (!n) {
    const keywords = entry.keywords.map(normalize)
    const long = (k: string) => k.split(' ').length > LONG_KEYWORD_WORDS
    const parts = [entry.label, ...entry.keywords, ...entry.trail, entry.help ?? ''].map(normalize)
    n = {
      all: parts.flatMap((p) => p.split(' ')),
      label: normalize(entry.label),
      keywords: keywords.filter((k) => !long(k)),
      help: [normalize(entry.help ?? ''), ...keywords.filter(long)],
      trail: entry.trail.map(normalize),
    }
    normalized.set(entry, n)
  }
  return n
}

export interface SearchResult {
  entry: SearchEntry
  score: number
}

/**
 * The entries that answer a query, best first: by score; among equals, the one whose own name has more of the query's
 * words ("Dark" for "dark mode"), then a row before the rows that show only once it is on, then settings before live
 * items, then shorter labels.
 */
export function searchSettings(index: readonly SearchEntry[], rawQuery: string): SearchResult[] {
  const query = normalize(rawQuery)
  if (!query) return []
  const asked = query.split(' ')
  const scored = index.map((entry, order) => {
    const n = wordsOf(entry)
    const named = n.label.split(' ')
    const hits = asked.filter((q) => named.some((w) => w.startsWith(q))).length
    const best = Math.max(
      fieldScore(n.label, query) * WEIGHTS.label,
      Math.max(0, ...n.keywords.map((k) => fieldScore(k, query))) * WEIGHTS.keyword,
      Math.max(0, ...n.trail.map((t) => fieldScore(t, query))) * WEIGHTS.trail,
      Math.max(0, ...n.help.map((h) => fieldScore(h, query))) * WEIGHTS.help,
      // Words found in different parts ("kitten" in a keyword, "model size" in the label) still answer it.
      asked.length > 1 && asked.every((q) => n.all.some((w) => w.startsWith(q))) ? SPREAD_SCORE : 0,
    )
    return { entry, score: entry.info ? best * WEIGHTS.info : best, hits, order }
  })
  return scored
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.hits - a.hits ||
        Number(!!a.entry.dependsOn) - Number(!!b.entry.dependsOn) ||
        Number(!!a.entry.key) - Number(!!b.entry.key) ||
        a.entry.label.length - b.entry.label.length ||
        a.order - b.order,
    )
    .slice(0, SETTINGS_SEARCH.limit)
    .map(({ entry, score }) => ({ entry, score }))
}
