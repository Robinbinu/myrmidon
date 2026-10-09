import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('a folder listing that comes back late does not replace the one opened after it', async () => {
  // The home folder lists at once; its subfolder `code` answers late, after the person has already gone up a level.
  let answerCode: (r: Response) => void = () => {}
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    const path = new URL(url, 'http://localhost/').searchParams.get('path')
    if (path === '~') return Response.json({ path: '/Users/me', parent: '/Users', folders: ['code'] })
    if (path === '/Users/me/code') return new Promise<Response>((resolve) => (answerCode = resolve))
    return Response.json({ path, parent: '/', folders: ['me'] })
  }) as unknown as typeof fetch
  // FolderPicker reaches api.ts, which reads the page as it loads.
  const { FolderPicker } = await import('../src/client/chat/FolderPicker.tsx')
  const { host, unmount } = await mount(
    // Still sheets: happy-dom rejects the cancelled animations of a sheet taken down mid-entrance.
    <MotionConfig reducedMotion="always">
      <FolderPicker onClose={() => {}} onAdded={() => {}} />
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  const field = () => doc.querySelector('input') as HTMLInputElement
  const row = (name: string) =>
    [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement
  try {
    await act(async () => Bun.sleep(10))
    expect(field().value).toBe('/Users/me')
    await act(async () => {
      row('code').click()
      row('..').click()
      await Bun.sleep(10)
    })
    expect(field().value).toBe('/Users')
    await act(async () => {
      answerCode(Response.json({ path: '/Users/me/code', parent: '/Users/me', folders: ['app'] }))
      await Bun.sleep(10)
    })
    expect(field().value).toBe('/Users')
    expect(row('app')).toBeUndefined()
  } finally {
    await unmount()
  }
})
