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

test('a restart that turned the channel off but could not turn it back on says it is off', async () => {
  const { restartChannel } = await import('../src/client/System.tsx')
  const calls: boolean[] = []
  const put = (fails: boolean[]) => async (enabled: boolean) => {
    calls.push(enabled)
    if (fails.shift()) throw new Error('the server said no')
  }
  expect(await restartChannel(put([false, false]))).toEqual({ outcome: 'restarted' })
  // One failed attempt to switch back on is tried again.
  calls.length = 0
  expect(await restartChannel(put([false, true, false]))).toEqual({ outcome: 'restarted' })
  expect(calls).toEqual([false, true, true])
  // Turning it off failed: it is still on.
  expect(await restartChannel(put([true]))).toMatchObject({ outcome: 'failed' })
  // Off, and twice it would not come back on.
  expect(await restartChannel(put([false, true, true]))).toMatchObject({
    outcome: 'off',
    error: new Error('the server said no'),
  })
})

test('a status check the gateway answered with an error says so, with Try again, instead of loading for ever', async () => {
  const { SystemPage } = await import('../src/client/System.tsx')
  const { StatusContext } = await import('../src/client/status.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const html = renderToStaticMarkup(
    <StatusContext.Provider value={{ offline: false, error: copy.api.serverProblem, refresh: () => {} }}>
      <SystemPage onManageChannels={() => {}} onOpenChat={() => {}} />
    </StatusContext.Provider>,
  )
  expect(html).not.toContain('aria-busy="true"')
  expect(html).toContain(copy.api.serverProblem)
  expect(html).toContain(copy.system.tryAgain)
})
