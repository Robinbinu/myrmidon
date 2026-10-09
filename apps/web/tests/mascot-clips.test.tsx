import { expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { type Clip, chain, IDLE_CLIPS, spiralEyes } from '../src/client/ui/clips.ts'
import { type Cell, eyeCells, PixelFace } from '../src/client/ui/pixel.tsx'
import { boot, confetti, equaliser, life, lifeStep, pacman } from '../src/client/ui/shows.ts'
import { MASCOT_GRID } from '../src/client/ui-config.ts'
import { mount, withDom } from './dom.ts'

withDom()

const { cols, rows } = MASCOT_GRID
const draw = (cells: readonly Cell[]) =>
  Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => (cells.some(([cx, cy]) => cx === x && cy === y) ? '#' : '.')).join(
      '',
    ),
  )
const eyes = (tweak = {}) => eyeCells('idle', cols, rows, 0, false, [0, 0], 'round', tweak)
const take = (c: Clip, n = 2000) => {
  const out = []
  for (const frame of c.frames) {
    out.push(frame)
    if (out.length >= n) break
  }
  return out
}

test('a face with no tweak draws its eyes as it always has', () => {
  expect(draw(eyes())).toEqual([
    '...............',
    '...............',
    '...##.....##...',
    '..####...####..',
    '..####...####..',
    '...##.....##...',
    '...............',
    '...............',
  ])
})

test('tweaks change the eyes: lids, a shift past the edge, crossed looks, shapes and a scanline', () => {
  // Lids all the way down leave a line, half way the lower half.
  expect(draw(eyes({ lids: 1 })).filter((r) => r.includes('#'))).toEqual(['..####...####..'])
  expect(draw(eyes({ lids: 0.5 })).slice(2, 6)).toEqual([
    '...............',
    '...............',
    '..####...####..',
    '...##.....##...',
  ])
  // Shifted right, the right eye leaves the screen; its cells are simply not drawn.
  expect(eyes({ shift: [6, 0] }).filter(([x]) => x < cols).length).toBeLessThan(eyes().length)
  // Crossed: each eye moves toward the other.
  const crossed = draw(
    eyes({
      looks: [
        [1, 0],
        [-1, 0],
      ],
    }),
  )
  expect(crossed[3]).toBe('...####.####...')
  // A wink is one open eye and one shut.
  expect(draw(eyes({ shape: ['open', 'closed'] }))[3]).toBe('..####.........')
  // The spiral turns: successive quarter turns differ, and four of them come back round.
  const spin = (turn: number) => draw(eyes({ shape: 'spiral', turn })).join('/')
  expect(spin(1)).not.toBe(spin(0))
  expect(spin(4)).toBe(spin(0))
  // Only rows above the scanline are drawn.
  expect(eyes({ reveal: 4 }).every(([, y]) => y < 4)).toBe(true)
})

test('the idle library has every trick, each a short clip of real frames', () => {
  const names = IDLE_CLIPS.map((c) => c.name)
  for (const name of [
    'eye roll',
    'squint',
    'look around',
    'yawn',
    'sneeze',
    'double blink',
    'side-eye',
    'peek',
    'bored',
    'cross-eyed',
  ])
    expect(names).toContain(name)
  for (const c of IDLE_CLIPS) {
    const frames = take(c)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((f) => f.ms > 0)).toBe(true)
    const total = frames.reduce((n, f) => n + f.ms, 0)
    expect(total).toBeLessThan(10_000)
  }
})

test('shows end, or loop for as long as they are left on', () => {
  expect(take(boot()).length).toBe(rows + 3)
  expect(take(pacman()).length).toBe(cols + 6)
  // Confetti falls out of the screen by the end.
  const last = take(confetti(() => 0.5)).at(-1)
  expect(last?.dots?.every(([, y]) => y >= rows)).toBe(true)
  expect(take(equaliser(() => 1)).length).toBe(2000)
  expect(take(chain('two', spiralEyes(220), spiralEyes(220))).length).toBe(4)
})

test("the Game of Life follows Conway's rules and starts over when it dies", () => {
  // A blinker flips between a row and a column.
  const row = new Set(['6,3', '7,3', '8,3'])
  const col = lifeStep(row)
  expect([...col].sort()).toEqual(['7,2', '7,3', '7,4'])
  expect([...lifeStep(col)].sort()).toEqual([...row].sort())
  // A lone cell dies; the screensaver sows again from the eyes rather than going dark.
  const frames = take(
    life([[3, 3]], () => 0.1),
    6,
  )
  expect(frames.every((f) => (f.dots?.length ?? 0) > 0)).toBe(true)
  expect(frames.every((f) => f.eyes === null)).toBe(true)
})

const clip: Clip = {
  name: 'probe',
  frames: [
    { ms: 30, eyes: null, dots: [[0, 0]] },
    { ms: 30, eyes: null, dots: [[1, 0, '#123456']] },
  ],
}

/** Waits, letting timers and renders run, until `ok` holds (or fails the test after a while). */
async function until(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await act(async () => Bun.sleep(5))
  }
}

const fills = (host: HTMLElement) => [...host.querySelectorAll('rect')].map((r) => r.style.fill)

test('a face plays a clip frame by frame and says when it has ended', async () => {
  let ended = 0
  const view = await mount(
    <MotionConfig reducedMotion="never">
      <PixelFace mood="idle" color="#ffffff" cols={cols} rows={rows} clip={clip} onClipEnd={() => ended++} />
    </MotionConfig>,
  )
  try {
    expect(view.host.querySelector('svg')?.getAttribute('data-clip')).toBe('probe')
    expect(fills(view.host)[0]).toBe('#ffffff')
    await until(() => fills(view.host)[1] === '#123456')
    expect(fills(view.host)[0]).toBe('var(--screen-cell)')
    expect(ended).toBe(0)
    await until(() => ended > 0)
    expect(ended).toBe(1)
    expect(view.host.querySelector('svg')?.getAttribute('data-clip')).toBeNull()
  } finally {
    await view.unmount()
  }
})

test('with reduced motion a face plays no clip and keeps its eyes', async () => {
  let ended = 0
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <PixelFace mood="idle" color="#ffffff" cols={cols} rows={rows} clip={clip} onClipEnd={() => ended++} />
    </MotionConfig>,
  )
  try {
    await act(async () => Bun.sleep(80))
    expect(view.host.querySelector('svg')?.getAttribute('data-clip')).toBeNull()
    expect(ended).toBe(0)
    expect(fills(view.host).filter((f) => f === '#ffffff').length).toBe(eyes().length)
  } finally {
    await view.unmount()
  }
})
