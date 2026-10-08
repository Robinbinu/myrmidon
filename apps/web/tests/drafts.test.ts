import { afterEach, beforeEach, expect, test } from 'bun:test'
import { forgetDraft, readDraft, saveDraft } from '../src/client/chat/drafts.ts'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
})

test('each chat keeps its own unsent text, and an empty box forgets it', () => {
  expect(readDraft('c1')).toBe('')
  saveDraft('c1', 'half a thought')
  saveDraft('new', 'a new request')
  expect(readDraft('c1')).toBe('half a thought')
  expect(readDraft('new')).toBe('a new request')
  saveDraft('c1', '')
  expect(readDraft('c1')).toBe('')
  expect(store.has('myr-draft:c1')).toBe(false)
  forgetDraft('new')
  expect(readDraft('new')).toBe('')
})

test('a browser that refuses storage still lets you type', () => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    },
  })
  expect(() => saveDraft('c1', 'text')).not.toThrow()
  expect(readDraft('c1')).toBe('')
})
