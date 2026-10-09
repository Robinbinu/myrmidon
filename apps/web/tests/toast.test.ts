import { expect, test } from 'bun:test'
import { settled, type Toast, withToast } from '../src/client/ui/Toast.tsx'
import { holdBack } from '../src/client/ui/undo.ts'

const toast = (id: number, text: string, kind: Toast['kind'] = 'info'): Toast => ({ id, kind, text })
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('a plain message already on screen is not stacked again, but work under way and timed toasts each stand alone', () => {
  const one = [toast(1, 'Renamed')]
  expect(withToast(one, toast(2, 'Renamed'), true)).toBe(one)
  // Two chats with the same title deleted in a row each keep their own Undo.
  expect(withToast(one, toast(2, 'Renamed'), false).map((t) => t.id)).toEqual([1, 2])
  // Only the latest four show.
  const many = [1, 2, 3, 4].map((id) => toast(id, `m${id}`))
  expect(withToast(many, toast(5, 'm5'), true).map((t) => t.id)).toEqual([2, 3, 4, 5])
})

test('a progress toast settles in place into how the work went, and comes back if it was dismissed meanwhile', () => {
  const list = [toast(1, 'Reading…', 'progress'), toast(2, 'Renamed')]
  expect(settled(list, 1, 'Proposed a skill', 'success')).toEqual([
    toast(1, 'Proposed a skill', 'success'),
    toast(2, 'Renamed'),
  ])
  expect(settled([toast(2, 'Renamed')], 1, 'Failed', 'error')).toEqual([
    toast(2, 'Renamed'),
    toast(1, 'Failed', 'error'),
  ])
})

test('an action held back runs only once its time is up, and undoing in time means it never runs', async () => {
  let runs = 0
  const undo = holdBack(() => runs++, 20)
  expect(runs).toBe(0)
  expect(undo()).toBe(true)
  await wait(40)
  expect(runs).toBe(0)

  const late = holdBack(() => runs++, 5)
  await wait(25)
  expect(runs).toBe(1)
  // Too late: it already ran, and undoing says so rather than pretending.
  expect(late()).toBe(false)
})
