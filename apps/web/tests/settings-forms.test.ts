import { expect, test } from 'bun:test'
import { nextRun, RESERVED_SPECIALIST_NAMES as SERVER_RESERVED } from '@myrmidon/runtime'
import {
  baseUrlError,
  channelSetup,
  clampNumber,
  cronError,
  providerNameError,
  RESERVED_SPECIALIST_NAMES,
  specialistNameError,
} from '../src/client/settings-forms.ts'

test('a provider name says what is wrong with it instead of only being refused', () => {
  expect(providerNameError('lmstudio', [])).toBeUndefined()
  expect(providerNameError('my-server-2', [])).toBeUndefined()
  expect(providerNameError('', [])).toBeDefined()
  expect(providerNameError('my server!', [])).toContain('lowercase letters, digits and dashes')
  expect(providerNameError('2fast', [])).toContain('letter')
  expect(providerNameError('a', [])).toContain('2 to 41')
  expect(providerNameError('ollama', ['ollama'])).toContain('already')
})

test('a base URL must be a whole http(s) address, not just text', () => {
  expect(baseUrlError('http://localhost:1234/v1')).toBeUndefined()
  expect(baseUrlError('https://api.example.com/v1')).toBeUndefined()
  expect(baseUrlError('not a url')).toBeDefined()
  expect(baseUrlError('http://')).toBeDefined()
  expect(baseUrlError('ftp://example.com')).toBeDefined()
  // The server's check is case-sensitive.
  expect(baseUrlError('HTTP://example.com')).toBeDefined()
  expect(baseUrlError('')).toBeDefined()
})

test('a specialist name follows the store: format, reserved names, one of each', () => {
  expect(specialistNameError('ada', [])).toBeUndefined()
  expect(specialistNameError('Ada', [])).toBeDefined()
  expect(specialistNameError('lead', [])).toContain('Myrmidon uses')
  expect(specialistNameError('scout', ['scout'])).toContain('already')
  expect(specialistNameError('a'.repeat(25), [])).toContain('2 to 24')
  expect([...RESERVED_SPECIALIST_NAMES].sort()).toEqual([...SERVER_RESERVED].sort())
})

test('the custom cron check accepts and refuses exactly what the scheduler does', () => {
  const cases = [
    '0 9 * * 1-5',
    '*/15 * * * *',
    '0,30 8-18 * * *',
    '0 9 1 1 7',
    '5 4 * * 0',
    '0 9 * *',
    '0 9 * * * *',
    '60 * * * *',
    '0 24 * * *',
    '0 9 0 * *',
    '0 9 * 13 *',
    '0 9 * * 8',
    'every day',
    '5-1 * * * *',
    '*/0 * * * *',
    '',
    '0 0 30 2 *',
    '0 0 31 4,6,9,11 *',
    '0 0 31 2-4 *',
    '0 0 30 2 1',
  ]
  for (const expr of cases) {
    let scheduler = true
    try {
      nextRun(expr, new Date())
    } catch {
      scheduler = false
    }
    expect({ expr, ok: cronError(expr) === undefined }).toEqual({ expr, ok: scheduler })
  }
  expect(cronError('0 9 * *')).toContain('five fields')
  expect(cronError('0 24 * * *')).toContain('between 0 and 23')
  expect(cronError('0 0 30 2 *')).toContain('never run')
})

test('a number box keeps a typed value within its limits and falls back when empty', () => {
  expect(clampNumber('500', 1, 240, 30)).toBe(240)
  expect(clampNumber('-3', 0, 1000, 5)).toBe(0)
  expect(clampNumber('45', 1, 240, 30)).toBe(45)
  expect(clampNumber('', 1, 240, 30)).toBe(30)
  expect(clampNumber('abc', 1, 240, 30)).toBe(30)
})

test('a channel’s setup names the required settings still missing, and never sends an emptied secret', () => {
  const fields = [
    { key: 'url', label: 'Server' },
    { key: 'token', label: 'Token', secret: true },
    { key: 'name', label: 'Name', optional: true },
  ]
  expect(channelSetup(fields, new Set(), {})).toEqual({ values: {}, missing: ['url', 'token'] })
  expect(channelSetup(fields, new Set(), { url: 'https://chat.example.com' }).missing).toEqual(['token'])
  // A saved token stays saved when its box is typed in and emptied again.
  expect(channelSetup(fields, new Set(['url', 'token']), { token: '', name: '' })).toEqual({
    values: { name: '' },
    missing: [],
  })
  // Emptying a saved required setting that is not secret leaves it missing.
  expect(channelSetup(fields, new Set(['url', 'token']), { url: ' ' }).missing).toEqual(['url'])
})
