import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { copy } from '../src/client/copy.ts'
import { MASCOT_CREW, MASCOT_TOUCH } from '../src/client/ui-config.ts'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A seeded random, so a run of the crew is the same every time. */
function seeded(seed = 7) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const world = (now: number, over = {}) => ({
  now,
  face: { hw: 225, hh: 160 },
  bounds: { left: -600, right: 600, top: -320, bottom: 420 },
  signal: 'roam' as const,
  typing: false,
  ...over,
})

test('the crew is named from the list, each with a colour of its own', async () => {
  const { pickCrew } = await import('../src/client/chat/hero-crew.ts')
  for (let seed = 1; seed < 40; seed++) {
    const crew = pickCrew(3, seeded(seed))
    expect(crew).toHaveLength(3)
    for (const c of crew) expect(copy.hero.crewNames).toContain(c.name)
    expect(new Set(crew.map((c) => c.name)).size).toBe(3)
    expect(new Set(crew.map((c) => c.color)).size).toBe(3)
  }
})

test('knocked down, the crew falls to the floor, lies dazed, then gets up and goes back', async () => {
  const { knockDown, makeMember, pickCrew, stepCrew } = await import('../src/client/chat/hero-crew.ts')
  const random = seeded(3)
  const crew = pickCrew(3, random).map((c, i) =>
    makeMember(c, { x: i % 2 ? 400 : -400, y: -60 + i * 40 }, random),
  )
  const homes = crew.map((m) => ({ ...m.target }))
  for (const m of crew) knockDown(m, 0, random)
  const seen = crew.map(() => new Set<string>())
  const floor = world(0).bounds.bottom
  let t = 0
  for (let i = 0; i < 60 * 12; i++) {
    t += 1000 / 60
    stepCrew(crew, world(t), 1 / 60, random)
    for (const [k, m] of crew.entries()) {
      seen[k]?.add(m.state)
      expect(m.body.y).toBeLessThanOrEqual(floor)
      if (m.state === 'dazed') expect(m.body.y).toBe(floor)
    }
  }
  for (const s of seen) for (const state of ['falling', 'dazed', 'rising', 'roam']) expect(s).toContain(state)
  // Back on its feet, near where it was before it fell (or roaming on from there), and up off the floor.
  for (const [k, m] of crew.entries()) {
    expect(m.state).not.toBe('falling')
    expect(m.body.y).toBeLessThan(floor - 100)
    expect(homes[k]).toBeDefined()
  }
})

test('the crew reacts to the eyes: scatters when startled, freezes when looked at, creeps up while it sleeps', async () => {
  const { makeMember, stepCrew, lookedAt } = await import('../src/client/chat/hero-crew.ts')
  const random = seeded(11)
  const m = makeMember({ name: 'Kevin', color: '#fff' }, { x: 320, y: 0 }, random)
  // Startled: it runs away from the mascot.
  const before = Math.hypot(m.body.x, m.body.y)
  for (let i = 0; i < 30; i++) stepCrew([m], world(i * 16, { signal: 'scatter' }), 1 / 60, random)
  expect(m.state).toBe('scatter')
  expect(Math.hypot(m.body.x, m.body.y)).toBeGreaterThan(before + 40)
  // Looked straight at (its eyes point right, it is on the right): it stops dead.
  expect(lookedAt(m, [2, 0])).toBe(true)
  expect(lookedAt(m, [-2, 0])).toBe(false)
  for (let i = 0; i < 60; i++) stepCrew([m], world(1000 + i * 16, { look: [2, 0] }), 1 / 60, random)
  expect(m.state).toBe('frozen')
  expect(Math.hypot(m.body.vx, m.body.vy)).toBeLessThan(5)
  // Asleep: it creeps up to the screen's edge, slowly.
  let fastest = 0
  for (let i = 0; i < 60 * 8; i++) {
    stepCrew([m], world(3000 + i * 16, { signal: 'sneak' }), 1 / 60, random)
    fastest = Math.max(fastest, Math.hypot(m.body.vx, m.body.vy))
  }
  expect(m.state).toBe('sneak')
  expect(fastest).toBeLessThanOrEqual(m.traits.maxSpeed * MASCOT_CREW.sneakSpeed + 1)
  expect(Math.abs(Math.abs(m.body.x) - 225)).toBeLessThan(MASCOT_CREW.tagRoom + 40)
})

/** Clicks the mascot's screen as a pointer does. */
function tap(button: Element) {
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))
  button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }))
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
}

async function hero(reduced: 'always' | 'never') {
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch
  const { Hero } = await import('../src/client/chat/Hero.tsx')
  return mount(
    // Skipping motion's own animations lets the status line change at once; the crew's physics is not one of them.
    <MotionConfig reducedMotion={reduced} skipAnimations>
      <Hero draft="" working={0} news="" recent={[]} onOpenChat={() => {}} onPick={() => {}}>
        <div />
      </Hero>
    </MotionConfig>,
  )
}

const states = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-crew]')].map((n) => n.getAttribute('data-crew-state'))

test('clicking the mascot again and again confuses it: spiral eyes, and its whole crew falls down', async () => {
  const view = await hero('never')
  try {
    const button = view.host.querySelector(`button[aria-label="${copy.hero.poke}"]`)
    if (!button) throw new Error('no mascot')
    const names = [...view.host.querySelectorAll('[data-crew]')].map((n) => n.getAttribute('data-crew'))
    expect(names).toHaveLength(MASCOT_CREW.count)
    for (const n of names) expect(copy.hero.crewNames).toContain(n as string)
    await act(async () => {
      for (let i = 0; i < MASCOT_TOUCH.confusedClicks; i++) tap(button)
    })
    expect(view.host.textContent).toContain(copy.mascot.confused)
    expect(view.host.querySelector('button svg')?.getAttribute('data-clip')).toBe('confused')
    // The next frames knock everyone down.
    const end = Date.now() + 2000
    while (!states(view.host).every((s) => s === 'falling') && Date.now() < end)
      await act(async () => Bun.sleep(20))
    expect(states(view.host).every((s) => s === 'falling')).toBe(true)
  } finally {
    await view.unmount()
  }
})

test('with reduced motion the mascot plays nothing and its crew stands still, even when confused', async () => {
  const view = await hero('always')
  try {
    const button = view.host.querySelector(`button[aria-label="${copy.hero.poke}"]`)
    if (!button) throw new Error('no mascot')
    // No boot sweep: the screen opens on its eyes.
    expect(view.host.querySelector('button svg')?.getAttribute('data-clip')).toBeNull()
    await act(async () => {
      for (let i = 0; i < MASCOT_TOUCH.confusedClicks; i++) tap(button)
    })
    await act(async () => Bun.sleep(200))
    // It says so, with still eyes: no swirl, and nobody falls.
    expect(view.host.textContent).toContain(copy.mascot.confused)
    expect(view.host.querySelector('button svg')?.getAttribute('data-clip')).toBeNull()
    expect(states(view.host).every((s) => s === 'roam')).toBe(true)
  } finally {
    await view.unmount()
  }
})
