import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const shot = (id: string, blob: string) => ({
  id,
  kind: 'computer' as const,
  agent: 'ada',
  lead: 'Clicked in',
  strong: 'Notes',
  time: '2026-10-09T10:00:00.000Z',
  shot: { colony: 'c1', blob },
})

test("a computer-use step fetches its screenshot only when opened, and says so quietly when it can't", async () => {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const blob = url.pathname.split('/').pop() ?? ''
    asked.push(blob)
    if (blob === 'gone') return Response.json({ error: 'no such blob' }, { status: 404 })
    return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }))
  }) as unknown as typeof fetch
  const { StepRow } = await import('../src/client/chat/StepRow.tsx')
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ul>
        <StepRow step={shot('s1', 'seen')} />
        <StepRow step={shot('s2', 'gone')} />
      </ul>
    </MotionConfig>,
  )
  const steps = [...host.querySelectorAll('details')]
  const open = (details: HTMLDetailsElement | undefined) =>
    act(async () => {
      if (!details) throw new Error('no step')
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await Bun.sleep(10)
    })
  try {
    await act(async () => Bun.sleep(10))
    expect(asked).toEqual([])
    await open(steps[0])
    expect(asked).toEqual(['seen'])
    expect(steps[0]?.querySelector('img')).not.toBeNull()
    await open(steps[1])
    expect(asked).toEqual(['seen', 'gone'])
    expect(steps[1]?.querySelector('.animate-pulse')).toBeNull()
    expect(steps[1]?.textContent).toContain('The screenshot could not be loaded')
  } finally {
    await unmount()
  }
})
