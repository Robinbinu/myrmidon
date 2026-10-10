import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ScreenPointer } from '../src/client/ComputerOverlay.tsx'
import { mount, withDom } from './dom.ts'

withDom()

const pointer = (agent: string, x: number, y: number): ScreenPointer => ({
  colonyId: 'c1',
  agent,
  x,
  y,
  action: 'click',
  at: Date.now(),
})

test('each display shows the cursors on it, in its own coordinates', async () => {
  const { pointersOn } = await import('../src/client/ComputerOverlay.tsx')
  const right = { x: 1440, y: 0, width: 1920, height: 1080 }
  expect(pointersOn(right, [pointer('nova', 1500, 200), pointer('ada', 100, 100)])).toEqual([
    { ...pointer('nova', 60, 200), at: expect.any(Number) },
  ])
  expect(pointersOn({ x: 0, y: 0, width: 1440, height: 900 }, [pointer('ada', 1440, 10)])).toEqual([])
})

const realFetch = globalThis.fetch
let unmount: (() => Promise<void>) | undefined
let answer: unknown
beforeEach(() => {
  globalThis.fetch = (async () => Response.json(answer)) as unknown as typeof fetch
})
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  globalThis.fetch = realFetch
})

async function overlay() {
  const { ComputerOverlay } = await import('../src/client/ComputerOverlay.tsx')
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ComputerOverlay />
    </MotionConfig>,
  )
  unmount = view.unmount
  await act(async () => Bun.sleep(10))
}

test('while an agent drives the Mac the main display glows, says who and how to stop, and shows its cursor', async () => {
  answer = {
    controls: [{ colonyId: 'c1', agent: 'nova', app: 'Notes' }],
    pointers: [pointer('nova', 200, 150)],
  }
  await overlay()
  expect(document.body.style.background).toBe('transparent')
  expect(document.body.textContent).toContain('nova')
  expect(document.body.textContent).toContain('Notes')
  expect(document.body.textContent).toContain('Press Esc to stop')
  // Nothing on it takes a click: the person's apps underneath get every one.
  expect(document.querySelector('.pointer-events-none')).not.toBeNull()
})

test('with no agent in control the overlay draws nothing', async () => {
  answer = { controls: [], pointers: [] }
  await overlay()
  expect(document.body.textContent).toBe('')
})
