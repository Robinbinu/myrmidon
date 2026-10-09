import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ChatSummary } from '../src/client/api.ts'
import { mount, withDom } from './dom.ts'

withDom()

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})

const chat = (chatId: string): ChatSummary =>
  ({ chatId, title: `Chat ${chatId}`, updatedAt: '', status: 'completed', rounds: [] }) as never

/** The hook as App uses it, with what it sent to the server recorded. */
async function held() {
  const { useHeldDeletes } = await import('../src/client/chat/held-deletes.ts')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const removed: string[] = []
  const gone: string[][] = []
  const api: { current?: ReturnType<typeof useHeldDeletes> } = {}
  function Harness() {
    api.current = useHeldDeletes({
      remove: async (id) => removed.push(id),
      gone: (ids) => gone.push([...ids]),
    })
    return <output>{[...api.current.deleted].join(',')}</output>
  }
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MotionConfig>,
  )
  unmount = view.unmount
  return { api, removed, gone }
}

const hiddenNow = () => document.querySelector('output')?.textContent ?? ''
const toasts = () => [...document.querySelectorAll('[role="status"]')].map((t) => t.textContent ?? '')
const undoButtons = () => [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Undo')

test('chats deleted together hide at once under one toast, and one Undo brings every one back', async () => {
  const { api, removed } = await held()
  let restored = 0
  await act(async () => api.current?.hold([chat('a'), chat('b'), chat('c')], () => restored++))
  expect(hiddenNow()).toBe('a,b,c')
  expect(toasts()).toEqual([expect.stringContaining('Deleted 3 chats')])
  expect(undoButtons()).toHaveLength(1)
  expect(api.current?.undoLast).toBeDefined()

  await act(async () => undoButtons()[0]?.click())
  expect(hiddenNow()).toBe('')
  expect(restored).toBe(1)
  expect(api.current?.undoLast).toBeUndefined()
  // Nothing reached the server: the delete waits for its undo to lapse.
  expect(removed).toEqual([])
})

test('one chat keeps its own toast, and ⌘Z takes back only the latest delete', async () => {
  const { api } = await held()
  await act(async () => api.current?.hold([chat('a')]))
  expect(toasts()).toEqual([expect.stringContaining('Deleted “Chat a”')])
  await act(async () => api.current?.hold([chat('b'), chat('c')]))
  expect(hiddenNow()).toBe('a,b,c')
  await act(async () => api.current?.undoLast?.())
  expect(hiddenNow()).toBe('a')
})
