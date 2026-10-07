import { expect, test } from 'bun:test'
import { detectPlatform, keepsBrowserMenu } from '../src/client/ui/platform.ts'

test('the platform comes from the user agent', () => {
  expect(
    detectPlatform(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    ),
  ).toBe('mac')
  expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('windows')
  expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('linux')
  expect(detectPlatform('curl/8.4.0')).toBe('other')
})

test('the browser menu stays for text fields and selected text, not for app chrome', () => {
  const inField = { closest: (s: string) => (s.includes('input') ? {} : null) }
  const onChrome = { closest: () => null }
  expect(keepsBrowserMenu(inField, '')).toBe(true)
  expect(keepsBrowserMenu(onChrome, 'some words')).toBe(true)
  expect(keepsBrowserMenu(onChrome, '  ')).toBe(false)
  expect(keepsBrowserMenu(null, '')).toBe(false)
})
