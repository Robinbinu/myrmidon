import { copy } from './copy.ts'

/**
 * A schedule as the person picks it (repeat, time, days), and the five-field cron the server stores. Only the shapes
 * the picker can show are read back into a rule; any other expression stays `custom`, exactly as written.
 */

const t = copy.settings.schedules

export type Repeat = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'

export interface ScheduleRule {
  repeat: Repeat
  hour: number
  minute: number
  /** Weekdays for `weekly`, 0 = Sunday, as cron counts them. */
  days: number[]
  dayOfMonth: number
  /** The expression itself for `custom`. */
  cron: string
}

export const DEFAULT_RULE: ScheduleRule = {
  repeat: 'weekdays',
  hour: 9,
  minute: 0,
  days: [1],
  dayOfMonth: 1,
  cron: '0 9 * * 1-5',
}

const WEEKDAYS = '1,2,3,4,5'

export function ruleToCron(rule: ScheduleRule): string {
  const at = `${rule.minute} ${rule.hour}`
  switch (rule.repeat) {
    case 'hourly':
      return `${rule.minute} * * * *`
    case 'daily':
      return `${at} * * *`
    case 'weekdays':
      return `${at} * * 1-5`
    case 'weekly':
      return `${at} * * ${[...new Set(rule.days)].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${at} ${rule.dayOfMonth} * *`
    case 'custom':
      return rule.cron.trim()
  }
}

/** A whole number within `min`–`max`, or undefined. */
function number(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(text)) return undefined
  const n = Number(text)
  return n >= min && n <= max ? n : undefined
}

/** A weekday field as a set of days (7 read as Sunday), or undefined if it uses steps or anything else. */
function weekdays(text: string): Set<number> | undefined {
  const set = new Set<number>()
  for (const part of text.split(',')) {
    const [from, to = from] = part.split('-').map((p) => number(p, 0, 7))
    if (from === undefined || to === undefined || from > to || part.split('-').length > 2) return undefined
    for (let d = from; d <= to; d++) set.add(d % 7)
  }
  return set
}

export function cronToRule(cron: string): ScheduleRule {
  const custom: ScheduleRule = { ...DEFAULT_RULE, repeat: 'custom', cron }
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return custom
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
  const minute = number(min, 0, 59)
  if (minute === undefined || month !== '*') return custom
  if (hour === '*') return dom === '*' && dow === '*' ? { ...custom, repeat: 'hourly', minute } : custom
  const h = number(hour, 0, 23)
  if (h === undefined) return custom
  const at = { ...custom, hour: h, minute }
  if (dom !== '*') {
    const day = number(dom, 1, 31)
    return day !== undefined && dow === '*' ? { ...at, repeat: 'monthly', dayOfMonth: day } : custom
  }
  if (dow === '*') return { ...at, repeat: 'daily' }
  const days = weekdays(dow)
  if (!days) return custom
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return { ...at, repeat: 'daily' }
  if (sorted.join(',') === WEEKDAYS) return { ...at, repeat: 'weekdays' }
  return { ...at, repeat: 'weekly', days: sorted }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A time of day the way the person's locale writes it (9:00 AM, or 9:00), as the picker's hours show it too. */
export const timeText = (hour: number, minute: number, locale?: string) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })

/** An hour alone in the same locale (9 AM, or 09), for the picker's hour list. */
export const hourText = (hour: number, locale?: string) =>
  new Date(2000, 0, 1, hour).toLocaleTimeString(locale, { hour: 'numeric' })

/** Why some months pass without a run: a monthly schedule on the 29th to 31st skips the months that lack that day. */
export function shortMonthNote(cron: string): string | undefined {
  const rule = cronToRule(cron)
  return rule.repeat === 'monthly' && rule.dayOfMonth > 28
    ? t.shortMonths(t.ordinal(rule.dayOfMonth))
    : undefined
}

/** The schedule in plain words, for the list and the picker's summary; `locale` is the browser's unless given. */
export function describeCron(cron: string, locale?: string): string {
  const rule = cronToRule(cron)
  const time = timeText(rule.hour, rule.minute, locale)
  switch (rule.repeat) {
    case 'hourly':
      return t.describe.hourly(pad(rule.minute))
    case 'daily':
      return t.describe.daily(time)
    case 'weekdays':
      return t.describe.weekdays(time)
    case 'weekly':
      return t.describe.days(t.list(rule.days.map((d) => t.dayPlural[d] ?? '')), time)
    case 'monthly':
      return t.describe.monthly(t.ordinal(rule.dayOfMonth), time)
    case 'custom':
      return t.describe.custom(rule.cron.trim())
  }
}
