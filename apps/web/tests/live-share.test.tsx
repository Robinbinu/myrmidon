import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ChatSummary } from '../src/client/api.ts'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket
let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
  history.replaceState(null, '', '/')
})

type Sent = { method: string; path: string; body: unknown }

/** Answers requests by method and path, and records each one. */
function server(routes: Record<string, (body: unknown) => Response>) {
  const sent: Sent[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ method, path: url.pathname, body })
    const route = routes[`${method} ${url.pathname}`]
    return route ? route(body) : Response.json({ error: 'not found' }, { status: 404 })
  }) as unknown as typeof fetch
  return sent
}

/** No live stream in a test: the log is all there is. */
class QuietSocket {
  onopen = null
  onmessage = null
  onclose = null
  readyState = 0
  close() {}
}

const settle = () => act(async () => Bun.sleep(10))
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined
const click = (el: Element | undefined) => act(async () => (el as HTMLElement | undefined)?.click())
const text = () => document.body.textContent ?? ''

/**
 * Types into a field as React hears it here: react-dom loaded before this file's page went up, so it listens for
 * key presses on the focused field rather than input events (as settings-registry.test.tsx does).
 */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    el.focus()
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.at(-1) ?? '' }))
  })
}

const chat = { chatId: 'chat-a', title: 'Launch plans', updatedAt: '', status: 'completed', rounds: [] }

test('Share live makes a write invite on request, lists who is in, and removes them or stops sharing', async () => {
  let share = {
    remote: false,
    invites: [] as unknown[],
    guests: [{ id: 'gst-1', name: 'Ann', access: 'view', joinedAt: '', online: true }],
  }
  const sent = server({
    'GET /api/chats/chat-a/share': () => Response.json(share),
    'POST /api/chats/chat-a/share': () => {
      share = {
        ...share,
        invites: [{ id: 'inv-1', access: 'write', createdAt: '', expiresAt: '2026-10-10T13:00:00Z' }],
      }
      return Response.json({
        link: 'https://box.example.ts.net/#join=ABCDEFGHJKMN',
        code: 'ABCDEFGHJKMN',
        invite: { id: 'inv-1', expiresAt: '2026-10-10T13:00:00Z' },
      })
    },
    'DELETE /api/chats/chat-a/share/guests/gst-1': () => {
      share = { ...share, guests: [] }
      return Response.json({ ok: true })
    },
    'DELETE /api/chats/chat-a/share': () => {
      share = { ...share, invites: [], guests: [] }
      return Response.json({ ok: true })
    },
  })
  const { LiveShare } = await import('../src/client/chat/LiveShare.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.liveShare
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <LiveShare chat={chat as unknown as ChatSummary} onClose={() => {}} />
      </ToastProvider>
    </MotionConfig>,
  )
  unmount = view.unmount
  await settle()
  // On this computer alone, the sheet says the link only opens here.
  expect(text()).toContain(t.localOnly)
  expect(text()).toContain('Ann')
  expect(text()).toContain(t.guest('view', true))
  expect(text()).toContain(t.accessHint.view)

  await click(button(t.write))
  expect(text()).toContain(t.accessHint.write)
  await click(button(t.create))
  await settle()
  expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ access: 'write' })
  const link = document.querySelector<HTMLInputElement>('input[readonly]')
  expect(link?.value).toBe('https://box.example.ts.net/#join=ABCDEFGHJKMN')
  expect(text()).toContain('ABCDEFGHJKMN')
  expect(text()).toContain(t.invitesTitle)

  await click(document.querySelector(`[aria-label="${t.removeLabel('Ann')}"]`) ?? undefined)
  await settle()
  expect(sent.some((s) => s.method === 'DELETE' && s.path === '/api/chats/chat-a/share/guests/gst-1')).toBe(
    true,
  )
  expect(text()).toContain(t.noGuests)

  await click(button(t.stop))
  await settle()
  expect(sent.some((s) => s.method === 'DELETE' && s.path === '/api/chats/chat-a/share')).toBe(true)
  expect(button(t.stop)).toBeUndefined()
})

const COLONY = 'plans-muwf7asm-25d13a'
const log = [
  { seq: 1, type: 'colony/started', payload: {} },
  { seq: 2, type: 'chat/user', payload: { text: 'plan the launch' } },
  { seq: 3, type: 'chat/reply', payload: { agent: 'lead', text: 'Here is **the plan**.', final: true } },
].map((e) => ({
  colonyId: COLONY,
  id: `e${e.seq}`,
  time: '2026-10-10T12:00:00Z',
  actor: { kind: 'agent', id: 'lead' },
  trace: { traceId: 't', spanId: 's' },
  schema: 1,
  ...e,
}))

const guestView = (access: 'view' | 'write', status = 'running', extra = {}) => ({
  guest: { id: 'gst-1', name: 'Bob', access, joinedAt: '' },
  host: 'Robin',
  chat: {
    ...chat,
    status,
    rounds: [{ colonyId: COLONY, round: 1, status, request: 'plan the launch' }],
    ...extra,
  },
})

async function guestPage(routes: Record<string, (body: unknown) => Response>) {
  globalThis.WebSocket = QuietSocket as never
  const sent = server({ [`GET /api/colonies/${COLONY}/events`]: () => Response.json(log), ...routes })
  const { GuestChat } = await import('../src/client/GuestChat.tsx')
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <GuestChat />
    </MotionConfig>,
  )
  unmount = view.unmount
  await settle()
  return sent
}

test('a guest with a write link sees the chat as it happens and writes into it, told the person approves', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.guest
  const sent = await guestPage({
    'GET /api/guest': () => Response.json(guestView('write', 'running', { approving: true })),
    'POST /api/guest/messages': () => Response.json({ ok: true }),
  })
  expect(text()).toContain('Launch plans')
  expect(text()).toContain(t.sharedBy('Robin'))
  expect(text()).toContain(t.you('Bob', 'write'))
  expect(text()).toContain('plan the launch')
  expect(document.querySelector('strong')?.textContent).toBe('the plan')
  expect(text()).toContain(t.approving('Robin'))
  expect(text()).toContain(t.asks('Robin'))
  // Nothing of the person's beyond the chat: no chat list, no Settings.
  expect(text()).not.toContain('Settings')

  const box = document.querySelector('textarea') as HTMLTextAreaElement
  await type(box, 'also check the budget')
  await click(button(t.send))
  await settle()
  expect(sent.filter((s) => s.method === 'POST')).toEqual([
    { method: 'POST', path: '/api/guest/messages', body: { text: 'also check the budget' } },
  ])
  expect(box.value).toBe('')
})

test('a guest with a view link has no box to write in, and the page ends once they are let go', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.guest
  let inside = true
  await guestPage({
    'GET /api/guest': () =>
      inside
        ? Response.json(guestView('view', 'completed'))
        : Response.json({ error: 'unauthorized' }, { status: 401 }),
  })
  expect(text()).toContain(t.viewOnly)
  expect(document.querySelector('textarea')).toBeNull()

  inside = false
  const { GUEST_POLL_MS } = await import('../src/client/ui-config.ts')
  await act(async () => Bun.sleep(GUEST_POLL_MS + 50))
  expect(text()).toContain(t.ended.title)
  expect(text()).not.toContain('Launch plans')
})

test('an invite link opens the join page with its code; joining sends the code and the name given', async () => {
  history.replaceState(null, '', '/#join=ABCDEFGHJKMN')
  const sent = server({ 'POST /api/guest/join': () => Response.json({ guest: {}, chatId: 'chat-a' }) })
  const { JoinScreen } = await import('../src/client/GuestChat.tsx')
  const { copy } = await import('../src/client/copy.ts')
  let joined = 0
  const view = await mount(<JoinScreen onJoined={() => joined++} />)
  unmount = view.unmount
  const code = document.querySelector<HTMLInputElement>(`input[aria-label="${copy.guest.join.code}"]`)
  expect(code?.value).toBe('ABCDEFGHJKMN')
  expect(button(copy.guest.join.join)?.disabled).toBe(true)
  await type(
    document.querySelector<HTMLInputElement>(
      `input[aria-label="${copy.guest.join.name}"]`,
    ) as HTMLInputElement,
    'Bob',
  )
  await click(button(copy.guest.join.join))
  await settle()
  expect(sent).toEqual([
    { method: 'POST', path: '/api/guest/join', body: { code: 'ABCDEFGHJKMN', name: 'Bob' } },
  ])
  expect(joined).toBe(1)
  // The spent code leaves the address bar.
  expect(location.hash).toBe('')
})

test("a chat's menu offers Share live only where the device may share", async () => {
  globalThis.fetch = (async () => Response.json({ chats: {} })) as unknown as typeof fetch
  const { Sidebar } = await import('../src/client/chat/Sidebar.tsx')
  const { ContextMenuHost } = await import('../src/client/ui/Menu.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const did: string[] = []
  const noop = () => {}
  const render = async (shareLive: boolean) => {
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
          {...(shareLive ? { onShareLive: (c: ChatSummary) => did.push(c.chatId) } : {})}
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
    await settle()
    await act(async () => {
      document
        .querySelector('[data-chat="chat-a"]')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
        )
    })
    const menu = [...document.querySelectorAll('[role="menu"]')]
      .filter((m) => !m.parentElement?.closest('[role="menu"]'))
      .at(-1)
    const items = [...(menu?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]') ?? [])]
    const item = items.find((b) => b.textContent?.startsWith(copy.contextMenu.chat.shareLive))
    await click(item)
    await view.unmount()
    return !!item
  }
  expect(await render(false)).toBe(false)
  expect(await render(true)).toBe(true)
  expect(did).toEqual(['chat-a'])
})
