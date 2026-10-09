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

test('scattering never carries a cursor out of its bounds', async () => {
  const { makeMember, pickCrew, stepCrew } = await import('../src/client/chat/hero-crew.ts')
  const random = seeded(5)
  // Starting close to every edge, so fleeing the mascot pushes each hard against one.
  const starts = [
    { x: -560, y: -280 },
    { x: 560, y: 380 },
    { x: 0, y: 400 },
  ]
  const crew = pickCrew(3, random).map((c, i) => makeMember(c, starts[i] ?? { x: 0, y: 0 }, random))
  const { bounds } = world(0)
  for (let i = 0; i < 60 * 3; i++) {
    stepCrew(crew, world(i * 16, { signal: 'scatter' }), 1 / 60, random)
    for (const m of crew) {
      expect(m.body.x).toBeGreaterThanOrEqual(bounds.left)
      expect(m.body.x).toBeLessThanOrEqual(bounds.right)
      expect(m.body.y).toBeGreaterThanOrEqual(bounds.top)
      expect(m.body.y).toBeLessThanOrEqual(bounds.bottom)
    }
  }
})

test('left alone, the crew finishes what it is doing and stands still', async () => {
  const { knockDown, makeMember, pickCrew, settled, stepCrew } = await import(
    '../src/client/chat/hero-crew.ts'
  )
  const random = seeded(9)
  const crew = pickCrew(3, random).map((c, i) => makeMember(c, { x: i % 2 ? 400 : -400, y: i * 60 }, random))
  // Busy: roaming about, and one knocked down mid-way.
  let t = 0
  for (let i = 0; i < 120; i++) {
    t += 16
    stepCrew(crew, world(t), 1 / 60, random)
  }
  knockDown(crew[0] as (typeof crew)[number], t, random)
  expect(settled(crew)).toBe(false)
  // While someone is about, it never settles; quiet, it does within a few seconds, and makes no more pokes.
  let still = -1
  for (let i = 0; i < 60 * 10 && still < 0; i++) {
    t += 16
    const events = stepCrew(crew, world(t, { quiet: true }), 1 / 60, random)
    expect(events.some((e) => e.type === 'poke')).toBe(false)
    if (settled(crew)) still = i
  }
  expect(still).toBeGreaterThan(0)
  expect(crew.every((m) => m.state === 'roam')).toBe(true)
})

test("the crew is the install's own: the same names every time, picked again only if the list lost one", async () => {
  const { keptCrew } = await import('../src/client/chat/hero-crew.ts')
  const kept = new Map<string, string>()
  const storage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
  }
  const first = keptCrew(3, storage, seeded(1))
  for (let seed = 2; seed < 10; seed++) expect(keptCrew(3, storage, seeded(seed))).toEqual(first)
  // A name no longer on the list: a new crew, kept from then on.
  const names = copy.hero.crewNames.filter((n) => n !== first[0]?.name)
  const again = keptCrew(3, storage, seeded(4), names)
  expect(again.map((c) => c.name)).not.toContain(first[0]?.name)
  expect(keptCrew(3, storage, seeded(5), names)).toEqual(again)
  // Storage that throws still gives a crew.
  const broken = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
  expect(keptCrew(3, broken, seeded(6))).toHaveLength(3)
})

test('the crew holds still while the window is in the background, and moves again once it is back', async () => {
  const view = await hero('never')
  const spots = () =>
    [...view.host.querySelectorAll('[data-crew] > div')].map((n) => (n as HTMLElement).style.transform)
  try {
    await act(async () => Bun.sleep(300))
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    // Springs settle on where the physics left them, then nothing moves.
    await act(async () => Bun.sleep(1200))
    const held = spots()
    await act(async () => Bun.sleep(400))
    expect(spots()).toEqual(held)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    const end = Date.now() + 2000
    while (JSON.stringify(spots()) === JSON.stringify(held) && Date.now() < end)
      await act(async () => Bun.sleep(20))
    expect(spots()).not.toEqual(held)
  } finally {
    await view.unmount()
  }
})

test('a right-click does not make the next key press a tap, and a cancelled drag does not eat the next click', async () => {
  const { MascotScreen } = await import('../src/client/chat/MascotScreen.tsx')
  const taps: string[] = []
  const view = await mount(
    <MotionConfig reducedMotion="never" skipAnimations>
      <MascotScreen
        label="mascot"
        mood="idle"
        color="#ffffff"
        eyes="round"
        onClipEnd={() => {}}
        onTap={() => taps.push('tap')}
        onPress={() => taps.push('press')}
        onDoubleTap={() => {}}
        onHold={() => {}}
        onRelease={() => {}}
      />
    </MotionConfig>,
  )
  try {
    const button = view.host.querySelector('button') as HTMLButtonElement
    // A right-click, then Enter: the keyboard's click.
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerId: 1 }))
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, pointerId: 1 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    })
    expect(taps).toEqual(['press'])
    // A drag the browser takes over (pointercancel): no click follows it, and the next real one still counts.
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, clientX: 10, clientY: 10 }),
      )
      button.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 2, clientX: 80, clientY: 10 }),
      )
      button.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 2 }))
    })
    await act(async () => tap(button))
    expect(taps).toEqual(['press', 'tap'])
  } finally {
    await view.unmount()
  }
})

test('the mascot is on stage only while it can be seen: no sheet over it, its window in front', async () => {
  const { useOnStage } = await import('../src/client/chat/Hero.tsx')
  const { Sheet } = await import('../src/client/ui/Sheet.tsx')
  const { useRef } = await import('react')
  const seen: boolean[] = []
  function Probe(props: { sheet: boolean }) {
    const el = useRef<HTMLDivElement>(null)
    seen.push(useOnStage(el))
    return (
      <div ref={el}>
        {props.sheet && (
          <Sheet title="Over it" onClose={() => {}}>
            <p>…</p>
          </Sheet>
        )}
      </div>
    )
  }
  const { createRoot } = await import('react-dom/client')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const show = (sheet: boolean) => act(async () => root.render(<Probe sheet={sheet} />))
  try {
    await show(false)
    expect(seen.at(-1)).toBe(true)
    await show(true)
    expect(seen.at(-1)).toBe(false)
    await show(false)
    expect(seen.at(-1)).toBe(true)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(seen.at(-1)).toBe(false)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(seen.at(-1)).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
