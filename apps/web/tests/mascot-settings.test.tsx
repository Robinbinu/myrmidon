import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { copy } from '../src/client/copy.ts'
import type { MascotPatch } from '../src/client/mascot.ts'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
const realRandom = Math.random
const realAudio = globalThis.AudioContext
afterEach(() => {
  globalThis.fetch = realFetch
  Math.random = realRandom
  globalThis.AudioContext = realAudio
  localStorage.clear()
})

/**
 * The new-chat mascot as set up: the settings are what this browser last saw (the cache useMascotLook opens with),
 * since the mocked gateway answers nothing it can read. `specialists` are the person's saved specialists.
 */
async function hero(mascot: MascotPatch, opts: { draft?: string; specialists?: string[] } = {}) {
  localStorage.setItem('myr-mascot', JSON.stringify(mascot))
  globalThis.fetch = (async (url: string) =>
    Response.json(
      String(url).includes('/api/specialists')
        ? { specialists: (opts.specialists ?? []).map((name, i) => ({ id: `s${i}`, name, off: [] })) }
        : {},
    )) as unknown as typeof fetch
  const { Hero } = await import('../src/client/chat/Hero.tsx')
  const ui = (draft: string) => (
    <MotionConfig reducedMotion="never" skipAnimations>
      <Hero draft={draft} working={0} news="" recent={[]} onOpenChat={() => {}} onPick={() => {}}>
        <div />
      </Hero>
    </MotionConfig>
  )
  const view = await mount(ui(opts.draft ?? ''))
  return { ...view, ui }
}

/** Every clip that plays on the screen over `ms`, looked at every 20ms. */
async function clipsOver(host: HTMLElement, ms: number): Promise<string[]> {
  const seen = new Set<string>()
  const end = Date.now() + ms
  while (Date.now() < end) {
    await act(async () => Bun.sleep(20))
    const c = host.querySelector('button svg')?.getAttribute('data-clip')
    if (c) seen.add(c)
  }
  return [...seen]
}

const crew = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-crew]')].map((n) => n.getAttribute('data-crew'))
const clip = (host: HTMLElement) => host.querySelector('button svg')?.getAttribute('data-clip') ?? null

test('crew cursors can be turned off', async () => {
  const view = await hero({ crew: { show: false } })
  expect(crew(view.host)).toEqual([])
  await view.unmount()
})

test('the crew comes in the number asked for, wearing the names given first and Minions after', async () => {
  const view = await hero({ crew: { count: 5, names: 'custom', custom: ['Ada', 'Grace'] } })
  const names = crew(view.host)
  expect(names).toHaveLength(5)
  expect(names).toContain('Ada')
  expect(names).toContain('Grace')
  for (const n of names.filter((n) => n !== 'Ada' && n !== 'Grace'))
    expect(copy.hero.crewNames).toContain(n as string)
  await view.unmount()
})

test("the crew can wear the person's specialists' names", async () => {
  const view = await hero(
    { crew: { count: 2, names: 'specialists' } },
    { specialists: ['Researcher', 'Reviewer'] },
  )
  // The specialists arrive after the first render; the crew is drawn again for them.
  const end = Date.now() + 1000
  while (!crew(view.host).includes('Researcher') && Date.now() < end) await act(async () => Bun.sleep(10))
  expect(crew(view.host).sort()).toEqual(['Researcher', 'Reviewer'])
  await view.unmount()
})

test('with the boot sweep off the screen opens on its eyes; on, it sweeps', async () => {
  const off = await hero({ shows: { boot: false } })
  expect(clip(off.host)).toBeNull()
  await off.unmount()
  const on = await hero({})
  expect(clip(on.host)).toBe('boot')
  await on.unmount()
})

test('liveliness off plays no tricks while left alone; often, one comes within a second', async () => {
  // Every roll comes up, so any trick allowed plays at the first chance. The crew stays away: with every roll coming
  // up they would poke it all the time, and a mascot reacting to a poke plays no trick.
  Math.random = () => 0
  const quiet = await hero({ idle: 'off', shows: { boot: false }, crew: { show: false } })
  expect(await clipsOver(quiet.host, 1500)).toEqual([])
  await quiet.unmount()
  const lively = await hero({ idle: 'often', shows: { boot: false, pacman: false }, crew: { show: false } })
  const played = await clipsOver(lively.host, 1500)
  expect(played.length).toBeGreaterThan(0)
  expect(played).not.toContain('pacman')
  await lively.unmount()
})

test('a calm mascot keeps to quiet eye tricks: no Pac-Man even when it would play', async () => {
  Math.random = () => 0
  const view = await hero({ idle: 'often', temper: 'calm', shows: { boot: false }, crew: { show: false } })
  const played = await clipsOver(view.host, 1500)
  const { MASCOT_IDLE } = await import('../src/client/ui-config.ts')
  expect(played.length).toBeGreaterThan(0)
  for (const c of played) expect(MASCOT_IDLE.calmClips as readonly string[]).toContain(c)
  await view.unmount()
})

test('the screen is drawn as set: round dots, a hidden grid, and eyes in the theme accent', async () => {
  const view = await hero({
    shows: { boot: false },
    display: { dots: 'round', grid: 'off', eyeColor: 'theme' },
  })
  const rects = [...view.host.querySelectorAll('button svg rect')]
  // Cells are 20px: round dots have a radius of half that.
  expect(rects[0]?.getAttribute('rx')).toBe('10')
  const fills = rects.map((r) => (r as SVGElement).style.fill)
  expect(fills).toContain('var(--accent)')
  expect(fills).toContain('transparent')
  expect(fills).not.toContain('var(--screen-cell)')
  await view.unmount()
})

/** A stand-in for Web Audio that counts what is made. */
function fakeAudio() {
  const made = { contexts: 0, notes: 0 }
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
  class Fake {
    state = 'running'
    currentTime = 0
    destination = {}
    constructor() {
      made.contexts++
    }
    resume() {
      return Promise.resolve()
    }
    createOscillator() {
      made.notes++
      return { type: 'sine', frequency: param, connect: (n: unknown) => n, start() {}, stop() {} }
    }
    createGain() {
      return { gain: param, connect: (n: unknown) => n }
    }
  }
  globalThis.AudioContext = Fake as unknown as typeof AudioContext
  return made
}

async function poke(view: Awaited<ReturnType<typeof hero>>) {
  const button = view.host.querySelector<HTMLButtonElement>(`button[aria-label="${copy.hero.poke}"]`)
  await act(async () => {
    // From the keyboard, a press is a poke: it reacts.
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
  })
}

test('sounds are off by default, and then Web Audio is never touched', async () => {
  const made = fakeAudio()
  const view = await hero({ shows: { boot: false } })
  await poke(view)
  expect(made.contexts).toBe(0)
  expect(made.notes).toBe(0)
  await view.unmount()
})

test('with sounds on, a reaction blips', async () => {
  const made = fakeAudio()
  const view = await hero({ shows: { boot: false }, sounds: { enabled: true } })
  await poke(view)
  expect(made.contexts).toBe(1)
  expect(made.notes).toBeGreaterThan(0)
  await view.unmount()
})

test('missing mascot settings fill in from the defaults at every depth, and a patch changes only what it names', async () => {
  const { DEFAULT_MASCOT, withMascotDefaults } = await import('../src/client/mascot.ts')
  // What an older gateway sends.
  const old = withMascotDefaults({ eyes: 'tall', look: 'bow', color: 'mint', screen: 'clock' })
  expect(old).toEqual({ ...DEFAULT_MASCOT, eyes: 'tall', look: 'bow', color: 'mint', screen: 'clock' })
  const next = withMascotDefaults(old, { crew: { count: 5 } })
  expect(next.crew).toEqual({ ...DEFAULT_MASCOT.crew, count: 5 })
  expect(next.eyes).toBe('tall')
})

test('the mascot settings page sends just the change asked for', async () => {
  globalThis.fetch = (async () => Response.json({ specialists: [] })) as unknown as typeof fetch
  const { MascotBehaviour } = await import('../src/client/mascot-settings.tsx')
  const { DEFAULT_MASCOT } = await import('../src/client/mascot.ts')
  const patches: MascotPatch[] = []
  const view = await mount(<MascotBehaviour look={DEFAULT_MASCOT} set={(p) => patches.push(p)} />)
  const t = copy.settings.mascot
  const control = (label: string) => view.host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  await act(async () => control(t.crewShow)?.click())
  await act(async () => control(t.showNames.life)?.click())
  await act(async () => control(t.soundsOn)?.click())
  const segment = (label: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
      (b) => b.textContent === label,
    )
  await act(async () => segment(t.idleLevels.off)?.click())
  await act(async () => segment(t.dotShapes.square)?.click())
  expect(patches).toEqual([
    { crew: { show: false } },
    { shows: { life: false } },
    { sounds: { enabled: true } },
    { idle: 'off' },
    { display: { dots: 'square' } },
  ])
  // Sounds stay off until asked: the volume and its test sit behind the switch.
  expect(view.host.textContent).not.toContain(t.testSound)
  await view.unmount()
})
