import { describe, expect, test } from 'bun:test'
import { cronToRule, describeCron, ruleToCron, type ScheduleRule } from '../src/client/schedule-rule.ts'
import { cronError } from '../src/client/settings-forms.ts'

const base: ScheduleRule = { repeat: 'daily', hour: 9, minute: 0, days: [1], dayOfMonth: 1, cron: '' }

describe('ruleToCron', () => {
  test('writes each repeat at the chosen time', () => {
    expect(ruleToCron({ ...base, repeat: 'hourly', minute: 15 })).toBe('15 * * * *')
    expect(ruleToCron({ ...base, repeat: 'daily', hour: 14, minute: 30 })).toBe('30 14 * * *')
    expect(ruleToCron({ ...base, repeat: 'weekdays', hour: 7, minute: 5 })).toBe('5 7 * * 1-5')
    expect(ruleToCron({ ...base, repeat: 'weekly', hour: 18, days: [4, 1] })).toBe('0 18 * * 1,4')
    expect(ruleToCron({ ...base, repeat: 'monthly', hour: 8, dayOfMonth: 15 })).toBe('0 8 15 * *')
    expect(ruleToCron({ ...base, repeat: 'custom', cron: ' 0 */2 * * * ' })).toBe('0 */2 * * *')
  })

  test('every rule it writes is a valid cron', () => {
    for (const repeat of ['hourly', 'daily', 'weekdays', 'weekly', 'monthly'] as const) {
      expect(
        cronError(ruleToCron({ ...base, repeat, hour: 23, minute: 59, days: [0, 6], dayOfMonth: 28 })),
      ).toBe(undefined)
    }
  })
})

describe('cronToRule', () => {
  test('reads back what ruleToCron writes', () => {
    const rules: ScheduleRule[] = [
      { ...base, repeat: 'hourly', minute: 45 },
      { ...base, repeat: 'daily', hour: 14, minute: 30 },
      { ...base, repeat: 'weekdays', hour: 7, minute: 5 },
      { ...base, repeat: 'weekly', hour: 18, days: [1, 4] },
      { ...base, repeat: 'monthly', hour: 8, dayOfMonth: 15 },
    ]
    for (const rule of rules) {
      const read = cronToRule(ruleToCron(rule))
      expect(read.repeat).toBe(rule.repeat)
      expect(ruleToCron(read)).toBe(ruleToCron(rule))
    }
  })

  test('the old 9:00 presets open as the matching repeat', () => {
    expect(cronToRule('0 9 * * *')).toMatchObject({ repeat: 'daily', hour: 9, minute: 0 })
    expect(cronToRule('0 9 * * 1-5')).toMatchObject({ repeat: 'weekdays', hour: 9 })
    expect(cronToRule('0 9 * * 1')).toMatchObject({ repeat: 'weekly', days: [1] })
    expect(cronToRule('0 * * * *')).toMatchObject({ repeat: 'hourly', minute: 0 })
  })

  test('weekday lists and ranges are understood, and 7 is Sunday', () => {
    expect(cronToRule('0 9 * * 1,2,3,4,5').repeat).toBe('weekdays')
    expect(cronToRule('0 9 * * 0-6').repeat).toBe('daily')
    expect(cronToRule('0 9 * * 7')).toMatchObject({ repeat: 'weekly', days: [0] })
    expect(cronToRule('30 6 * * 6,7')).toMatchObject({ repeat: 'weekly', days: [0, 6], hour: 6, minute: 30 })
  })

  test('anything the picker cannot show stays custom, unchanged', () => {
    for (const cron of [
      '*/15 * * * *',
      '0 9-17 * * *',
      '0 9 1 1 *',
      '0 9 1 * 1',
      '0 9 */2 * *',
      'nonsense',
    ]) {
      const rule = cronToRule(cron)
      expect(rule.repeat).toBe('custom')
      expect(ruleToCron(rule)).toBe(cron)
    }
  })
})

// Pinned to two locales, with the narrow no-break space some runtimes put before AM/PM read as a space.
const say = (cron: string, locale = 'en-US') => describeCron(cron, locale).replace(/\u202f/g, ' ')

describe('describeCron', () => {
  test('says each repeat in plain words', () => {
    expect(say('15 * * * *')).toBe('Every hour at :15')
    expect(say('30 14 * * *')).toBe('Every day at 2:30 PM')
    expect(say('5 7 * * 1-5')).toBe('Weekdays at 7:05 AM')
    expect(say('0 9 * * 1')).toBe('Mondays at 9:00 AM')
    expect(say('0 18 * * 1,4')).toBe('Mondays and Thursdays at 6:00 PM')
    expect(say('0 18 * * 0,3,5')).toBe('Sundays, Wednesdays and Fridays at 6:00 PM')
    expect(say('0 8 15 * *')).toBe('Monthly on the 15th at 8:00 AM')
  })

  test('uses the right ordinal for each day of the month', () => {
    expect(say('0 8 1 * *')).toBe('Monthly on the 1st at 8:00 AM')
    expect(say('0 8 2 * *')).toBe('Monthly on the 2nd at 8:00 AM')
    expect(say('0 8 3 * *')).toBe('Monthly on the 3rd at 8:00 AM')
    expect(say('0 8 11 * *')).toBe('Monthly on the 11th at 8:00 AM')
    expect(say('0 8 22 * *')).toBe('Monthly on the 22nd at 8:00 AM')
  })

  test('writes the time as the locale does', () => {
    expect(say('30 14 * * *', 'en-GB')).toBe('Every day at 14:30')
    expect(say('5 7 * * 1-5', 'en-GB')).toBe('Weekdays at 7:05')
  })

  test('shows a custom expression as itself', () => {
    expect(say('*/15 * * * *')).toBe('Custom: */15 * * * *')
  })
})
