import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAgentControl, BrowserHub, findChrome, type LiveEvent } from '../src/browser.ts'

const dirs: string[] = []
const hubs: BrowserHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test.skipIf(!findChrome())(
  'a person can watch an agent tab, take control, type, and hand it back',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myr-browser-'))
    dirs.push(dir)
    const hub = new BrowserHub(join(dir, 'profile'))
    hubs.push(hub)
    const tab = await hub.tab('c1', 'wren')
    await tab.page.setContent('<input id="q" autofocus><p>hello</p>')

    const events: LiveEvent[] = []
    const unwatch = await hub.watch('c1', 'wren', (e) => events.push(e))
    for (let i = 0; i < 40 && !events.some((e) => e.type === 'frame'); i++) await Bun.sleep(50)
    expect(events.some((e) => e.type === 'frame')).toBe(true)
    expect(await hub.tabs('c1')).toMatchObject([{ agent: 'wren', controlledBy: 'agent' }])

    await expect(hub.input('c1', 'wren', { type: 'text', text: 'x' })).rejects.toThrow('take control first')
    await hub.setControl('c1', 'wren', 'person')
    expect(() => assertAgentControl(tab)).toThrow('taken control')
    await tab.page.focus('#q')
    await hub.input('c1', 'wren', { type: 'text', text: 'typed by a person' })
    expect(await tab.page.$eval('#q', (el) => (el as HTMLInputElement).value)).toBe('typed by a person')

    await hub.setControl('c1', 'wren', 'agent')
    expect(() => assertAgentControl(tab)).not.toThrow()
    expect(events.filter((e) => e.type === 'control').map((e) => (e as { by: string }).by)).toEqual([
      'agent',
      'person',
      'agent',
    ])
    unwatch()
    await hub.closeColony('c1')
    expect(await hub.tabs('c1')).toEqual([])
  },
  60_000,
)
