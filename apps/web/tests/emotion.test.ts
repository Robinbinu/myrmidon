import { expect, test } from 'bun:test'
import { ambient, EMOTIONS, readDraft } from '../src/client/chat/emotion.ts'

test('the mascot reads the mood of a draft', () => {
  expect(readDraft('')).toBe(EMOTIONS.ready)
  expect(readDraft('thanks, that was perfect')).toBe(EMOTIONS.love)
  expect(readDraft('prod is DOWN, fix the login bug asap')).toBe(EMOTIONS.concerned)
  expect(readDraft('how does the judge score work?')).toBe(EMOTIONS.curious)
  expect(readDraft('build a snake game')).toBe(EMOTIONS.listening)
  expect(readDraft(`Write a migration guide. ${'Cover every edge case in detail. '.repeat(6)}`)).toBe(
    EMOTIONS.focused,
  )
})

test('its resting mood follows the colony and the clock', () => {
  expect(ambient({ working: 2, hour: 14 }).label).toBe('2 runs going')
  expect(ambient({ working: 0, latest: { status: 'completed', agoMs: 30_000 }, hour: 14 })).toBe(
    EMOTIONS.proud,
  )
  expect(ambient({ working: 0, latest: { status: 'failed', agoMs: 30_000 }, hour: 14 })).toBe(EMOTIONS.sad)
  expect(ambient({ working: 0, latest: { status: 'completed', agoMs: 600_000 }, hour: 14 })).toBe(
    EMOTIONS.ready,
  )
  expect(ambient({ working: 0, hour: 2 })).toBe(EMOTIONS.night)
})
