import { expect, test } from 'bun:test'
import type { ComputerRunOk } from '@oh-my-pi/pi-coding-agent/tools/computer/protocol'
import { DESKTOP_POINT_CALL, DesktopEngine, desktopPrefix, pointerFacade } from '../src/index.ts'

type Point = { x: number; y: number; action: string }

/** Handles shaped as omp's prelude makes them: fields enumerable, methods non-writable, the whole thing frozen. */
function handle(fields: Record<string, unknown>, methods: Record<string, (...args: never[]) => unknown>) {
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(o, k, { value: v, enumerable: true })
  for (const [k, v] of Object.entries(methods)) Object.defineProperty(o, k, { value: v })
  return Object.freeze(o)
}

function fakeDesktop() {
  const calls: string[] = []
  const input = (target: string) => ({
    click: async (x: number, y: number) => void calls.push(`${target} click ${x},${y}`),
    doubleClick: async (x: number, y: number) => void calls.push(`${target} doubleClick ${x},${y}`),
    move: async () => {},
    scroll: async () => {},
    drag: async () => {},
    type: async (text: string) => void calls.push(`${target} type ${text}`),
    press: async () => {},
  })
  const element = handle(
    { ref: 'e5', role: 'AXButton' },
    {
      bounds: async () => ({ x: 400, y: 300, width: 100, height: 40 }),
      click: async () => void calls.push('e5 click'),
      press: async () => {},
      perform: async () => {},
      setValue: async () => {},
      focus: async () => {},
      parent: async () => null,
      children: async () => [],
    },
  )
  // A 1600 × 1000-point window at (100, 50), screenshotted at 800 × 500 pixels.
  const window = handle(
    { id: '74', app: 'Notes', title: 'Groceries', bounds: { x: 100, y: 50, width: 1600, height: 1000 } },
    {
      ...input('74'),
      screenshot: async () => ({ path: '/tmp/w.png', width: 800, height: 500 }),
      find: async () => [element],
      ref: async () => element,
      ax: async () => '',
      raise: async () => {},
    },
  )
  // Two displays: a 1440 × 900 main one at 2×, and a 1920 × 1080 one to its right at 1×; the composite screenshot
  // is 4800 × 1800 pixels, emitted at half size.
  const desktop = handle(
    {},
    {
      ...input('desktop'),
      screenshot: async () => ({ path: '/tmp/d.png', width: 2400, height: 900 }),
      displays: async () => [
        { x: 0, y: 0, width: 1440, height: 900, pixelX: 0, pixelY: 0, pixelWidth: 2880, pixelHeight: 1800 },
        {
          x: 1440,
          y: 0,
          width: 1920,
          height: 1080,
          pixelX: 2880,
          pixelY: 0,
          pixelWidth: 1920,
          pixelHeight: 1080,
        },
      ],
      windows: async () => [],
      window: async () => window,
      focusedWindow: async () => window,
      elementAt: async () => element,
      focusedElement: async () => null,
      ref: async () => element,
    },
  )
  return { desktop, calls }
}

test("a window click is placed on the screen from that window's last screenshot, and still reaches omp", async () => {
  const { desktop, calls } = fakeDesktop()
  const points: Point[] = []
  const d = pointerFacade(desktop, (p) => points.push(p))
  const w = await d.window({ app: 'Notes' })
  // Before a screenshot the window's typing shows at its middle.
  await w.type('milk')
  await w.screenshot()
  await w.click(400, 250)
  await w.type('eggs')
  expect(calls).toEqual(['74 type milk', '74 click 400,250', '74 type eggs'])
  expect(points).toEqual([
    { x: 900, y: 550, action: 'type' },
    { x: 900, y: 550, action: 'click' },
    { x: 900, y: 550, action: 'type' },
  ])
  // A window the script returns still reads as one.
  expect(JSON.parse(JSON.stringify(w))).toMatchObject({ id: '74', app: 'Notes', title: 'Groceries' })
})

test('a desktop click maps from the composite screenshot to the display it fell on', async () => {
  const { desktop } = fakeDesktop()
  const points: Point[] = []
  const d = pointerFacade(desktop, (p) => points.push(p))
  await d.screenshot()
  // (1200, 300) in the half-size image is (2400, 600) composite pixels: the 2× main display, at (1200, 300) points.
  await d.click(1200, 300)
  // (2000, 100) is (4000, 200) composite pixels: 1120 into the right display, at (2560, 200) points.
  await d.doubleClick(2000, 100)
  expect(points).toEqual([
    { x: 1200, y: 300, action: 'click' },
    { x: 2560, y: 200, action: 'click' },
  ])
})

test('an element is pointed at its middle, and a failing report never fails the script', async () => {
  const { desktop, calls } = fakeDesktop()
  const points: Point[] = []
  const d = pointerFacade(desktop, (p) => points.push(p))
  const [button] = await (await d.window({ app: 'Notes' })).find({ role: 'button' })
  await button.click()
  expect(calls).toEqual(['e5 click'])
  expect(points).toEqual([{ x: 450, y: 320, action: 'click' }])
  const broken = pointerFacade(desktop, () => {
    throw new Error('bridge gone')
  })
  await expect(broken.click(1, 1)).resolves.toBeUndefined()
})

test("the prefix wraps the run's desktop and reports through the bridge, before the script runs", async () => {
  const { desktop, calls } = fakeDesktop()
  const sent: [string, unknown][] = []
  const g = globalThis as Record<string, unknown>
  g.desktop = desktop
  g.__omp_call_tool__ = async (name: string, args: unknown) => void sent.push([name, args])
  try {
    const run = new Function(
      `return (async () => { ${desktopPrefix()} await desktop.click(10, 20); return 'done' })()`,
    )
    expect(await run()).toBe('done')
    expect(calls).toEqual(['desktop click 10,20'])
    expect(sent).toEqual([[DESKTOP_POINT_CALL, { x: 10, y: 20, action: 'click' }]])
  } finally {
    delete g.desktop
    delete g.__omp_call_tool__
  }
})

test('the engine wraps scripts that act, not ones that only look, and passes their points to the hub', async () => {
  const ran: string[] = []
  let bridge: (name: string, args: unknown) => Promise<unknown> = async () => undefined
  const pointed: unknown[] = []
  const engine = new DesktopEngine({
    factory: (b) => {
      bridge = b
      return {
        async run(code: string): Promise<ComputerRunOk> {
          ran.push(code)
          return { displays: [], returnValue: undefined, screenshots: [] }
        },
        async capabilities() {
          return undefined
        },
        async close() {},
      } as never
    },
    point: (holder, x, y, action) => pointed.push({ ...holder, x, y, action }),
  })
  const holder = { colonyId: 'c1', agent: 'nova' }
  await engine.run(holder, 'await desktop.click(1, 2)', { timeoutMs: 1000, readOnly: false, cwd: '/tmp' })
  await engine.run(holder, 'return await desktop.windows()', { timeoutMs: 1000, readOnly: true, cwd: '/tmp' })
  expect(ran[0]?.startsWith('globalThis.desktop = (')).toBe(true)
  expect(ran[0]?.endsWith('await desktop.click(1, 2)')).toBe(true)
  expect(ran[1]).toBe('return await desktop.windows()')
  await bridge(DESKTOP_POINT_CALL, { x: 5, y: 6, action: 'scroll' })
  expect(pointed).toEqual([{ colonyId: 'c1', agent: 'nova', x: 5, y: 6, action: 'scroll' }])
})
