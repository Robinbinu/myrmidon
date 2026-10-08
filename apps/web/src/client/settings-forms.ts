import { copy } from './copy.ts'

/**
 * Checks for Settings forms, each returning the reason a value is wrong in words for the person (or nothing), so the
 * form can say why instead of only disabling its button. They mirror what the server checks, which stays the rule.
 */

const t = copy.settings.validation

/** A custom provider's name, as `packages/runtime/src/omp/runtime.ts` accepts it. */
export function providerNameError(name: string, existing: readonly string[]): string | undefined {
  if (!name) return t.required
  if (!/^[a-z]/.test(name)) return t.startWithLetter
  if (/[^a-z0-9-]/.test(name)) return t.nameChars
  if (name.length < 2 || name.length > 41) return t.nameLength(2, 41)
  if (existing.includes(name)) return t.providerTaken(name)
  return undefined
}

/** An endpoint's base URL: a whole http(s) address with a host, not just something that starts like one. */
export function baseUrlError(url: string): string | undefined {
  const text = url.trim()
  if (!text) return t.required
  // The server checks the scheme case-sensitively, so HTTP:// is refused there too.
  if (!/^https?:\/\//.test(text)) return t.url
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return t.url
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return t.url
  return undefined
}

/** Names the harness uses itself; a test holds this to the list in `packages/runtime/src/specialists.ts`. */
export const RESERVED_SPECIALIST_NAMES: ReadonlySet<string> = new Set([
  'lead',
  'team',
  'user',
  'verifier',
  'judge',
  'system',
  'myrmidon',
  'previous-round',
])

/** A specialist's name, as `packages/runtime/src/specialists.ts` accepts it. */
export function specialistNameError(name: string, taken: readonly string[]): string | undefined {
  if (!name) return t.required
  if (!/^[a-z]/.test(name)) return t.startWithLetter
  if (/[^a-z0-9-]/.test(name)) return t.nameChars
  if (name.length < 2 || name.length > 24) return t.nameLength(2, 24)
  if (RESERVED_SPECIALIST_NAMES.has(name)) return t.reserved(name)
  if (taken.includes(name)) return t.specialistTaken(name)
  return undefined
}

const CRON_FIELDS: [name: string, min: number, max: number][] = [
  [t.cronFields.minute, 0, 59],
  [t.cronFields.hour, 0, 23],
  [t.cronFields.day, 1, 31],
  [t.cronFields.month, 1, 12],
  [t.cronFields.weekday, 0, 7],
]

/** Days in each month at most, with February at 28: a schedule only for the 29th of February rarely runs. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * A five-field cron expression, with the grammar `parseCron` in `packages/runtime/src/schedules.ts` reads, and
 * refused like `nextRun` there when it can never run (a day that none of its months has).
 */
export function cronError(expr: string): string | undefined {
  const parts = expr.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) return t.cronFieldCount(parts.length)
  const values: Set<number>[] = []
  for (const [i, text] of parts.entries()) {
    const [name, min, max] = CRON_FIELDS[i] as [string, number, number]
    const set = new Set<number>()
    values.push(set)
    for (const part of text.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
      if (!m) return t.cronBadField(name, text)
      const step = m[4] ? Number(m[4]) : 1
      const from = m[1] === '*' ? min : Number(m[2])
      const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from
      if (from < min || to > max || from > to || step < 1) return t.cronRange(name, min, max)
      for (let v = from; v <= to; v += step) set.add(v)
    }
  }
  // With both day fields restricted either may match, so only a restricted day of the month alone can rule out
  // every date.
  const [, , days, months] = values as [Set<number>, Set<number>, Set<number>, Set<number>]
  const possible = [...months].some((m) => [...days].some((d) => d <= (MONTH_DAYS[m - 1] ?? 0)))
  if (parts[2] !== '*' && parts[4] === '*' && !possible) return t.cronNever
  return undefined
}

/**
 * What a number box holds once the person leaves it: the typed number kept within `min`–`max`, or `fallback` when
 * the box is empty or not a number.
 */
export function clampNumber(text: string, min: number, max: number, fallback: number): number {
  const v = Number(text)
  if (!text.trim() || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}
