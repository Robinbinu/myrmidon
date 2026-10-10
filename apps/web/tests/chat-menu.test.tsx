import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ChatGroup, ChatSummary, Project } from '../src/client/api.ts'
import { editorLink } from '../src/client/chat/open-in.ts'
import { keyedAction, type MenuAction } from '../src/client/ui/Menu.tsx'
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
const chat = (chatId: string, extra: Partial<ChatSummary> = {}): ChatSummary =>
  ({ chatId, title: `Chat ${chatId}`, updatedAt: now, status: 'completed', rounds: [], ...extra }) as never

type Filed = { ids: string[]; place: { pinned?: boolean; archived?: boolean; group?: string | null } }

async function sidebar(chats: ChatSummary[], groups: ChatGroup[] = [], projects: Project[] = []) {
  const { Sidebar } = await import('../src/client/chat/Sidebar.tsx')
  const { ContextMenuHost } = await import('../src/client/ui/Menu.tsx')
  const filed: Filed[] = []
  const forked: string[] = []
  const made: string[] = []
  const noop = () => {}
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ContextMenuHost />
      <Sidebar
        chats={chats}
        loaded
        activeChat={undefined}
        view="chat"
        theme="light"
        onTheme={noop}
        onSelect={noop}
        onDelete={noop}
        onRename={async () => {}}
        groups={groups}
        onFile={(list, place) => filed.push({ ids: list.map((c) => c.chatId), place })}
        onFork={(c) => forked.push(c.chatId)}
        onNewGroup={async (name) => {
          made.push(name)
          return { id: 'group-new', name }
        }}
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
  await act(async () => Bun.sleep(5))
  return { filed, forked, made }
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-chat]')].map((r) => r.dataset.chat)
const row = (id: string) => document.querySelector<HTMLElement>(`[data-chat="${id}"]`) as HTMLElement
const items = (menu: Element | null) =>
  [...(menu?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]') ?? [])].map((b) => b.textContent)

// Under happy-dom a closed menu's fade-out never finishes, so it stays in the page: each menu opens at its own point,
// and the newest top-level one is the one on screen.
let at = 40
async function rightClick(id: string) {
  at += 10
  await act(async () => {
    row(id).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at, clientY: at }),
    )
  })
  const top = [...document.querySelectorAll('[role="menu"]')].filter(
    (m) => !m.parentElement?.closest('[role="menu"]'),
  )
  return top.at(-1) ?? null
}

test('a letter runs its row in an open menu; a submenu row has no letter of its own', () => {
  const ran: string[] = []
  const pin: MenuAction = { label: 'Pin', key: 'p', run: () => ran.push('pin') }
  const entries = [pin, { label: 'Move to group', submenu: [] }, 'separator' as const]
  expect(keyedAction(entries, 'P')).toBe(pin)
  expect(keyedAction(entries, 'm')).toBeUndefined()
  expect(keyedAction([{ ...pin, disabled: true }], 'p')).toBeUndefined()
  expect(keyedAction(entries, 'Enter')).toBeUndefined()
})

test('a folder opens in VS Code or Cursor from a link, on any system', () => {
  expect(editorLink('vscode', '/Users/me/My App')).toBe('vscode://file/Users/me/My%20App')
  expect(editorLink('cursor', 'C:\\work\\app')).toBe('cursor://file/C:/work/app')
})

test('pinned chats lead the list, groups follow, and archived chats fold at the bottom', async () => {
  await sidebar(
    [
      chat('a'),
      chat('b', { pinnedAt: '2026-10-10T09:00:00Z' }),
      chat('c', { group: 'group-1' }),
      chat('d', { archivedAt: '2026-10-10T09:00:00Z' }),
      chat('e', { pinnedAt: '2026-10-10T10:00:00Z' }),
    ],
    [{ id: 'group-1', name: 'Client work' }],
  )
  // The latest pin first; the archived chat is folded away.
  expect(rows()).toEqual(['e', 'b', 'c', 'a'])
  expect(document.body.textContent).toContain('Pinned')
  expect(document.body.textContent).toContain('Client work')
  const archived = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Archived'))
  expect(archived?.getAttribute('aria-expanded')).toBe('false')
  await act(async () => archived?.click())
  expect(rows()).toEqual(['e', 'b', 'c', 'a', 'd'])
})

test("a chat's menu pins, archives and forks it from a single letter, as in Claude's chat list", async () => {
  const { filed, forked } = await sidebar([chat('a'), chat('b', { pinnedAt: now, archivedAt: undefined })])
  let menu = await rightClick('a')
  expect(items(menu)).toEqual([
    'PinP',
    'Mark as unreadU',
    'RenameR',
    'ForkF',
    'Move to group',
    'Copy linkL',
    'ArchiveA',
    'Delete chatD',
  ])
  await press('p')
  expect(filed).toEqual([{ ids: ['a'], place: { pinned: true } }])

  menu = await rightClick('b')
  expect(items(menu)).toContain('UnpinP')
  await press('a')
  await rightClick('a')
  await press('f')
  expect(filed.at(-1)).toEqual({ ids: ['b'], place: { archived: true } })
  expect(forked).toEqual(['a'])
})

test('Move to group opens beside its row: a group files the chat, New group makes one and names it in place', async () => {
  const { filed, made } = await sidebar([chat('a', { group: 'group-1' })], [{ id: 'group-1', name: 'Later' }])
  const menu = await rightClick('a')
  const move = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find(
    (b) => b.textContent === 'Move to group',
  )
  await act(async () => move?.focus())
  await press('ArrowRight')
  const sub = menu?.querySelector('[role="menu"]')
  expect(items(sub ?? null)).toEqual(['Later', 'New group…', 'Out of the group'])
  // The group it is in already cannot be chosen again.
  expect(sub?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(true)
  expect(document.activeElement?.textContent).toBe('New group…')
  await press('ArrowLeft')
  expect(document.activeElement).toBe(move as HTMLElement)
  await press('ArrowRight')
  await act(async () => (document.activeElement as HTMLElement).click())
  await act(async () => Bun.sleep(5))
  expect(made).toEqual(['New group'])
  expect(filed).toEqual([{ ids: ['a'], place: { group: 'group-new' } }])
})

test('Open in is offered only for a chat in a project folder this list knows', async () => {
  const project = { id: 'p1', name: 'site', path: '/Users/me/site' } as Project
  await sidebar([chat('a', { project: { id: 'p1', name: 'site' } }), chat('b')], [], [project])
  expect(items(await rightClick('a'))[0]).toBe('Open in')
  await press('Escape')
  expect(items(await rightClick('b'))).not.toContain('Open in')
})
