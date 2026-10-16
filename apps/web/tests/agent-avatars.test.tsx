import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MotionConfig } from 'motion/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { copy } from '../src/client/copy.ts'
import { AvatarBag, AvatarScope, setAvatarBag } from '../src/client/ui/avatar-bag.ts'
import { AgentCharacter, motionFor } from '../src/client/ui/crew.tsx'
import { BODY_SHAPES, PERSONA_IDS, PERSONAS } from '../src/client/ui/personas.ts'
import { AgentAvatar, MascotFaceProvider } from '../src/client/ui/pixel.tsx'
import { AVATARS } from '../src/client/ui-config.ts'

afterEach(() => setAvatarBag(undefined))

const names = (n: number) => Array.from({ length: n }, (_, i) => `agent-${i}`)

describe('the cast', () => {
  test('has at least 40 personas, each with a shape and a way of moving of its own', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(PERSONA_IDS).size).toBe(PERSONAS.length)
    const looks = PERSONAS.map((p) =>
      JSON.stringify([p.body, p.idle, p.work, p.done, p.error, p.tempo, p.workLook, p.thinkLook]),
    )
    expect(new Set(looks).size).toBe(PERSONAS.length)
    // Every body shape is worn by somebody.
    for (const shape of BODY_SHAPES) expect(PERSONAS.some((p) => p.body === shape)).toBe(true)
  })

  test('each has a name, a temperament, a catchphrase, emotes and a line per state', () => {
    const all = copy.avatars.personas as Record<string, (typeof copy.avatars.personas)['pip']>
    expect(Object.keys(all).sort()).toEqual([...PERSONA_IDS].sort())
    for (const id of PERSONA_IDS) {
      const p = all[id]
      expect(p?.name.length).toBeGreaterThan(0)
      expect(p?.temperament.length).toBeGreaterThan(0)
      expect(p?.catchphrase.length).toBeGreaterThan(0)
      for (const e of Object.values(p?.emotes ?? {})) expect([...e].length).toBeLessThanOrEqual(3)
      for (const key of ['idle', 'working', 'thinking', 'done', 'error'] as const)
        expect(p?.lines[key].length).toBeGreaterThan(0)
    }
    expect(new Set(Object.values(all).map((p) => p.name)).size).toBe(PERSONA_IDS.length)
  })
})

describe('handing personas out', () => {
  test('nobody in a crew shares a persona', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const bag = new AvatarBag({ seed })
      const crew = names(12).map((n) => bag.assign('crew', n))
      expect(new Set(crew).size).toBe(12)
    }
  })

  test('a crew as big as the cast still wears every persona once', () => {
    const bag = new AvatarBag({ seed: 3 })
    bag.assign('warm-up', 'x')
    const crew = names(PERSONA_IDS.length).map((n) => bag.assign('big', n))
    expect(new Set(crew).size).toBe(PERSONA_IDS.length)
  })

  test('new crews avoid the personas the last crews wore', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const bag = new AvatarBag({ seed })
      const worn: string[] = []
      for (let round = 0; round < 40; round++) {
        const crew = names(4).map((n) => bag.assign(`round-${round}`, n))
        for (const id of crew) expect(worn.slice(-AVATARS.history)).not.toContain(id)
        worn.push(...crew)
      }
    }
  })

  test('an agent keeps its persona within its crew, across a reload of the bag too', () => {
    const bag = new AvatarBag({ seed: 9 })
    const first = names(5).map((n) => bag.assign('chat-1', n))
    for (const n of names(5)) bag.assign('chat-2', n)
    expect(names(5).map((n) => bag.assign('chat-1', n))).toEqual(first)
    const reloaded = new AvatarBag({ seed: 1234, state: JSON.parse(JSON.stringify(bag.snapshot())) })
    expect(names(5).map((n) => reloaded.peek('chat-1', n))).toEqual(first)
    expect(names(5).map((n) => reloaded.assign('chat-1', n))).toEqual(first)
  })

  test('the same seed hands out the same personas', () => {
    const run = (seed: number) => {
      const bag = new AvatarBag({ seed })
      return [0, 1, 2].flatMap((r) => names(3).map((n) => bag.assign(`r${r}`, n)))
    }
    expect(run(42)).toEqual(run(42))
    expect(run(42)).not.toEqual(run(43))
  })

  test('only the latest crews are remembered', () => {
    const bag = new AvatarBag({ seed: 5, keepScopes: 3 })
    for (const s of ['a', 'b', 'c', 'd']) bag.assign(s, 'nova')
    expect(bag.peek('a', 'nova')).toBeUndefined()
    expect(bag.peek('d', 'nova')).toBeDefined()
  })
})

const render = (ui: React.ReactNode, reduce: 'always' | 'never' = 'never') =>
  renderToStaticMarkup(<MotionConfig reducedMotion={reduce}>{ui}</MotionConfig>)
const personaOf = (html: string) => /data-persona="([^"]+)"/.exec(html)?.[1]

describe('the avatar', () => {
  test('wears its crew persona, the same whatever its state', () => {
    setAvatarBag(new AvatarBag({ seed: 11 }))
    const at = (status: string, scope = 'colony-a') =>
      personaOf(
        render(
          <AvatarScope value={scope}>
            <AgentAvatar name="nova" status={status} />
          </AvatarScope>,
        ),
      )
    const first = at('working')
    expect(first).toBeDefined()
    for (const s of ['idle', 'completed', 'failed', 'waiting', 'running']) expect(at(s)).toBe(first)
    // The same call sign in another crew draws again; in a crew of two it never matches its crewmate.
    const kai = personaOf(
      render(
        <AvatarScope value="colony-a">
          <AgentAvatar name="kai" status="idle" />
        </AvatarScope>,
      ),
    )
    expect(kai).not.toBe(first)
  })

  test('moves only when motion is allowed', () => {
    setAvatarBag(new AvatarBag({ seed: 2 }))
    for (const p of PERSONAS) {
      for (const status of ['working', 'completed', 'failed', 'provisioning']) {
        const still = render(<AgentCharacter name="nova" status={status} persona={p.id} />, 'always')
        expect(still).not.toContain('data-avatar-motion')
        expect(still).not.toContain('animation:')
      }
      const moving = render(<AgentCharacter name="nova" status="completed" persona={p.id} />)
      expect(moving).toContain(`data-avatar-motion="avatar-${p.done}"`)
    }
    // Every motion a persona names has keyframes.
    const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
    for (const p of PERSONAS)
      for (const mood of ['idle', 'working', 'thinking', 'happy', 'error', 'sleep'] as const) {
        const name = motionFor(p, mood)?.split(' ')[0]
        if (name) expect(css).toContain(`@keyframes ${name} {`)
      }
  })

  test('every persona draws in theme tokens only, so it works in light and dark', async () => {
    const tokens = await Bun.file(new URL('../src/client/tokens.css', import.meta.url)).text()
    expect(tokens).toContain('--character-ink:')
    for (const p of PERSONAS)
      for (const status of ['idle', 'working', 'provisioning', 'completed', 'failed', 'stopped', 'waiting']) {
        const html = render(<AgentCharacter name="nova" status={status} persona={p.id} awake />)
        // The only literal colour is the agent's own (nova's palette colour).
        const hexes = new Set(html.match(/#[0-9a-f]{6}\b/gi) ?? [])
        expect([...hexes].map((h) => h.toLowerCase())).toEqual(['#ff7eb6'])
        expect(html).not.toContain('NaN')
        expect(html).not.toContain('undefined')
      }
  })

  test("shows the persona's words in its tooltip", () => {
    const html = render(<AgentCharacter name="nova" status="working" persona="pip" />)
    const pip = copy.avatars.personas.pip
    expect(html).toContain(copy.avatars.tooltip('nova', pip.name, pip.temperament, pip.lines.working))
  })
})

describe("the lead's avatar", () => {
  test('is the mascot: its eye colour and style on a flat dark tile, with no glow', () => {
    const html = render(
      <MascotFaceProvider value={{ eyes: 'tall', color: '#ff8fc0', dots: 'round', grid: 'faint' }}>
        <AgentAvatar name="lead" status="idle" size={32} awake />
      </MascotFaceProvider>,
    )
    expect(html).toContain('data-lead-avatar="lead"')
    expect(html).toContain('bg-screen')
    expect(html).toContain('#ff8fc0')
    expect(html).not.toContain('drop-shadow')
    expect(html).not.toContain('Gradient')
    expect(html).not.toContain('data-persona')
    // The unlit grid runs past the tile's edges: cells sit outside it on every side.
    const xs = [...html.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)"/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ])
    expect(xs.some(([x]) => (x ?? 0) < 0)).toBe(true)
    expect(xs.some(([, y]) => (y ?? 0) < 0)).toBe(true)
    expect(xs.some(([, y]) => (y ?? 0) > 30)).toBe(true)
  })

  test("follows the person's eye style: tall eyes light other cells than round ones", () => {
    const cells = (eyes: 'round' | 'tall') =>
      render(
        <MascotFaceProvider value={{ eyes, color: '#ffb31a', dots: 'led', grid: 'off' }}>
          <AgentAvatar name="lead" status="idle" size={48} awake />
        </MascotFaceProvider>,
        'always',
      ).match(/fill:#ffb31a/g)?.length
    expect(cells('round')).toBeGreaterThan(0)
    expect(cells('tall')).not.toBe(cells('round'))
  })
})
