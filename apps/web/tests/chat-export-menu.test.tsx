import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ChatSummary } from '../src/client/api.ts'
import { mount, withDom } from './dom.ts'

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

const chat = {
  chatId: 'a',
  title: 'Chat a',
  updatedAt: new Date().toISOString(),
  status: 'completed',
  rounds: [],
}

async function sidebar() {
  const { Sidebar } = await import('../src/client/chat/Sidebar.tsx')
  const { ContextMenuHost } = await import('../src/client/ui/Menu.tsx')
  const did: string[] = []
  const noop = () => {}
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ContextMenuHost />
      <Sidebar
        chats={[chat as unknown as ChatSummary]}
        loaded
        activeChat={undefined}
        view="chat"
        theme="light"
        onTheme={noop}
        onSelect={noop}
        onDelete={noop}
        onRename={async () => {}}
        onExport={(c, format) => did.push(`export ${c.chatId} ${format}`)}
        onShare={(c) => did.push(`share ${c.chatId}`)}
        onFamily={(c) => did.push(`family ${c.chatId}`)}
        onNew={noop}
        projects={[]}
        onNewInProject={noop}
        onView={noop}
        onSettings={noop}
        onGateways={noop}
        onCollapse={noop}
      />
    </MotionConfig>,
  )
  unmount = view.unmount
  await act(async () => Bun.sleep(5))
  return did
}

const menuItems = (menu: Element | null | undefined) => [
  ...(menu?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]') ?? []),
]

async function openMenu() {
  await act(async () => {
    document
      .querySelector('[data-chat="a"]')
      ?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
  })
  // Under happy-dom a closed menu never finishes fading out: the newest top-level menu is the one on screen.
  return [...document.querySelectorAll('[role="menu"]')]
    .filter((m) => !m.parentElement?.closest('[role="menu"]'))
    .at(-1)
}

async function choose(item: HTMLElement | undefined) {
  await act(async () => item?.click())
}

test("a chat's menu shows its family, and Export offers Markdown, a web page or an encrypted share file", async () => {
  const did = await sidebar()
  const menu = await openMenu()
  const labels = menuItems(menu).map((b) => b.textContent ?? '')
  expect(labels.some((l) => l.startsWith('Show family'))).toBe(true)
  await choose(menuItems(menu).find((b) => b.textContent?.startsWith('Show family')))
  expect(did).toEqual(['family a'])

  const again = await openMenu()
  await choose(menuItems(again).find((b) => b.textContent?.startsWith('Export')))
  const sub = [...document.querySelectorAll('[role="menu"]')].find((m) =>
    menuItems(m).some((b) => b.textContent?.startsWith('Web page')),
  )
  expect(menuItems(sub).map((b) => b.textContent?.replace(/[A-Z]$/, ''))).toEqual([
    'Markdown (.md)',
    'Web page (.html)',
    'Encrypted share file…',
  ])
  await choose(menuItems(sub).find((b) => b.textContent?.startsWith('Web page')))
  expect(did).toEqual(['family a', 'export a html'])
})
