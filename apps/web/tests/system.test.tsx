import { afterAll, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// System pulls in api.ts, which reads the page's address and storage when it loads.
const page = globalThis as unknown as Record<string, unknown>
beforeAll(() => {
  page.window = new EventTarget()
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})
afterAll(() => {
  delete page.window
  delete page.location
})

test('the sandbox is named for a person, and an unknown one is not called confined', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.system
  expect(t.sandbox('sandbox-exec')).toBe('Shell commands are confined by macOS')
  expect(t.sandbox('bubblewrap')).toBe('Shell commands are confined by bubblewrap')
  for (const kind of ['none', 'unknown', undefined])
    expect(t.sandbox(kind)).toBe("Shell commands aren't confined")
})

test('the data folder is shown from the home folder, the way people write it', async () => {
  const { shortPath } = await import('../src/client/System.tsx')
  expect(shortPath('/Users/robin/.myrmidon')).toBe('~/.myrmidon')
  expect(shortPath('/home/ada/.myrmidon')).toBe('~/.myrmidon')
  expect(shortPath('/root/.myrmidon')).toBe('~/.myrmidon')
  expect(shortPath('/srv/myrmidon')).toBe('/srv/myrmidon')
})

test('a channel set up but switched off still counts as set up', async () => {
  const { setUpChannels } = await import('../src/client/System.tsx')
  const off = { id: 'telegram', enabled: false }
  // Without `configured`, the server lists only channels in use.
  expect(setUpChannels([off])).toEqual([off])
  // With it, each channel says for itself.
  const blank = { id: 'slack', enabled: false, configured: false }
  const kept = { id: 'email', enabled: false, configured: true }
  const on = { id: 'line', enabled: true, configured: false }
  expect(setUpChannels([blank, kept, on])).toEqual([kept, on])
})

test('System shows that it is loading before the first answer, not an empty page', async () => {
  const { SystemPage } = await import('../src/client/System.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const html = renderToStaticMarkup(<SystemPage onManageChannels={() => {}} onOpenChat={() => {}} />)
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain(copy.system.loading)
})
