import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { DESKTOP_SHORTCUT_EVENT } from '../src/client/ui/desktop.ts'
import { useHotkeys } from '../src/client/ui/hooks.ts'
import { mount, press, withDom } from './dom.ts'

withDom()

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})

const ran: string[] = []

function Keys() {
  useHotkeys([
    { combo: 'mod+n', run: () => ran.push('new'), inInputs: true },
    { combo: '/', run: () => ran.push('focus') },
  ])
  return <input aria-label="field" />
}

/** What the desktop shell's app menu does for an item: names the item's shortcut in a window event. */
const menu = (combo: string) =>
  act(async () => {
    window.dispatchEvent(new CustomEvent(DESKTOP_SHORTCUT_EVENT, { detail: combo }))
  })

test('an app-menu item runs the handler of the shortcut it names', async () => {
  ran.length = 0
  unmount = (await mount(<Keys />)).unmount
  await menu('mod+n')
  await menu('mod+q')
  expect(ran).toEqual(['new'])
})

test('a menu item runs its shortcut even while typing, unlike the key itself', async () => {
  ran.length = 0
  const { host, unmount: done } = await mount(<Keys />)
  unmount = done
  host.querySelector('input')?.focus()
  await press('/')
  expect(ran).toEqual([])
  await menu('/')
  expect(ran).toEqual(['focus'])
})

test('the handler goes away with the component', async () => {
  ran.length = 0
  const { unmount: done } = await mount(<Keys />)
  await done()
  await menu('mod+n')
  expect(ran).toEqual([])
})
