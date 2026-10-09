import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const LISTINGS: Record<string, unknown> = {
  '': {
    path: '',
    entries: [
      { name: 'node_modules', path: 'node_modules', dir: true, ignored: true },
      { name: 'src', path: 'src', dir: true, changed: true },
      { name: 'README.md', path: 'README.md', dir: false },
    ],
    truncated: false,
  },
  src: {
    path: 'src',
    entries: [{ name: 'calc.py', path: 'src/calc.py', dir: false, status: 'M' }],
    truncated: false,
  },
}

test('the Explorer opens folders by click and keys, finds files by name, and opens a file in the viewer', async () => {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    asked.push(`${url.pathname.split('/').pop()}?${url.searchParams}`)
    if (url.pathname.endsWith('/tree')) return Response.json(LISTINGS[url.searchParams.get('path') ?? ''])
    if (url.pathname.endsWith('/find')) return Response.json({ paths: ['src/calc.py'], truncated: false })
    if (url.pathname.endsWith('/file'))
      return Response.json({ path: 'src/calc.py', text: 'def add(a, b):\n    return a + b\n' })
    return Response.json({})
  }) as unknown as typeof fetch
  const { ProjectExplorer } = await import('../src/client/chat/ProjectExplorer.tsx')
  const { ProjectFiles } = await import('../src/client/chat/ProjectFiles.tsx')
  const project = { id: 'app-1', name: 'app' }
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ProjectFiles project={project}>
        <ProjectExplorer project={project} edited={['src/calc.py']} />
      </ProjectFiles>
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  const rows = () =>
    [...doc.querySelectorAll<HTMLElement>('[role=treeitem]')].map(
      (r) =>
        `${r.getAttribute('aria-level')}:${r.textContent}${r.getAttribute('aria-expanded') === 'true' ? '/' : ''}`,
    )
  const row = (name: string) =>
    [...doc.querySelectorAll<HTMLElement>('[role=treeitem]')].find((r) => r.textContent?.startsWith(name))
  try {
    await act(async () => Bun.sleep(10))
    expect(rows()).toEqual(['1:node_modules', '1:src', '1:README.md'])
    // Typing finds files by name across the folder; clearing the box brings the tree back.
    const field = doc.querySelector<HTMLInputElement>('input[aria-label="Find a file by name"]')
    if (!field) throw new Error('no filter field')
    // happy-dom's input events do not reach React's change tracking, so the box gets its typing through its handler.
    const type = (value: string) =>
      act(async () => {
        const props = Object.entries(field).find(([k]) => k.startsWith('__reactProps'))?.[1] as {
          onChange(e: { target: { value: string } }): void
        }
        props.onChange({ target: { value } })
      })
    await type('calc')
    await act(async () => Bun.sleep(300))
    expect(asked).toContain('find?q=calc')
    expect(rows()).toEqual(['1:calc.pysrc'])
    await type('')
    expect(rows()).toEqual(['1:node_modules', '1:src', '1:README.md'])
    // A folder lists only when opened; the crew's file is marked, with its git status.
    await act(async () => row('src')?.click())
    await act(async () => Bun.sleep(10))
    expect(rows()).toEqual(['1:node_modules', '1:src/', '2:calc.pyM', '1:README.md'])
    expect(row('calc.py')?.querySelector('[aria-label="Changed in this chat"]')).not.toBeNull()
    // ← on an open folder closes it; → opens it again and steps in.
    await act(async () => row('src')?.focus())
    await press('ArrowLeft')
    expect(rows()).toEqual(['1:node_modules', '1:src', '1:README.md'])
    await press('ArrowRight')
    await press('ArrowRight')
    expect(doc.activeElement?.textContent).toStartWith('calc.py')
    await press('Enter')
    await act(async () => Bun.sleep(10))
    expect(doc.querySelector('[role=dialog]')?.textContent).toContain('return a + b')
    expect(asked.filter((a) => a.startsWith('tree')).length).toBe(2)
  } finally {
    await unmount()
  }
})
