import { afterAll, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

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

test('a chats-only device is not offered System, which reports on and points to what it cannot use', async () => {
  const { Sidebar } = await import('../src/client/chat/Sidebar.tsx')
  const { ScopeContext } = await import('../src/client/DeviceGate.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const noop = () => {}
  const html = (scope: 'full' | 'chat') =>
    renderToStaticMarkup(
      <ScopeContext.Provider value={scope}>
        <Sidebar
          chats={[]}
          loaded
          view="chat"
          theme="light"
          onTheme={noop}
          onSelect={noop}
          onDelete={noop}
          onRename={async () => {}}
          onNew={noop}
          projects={[]}
          onNewInProject={noop}
          onView={noop}
          onSettings={noop}
          onGateways={noop}
          onCollapse={noop}
        />
      </ScopeContext.Provider>,
    )
  const label = `</svg> ${copy.system.nav}</button>`
  expect(html('full')).toContain(label)
  expect(html('chat')).not.toContain(label)
})
