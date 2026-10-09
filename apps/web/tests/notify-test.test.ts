import { afterEach, expect, test } from 'bun:test'
import { testNotification } from '../src/client/ui/notify-test.ts'
import { withDom } from './dom.ts'

withDom()

type Global = { Notification?: unknown }
const g = globalThis as Global
let realNotification: unknown
let realHasFocus: (() => boolean) | undefined

afterEach(() => {
  g.Notification = realNotification
  if (realHasFocus) document.hasFocus = realHasFocus
  delete window.myrmidonDesktop
})

/** A browser's Notification: its permission, what asking for it answers, and every notification made. */
function browser(permission: string, answer = permission) {
  realNotification ??= g.Notification
  const made: { title: string; options?: NotificationOptions }[] = []
  g.Notification = class {
    static permission = permission
    static requestPermission = async () => answer
    constructor(title: string, options?: NotificationOptions) {
      made.push({ title, ...(options ? { options } : {}) })
    }
  }
  return made
}

function shell(fail?: string) {
  const sent: { title: string; body: string }[] = []
  window.myrmidonDesktop = {
    pickFolder: async () => undefined,
    reveal: async () => {},
    setBadge: async () => {},
    notify: async (title, body) => {
      if (fail) throw new Error(fail)
      sent.push({ title, body })
    },
  }
  return sent
}

function focus(focused: boolean) {
  realHasFocus ??= document.hasFocus.bind(document)
  document.hasFocus = () => focused
}

test('in a browser that allows them it shows one every time, untagged so a second is not swallowed by the first', async () => {
  const made = browser('granted')
  focus(true)
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'sent', desktop: false })
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'sent', desktop: false })
  expect(made).toHaveLength(2)
  expect(made[0]).toEqual({ title: 'Myrmidon', options: { body: 'hi' } })
})

test('a browser asks first; refused or blocked it says blocked, and without notifications unsupported', async () => {
  const asked = browser('default', 'denied')
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'blocked' })
  expect(asked).toHaveLength(0)
  browser('denied')
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'blocked' })
  browser('default', 'granted')
  expect((await testNotification('Myrmidon', 'hi')).state).toBe('sent')
  g.Notification = undefined
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'unsupported' })
  // A browser that only notifies from a service worker throws on `new Notification`.
  g.Notification = Object.assign(
    class {
      constructor() {
        throw new TypeError('Illegal constructor')
      }
    },
    { permission: 'granted' },
  )
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'unsupported' })
})

test('the desktop app sends it at once while in the background', async () => {
  const sent = shell()
  focus(false)
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'sent', desktop: true })
  expect(sent).toEqual([{ title: 'Myrmidon', body: 'hi' }])
})

test('the desktop app in front waits until it goes to the background, since macOS hides the front app’s', async () => {
  const sent = shell()
  focus(true)
  let waiting = 0
  const result = testNotification('Myrmidon', 'hi', { onWaiting: () => waiting++ })
  await Bun.sleep(10)
  expect(waiting).toBe(1)
  expect(sent).toEqual([])
  focus(false)
  window.dispatchEvent(new Event('blur'))
  expect(await result).toEqual({ state: 'sent', desktop: true })
  expect(sent).toHaveLength(1)
})

test('the desktop app says why when the shell fails, and a test given up on is never sent', async () => {
  shell('no bridge')
  focus(false)
  expect(await testNotification('Myrmidon', 'hi')).toEqual({ state: 'failed', error: 'no bridge' })
  const sent = shell()
  focus(true)
  const stop = new AbortController()
  const result = testNotification('Myrmidon', 'hi', { signal: stop.signal })
  stop.abort()
  expect(await result).toEqual({ state: 'cancelled' })
  window.dispatchEvent(new Event('blur'))
  expect(sent).toEqual([])
})
