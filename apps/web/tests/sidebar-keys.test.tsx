import { afterAll, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatSummary, Project } from '../src/client/api.ts'

// The sidebar pulls in api.ts, which reads the page's address and storage when it loads.
const page = globalThis as unknown as Record<string, unknown>
beforeAll(() => {
  page.window = Object.assign(new EventTarget(), { innerWidth: 1440 })
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})
afterAll(() => {
  delete page.window
  delete page.location
})

test('the Tab stop goes to a chat row on screen, never to one folded away in a project', async () => {
  const { tabStopRow } = await import('../src/client/chat/Sidebar.tsx')
  // The open chat sits in a folded project, so its row is not among those shown.
  expect(tabStopRow(['a', 'b'], [undefined, 'hidden'])).toBe('a')
  expect(tabStopRow(['a', 'b'], ['b', 'a'])).toBe('b')
  expect(tabStopRow(['a', 'b'], ['gone', 'a'])).toBe('a')
  expect(tabStopRow([], ['a'])).toBeUndefined()
})

test('the chat list is one Tab stop however many chats and projects it shows', async () => {
  const { Sidebar } = await import('../src/client/chat/Sidebar.tsx')
  const noop = () => {}
  const now = new Date().toISOString()
  const chat = (chatId: string, project?: Project): ChatSummary =>
    ({
      chatId,
      title: chatId,
      updatedAt: now,
      status: 'completed',
      rounds: [],
      ...(project ? { project } : {}),
    }) as never
  const project = { id: 'p', name: 'p', path: '/p' } as Project
  const html = renderToStaticMarkup(
    <Sidebar
      chats={[chat('one', project), chat('two'), chat('three')]}
      loaded
      activeChat="three"
      view="chat"
      theme="light"
      onTheme={noop}
      onSelect={noop}
      onDelete={noop}
      onRename={async () => {}}
      onNew={noop}
      projects={[project]}
      onNewInProject={noop}
      onView={noop}
      onSettings={noop}
      onGateways={noop}
      onCollapse={noop}
    />,
  )
  const rows = [...html.matchAll(/<button[^>]*data-chat="([^"]+)"[^>]*tabindex="(-?\d)"/g)].map((m) => [
    m[1],
    m[2],
  ])
  expect(rows).toHaveLength(3)
  expect(rows.filter(([, tab]) => tab === '0')).toEqual([['three', '0']])
})
