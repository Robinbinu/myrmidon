import { expect, test } from 'bun:test'
import { KeepAwake } from '../src/keep-awake.ts'
import { PowerAssertion } from '../src/omp/natives.ts'

function fake() {
  const log: string[] = []
  return {
    log,
    start: () => {
      log.push('start')
      return { stop: () => log.push('stop') }
    },
  }
}

test('off, the default: rounds never take a power assertion', () => {
  const f = fake()
  const awake = new KeepAwake(() => false, f.start)
  awake.hold('a')
  awake.release('a')
  expect(f.log).toEqual([])
  expect(awake.holding).toBe(false)
})

test('on: held from the first round to the last, once, and released twice harmlessly', () => {
  const f = fake()
  const awake = new KeepAwake(() => true, f.start)
  awake.hold('a')
  awake.hold('b')
  expect(awake.holding).toBe(true)
  awake.release('a')
  expect(f.log).toEqual(['start'])
  awake.release('b')
  awake.release('b')
  expect(f.log).toEqual(['start', 'stop'])
  expect(awake.holding).toBe(false)
})

test('turning the setting on or off while a round runs takes effect at once', () => {
  const f = fake()
  let on = false
  const awake = new KeepAwake(() => on, f.start)
  awake.hold('a')
  on = true
  awake.sync()
  expect(f.log).toEqual(['start'])
  on = false
  awake.sync()
  expect(f.log).toEqual(['start', 'stop'])
  awake.release('a')
  expect(f.log).toEqual(['start', 'stop'])
})

test('a system without a power service runs the round anyway', () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    const awake = new KeepAwake(
      () => true,
      () => {
        throw new Error('no login1')
      },
    )
    awake.hold('a')
    expect(awake.holding).toBe(false)
    awake.release('a')
  } finally {
    console.warn = warn
  }
})

// Linux and Windows CI runners may have no power service to ask, which KeepAwake already copes with.
test.if(process.platform === 'darwin')("omp's power assertion starts and stops on macOS", () => {
  const held = PowerAssertion.start({ reason: 'Myrmidon test', idle: true })
  held.stop()
  held.stop()
})
