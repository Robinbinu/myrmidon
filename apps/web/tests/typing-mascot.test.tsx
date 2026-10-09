import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MASCOT_TYPING } from '../src/client/ui-config.ts'
import { withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Renders `draft` through the hook and keeps re-rendering it as a message box would. */
async function probe(idleMs: number, throttleMs: number, first = '') {
  const { useTypedText } = await import('../src/client/chat/Hero.tsx')
  const seen: (string | undefined)[] = []
  function Probe(props: { draft: string }) {
    const shown = useTypedText(props.draft, idleMs, throttleMs)
    seen.push(shown)
    return <p data-shown={shown ?? ''}>{shown === undefined ? 'eyes' : shown}</p>
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const type = (draft: string) => act(async () => root.render(<Probe draft={draft} />))
  await type(first)
  return {
    type,
    screen: () => host.textContent,
    renders: () => seen.length,
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

test('typing shows the text; stopping for the idle time brings the eyes back', async () => {
  const p = await probe(120, 0)
  try {
    expect(p.screen()).toBe('eyes')
    await p.type('h')
    await p.type('hello')
    expect(p.screen()).toBe('hello')
    // Still typing: each key starts the idle time again.
    await act(async () => Bun.sleep(80))
    await p.type('hello there')
    await act(async () => Bun.sleep(80))
    expect(p.screen()).toBe('hello there')
    await act(async () => Bun.sleep(80))
    expect(p.screen()).toBe('eyes')
    // Typing again brings the text back.
    await p.type('hello there!')
    expect(p.screen()).toBe('hello there!')
  } finally {
    await p.unmount()
  }
})

test('clearing the box brings the eyes back at once, and blank space is not text', async () => {
  const p = await probe(10_000, 0)
  try {
    await p.type('draft')
    expect(p.screen()).toBe('draft')
    await p.type('')
    expect(p.screen()).toBe('eyes')
    await p.type('   ')
    expect(p.screen()).toBe('eyes')
  } finally {
    await p.unmount()
  }
})

test('a draft already in the box when the screen opens is not typing; a long one shows its end', async () => {
  const p = await probe(10_000, 0, 'left over from before')
  try {
    expect(p.screen()).toBe('eyes')
    const long = `${'a'.repeat(100)}END`
    await p.type(long)
    expect(p.screen()).toBe(long.slice(-MASCOT_TYPING.maxChars))
    expect(p.screen()?.endsWith('END')).toBe(true)
  } finally {
    await p.unmount()
  }
})

test('fast typing redraws the screen at most once per throttle, ending on the last text', async () => {
  const p = await probe(10_000, 60)
  try {
    await p.type('a')
    const before = p.renders()
    for (const text of ['ab', 'abc', 'abcd', 'abcde']) await p.type(text)
    // The keys themselves render the probe, but the text it shows waits for the throttle.
    expect(p.screen()).toBe('a')
    await act(async () => Bun.sleep(90))
    expect(p.screen()).toBe('abcde')
    expect(p.renders() - before).toBe(5)
  } finally {
    await p.unmount()
  }
})

test('the new-chat mascot spells out what is typed with a cursor bar, then its eyes come back', async () => {
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch
  const { Hero } = await import('../src/client/chat/Hero.tsx')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const show = (draft: string) =>
    act(async () =>
      root.render(
        <MotionConfig reducedMotion="always" skipAnimations>
          <Hero draft={draft} working={0} news="" recent={[]} onOpenChat={() => {}} onPick={() => {}}>
            <div />
          </Hero>
        </MotionConfig>,
      ),
    )
  try {
    await show('')
    expect(host.querySelector('[data-typed]')).toBeNull()
    await show('Hi crew')
    const typed = host.querySelector('[data-typed]')
    expect(typed?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Hi crew')
    // The cursor bar blinks (quieted by the less-motion rule in styles.css), and with less motion nothing scrolls.
    expect(typed?.querySelector('svg.caret')).not.toBeNull()
    expect(typed?.querySelector('[data-scrolling]')).toBeNull()
    // The eyes are faded out under the text, not removed, so the screen keeps its size.
    expect(host.querySelector('button svg[aria-hidden].opacity-0')).not.toBeNull()
    await show('')
    await act(async () => Bun.sleep(300))
    expect(host.querySelector('[data-typed]')).toBeNull()
    expect(host.querySelector('button svg.opacity-0')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
