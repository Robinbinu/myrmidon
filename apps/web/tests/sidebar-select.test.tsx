import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ChatSummary, Project } from '../src/client/api.ts'
import { mount, press, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
let unmount: (() => Promise<void>) | undefined
beforeEach(() => {
  // The sidebar asks which chats came from a channel; none did.
  globalThis.fetch = (async () => Response.json({ chats: {} })) as unknown as typeof fetch
})
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  globalThis.fetch = realFetch
})

const now = new Date().toISOString()
const chat = (chatId: string): ChatSummary =>
  ({ chatId, title: `Chat ${chatId}`, updatedAt: now, status: 'completed', rounds: [] }) as never

/** The sidebar with chats a to e, `c` open; what it asked to open and delete is recorded. */
async function sidebar(chats = ['a', 'b', 'c', 'd', 'e'].map(chat), projects: Project[] = []) {
  const { Sidebar } = await import('../src/client/chat/Sidebar.tsx')
  const opened: string[] = []
  const deleted: string[][] = []
  const noop = () => {}
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <Sidebar
        chats={chats}
        loaded
        activeChat="c"
        view="chat"
        theme="light"
        onTheme={noop}
        onSelect={(id) => opened.push(id)}
        onDelete={(list) => deleted.push(list.map((c) => c.chatId))}
        onRename={async () => {}}
        onExport={noop}
        onNew={noop}
        projects={projects}
        onNewInProject={noop}
        onView={noop}
        onSettings={noop}
        onGateways={noop}
        onCollapse={noop}
      />
    </MotionConfig>,
  )
  unmount = view.unmount
  // Lets the channel lookup answer inside act, so its update is not a stray one.
  await act(async () => Bun.sleep(5))
  return { opened, deleted }
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-chat="${id}"]`) as HTMLElement
const selected = () =>
  [...document.querySelectorAll<HTMLElement>('[data-chat][aria-selected="true"]')].map((r) => r.dataset.chat)

/** ⌘ on a Mac, Ctrl elsewhere, the way platform.ts reads this page. */
async function modifier() {
  const { isMac } = await import('../src/client/ui/platform.ts')
  return { metaKey: isMac, ctrlKey: !isMac }
}

async function focus(id: string) {
  await act(async () => row(id).focus())
}

async function click(id: string, init: MouseEventInit = {}) {
  await act(async () => {
    row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

test('the chat list says it allows picking several, and no row is picked at first', async () => {
  await sidebar()
  const lists = [...document.querySelectorAll('[role="listbox"]')]
  expect(lists.length).toBeGreaterThan(0)
  for (const list of lists) expect(list.getAttribute('aria-multiselectable')).toBe('true')
  expect(row('a').getAttribute('role')).toBe('option')
  expect(row('a').getAttribute('aria-selected')).toBe('false')
  expect(selected()).toEqual([])
})

test('⌘-click adds to the open chat and toggles; a plain click opens a chat and lets go of the rest', async () => {
  const { opened } = await sidebar()
  const mod = await modifier()
  await click('a', mod)
  // The open chat was the selected row, so ⌘-click adds to it rather than starting over.
  expect(selected()).toEqual(['a', 'c'])
  await click('e', mod)
  expect(selected()).toEqual(['a', 'c', 'e'])
  await click('c', mod)
  expect(selected()).toEqual(['a', 'e'])
  expect(opened).toEqual([])
  expect(document.querySelector('[role="toolbar"]')?.textContent).toContain('2 selected')
  await click('b')
  expect(opened).toEqual(['b'])
  expect(selected()).toEqual([])
  expect(document.querySelector('[role="toolbar"]')).toBeNull()
})

test('⇧-click takes the range from the last clicked row, in list order', async () => {
  const { opened } = await sidebar()
  // With nothing clicked yet the range starts at the open chat.
  await click('e', { shiftKey: true })
  expect(selected()).toEqual(['c', 'd', 'e'])
  await click('a', { ...(await modifier()) })
  await click('b', { shiftKey: true })
  expect(selected()).toEqual(['a', 'b'])
  expect(opened).toEqual([])
})

test('⌘A picks every row shown while the list has focus, and Esc lets go', async () => {
  await sidebar()
  await focus('b')
  const selectAll = await press('a', await modifier())
  expect(selectAll.defaultPrevented).toBe(true)
  expect(selected()).toEqual(['a', 'b', 'c', 'd', 'e'])
  const esc = await press('Escape')
  expect(esc.defaultPrevented).toBe(true)
  expect(selected()).toEqual([])
  // With nothing picked, Escape is left to the page around.
  expect((await press('Escape')).defaultPrevented).toBe(false)
})

test('⇧ with the arrow keys grows the selection from the focused row', async () => {
  await sidebar()
  await focus('b')
  await press('ArrowDown', { shiftKey: true })
  await press('ArrowDown', { shiftKey: true })
  expect(selected()).toEqual(['b', 'c', 'd'])
  expect(document.activeElement).toBe(row('d'))
})

test('Delete, the bar and the context menu each delete the whole selection at once', async () => {
  const { deleted } = await sidebar()
  const mod = await modifier()
  await click('a', mod)
  await click('d', mod)
  await focus('d')
  await press('Delete')
  expect(deleted).toEqual([['a', 'c', 'd']])

  const bar = [...document.querySelectorAll('[role="toolbar"] button')].find((b) =>
    b.textContent?.includes('Delete 3 chats'),
  ) as HTMLButtonElement
  await act(async () => bar.click())
  expect(deleted).toEqual([
    ['a', 'c', 'd'],
    ['a', 'c', 'd'],
  ])

  // A row outside the selection still deletes only itself.
  await focus('e')
  await press('Backspace', { metaKey: true })
  expect(deleted.at(-1)).toEqual(['e'])
})

test('rows a folded project hides drop out of the selection and of what is deleted', async () => {
  const project = { id: 'p', name: 'Site', path: '/site' } as Project
  const { deleted } = await sidebar([{ ...chat('p1'), project }, chat('a'), chat('b')], [project])
  await focus('a')
  await press('a', await modifier())
  expect(selected()).toEqual(['p1', 'a', 'b'])
  const fold = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) =>
    b.textContent?.includes('Site'),
  ) as HTMLButtonElement
  await act(async () => fold.click())
  expect(row('p1')).toBeNull()
  expect(document.querySelector('[role="toolbar"]')?.textContent).toContain('2 selected')
  await focus('a')
  await press('Delete')
  expect(deleted).toEqual([['a', 'b']])
})
