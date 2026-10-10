import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAgentControl, BrowserHub, findChrome, type LiveEvent } from '../src/browser.ts'
import { BROWSER_PASTE_MAX_CHARS } from '../src/config.ts'
import { detectSandbox } from '../src/sandbox.ts'

const dirs: string[] = []
const hubs: BrowserHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Waits for Chrome to report something: a loaded machine can take seconds, so the bound is the test's, not a guess. */
async function until(check: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await Bun.sleep(25)
}

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
    await until(() => events.some((e) => e.type === 'frame'))
    expect(events.some((e) => e.type === 'frame')).toBe(true)
    expect(await hub.tabs('c1')).toMatchObject([{ agent: 'wren', controlledBy: 'agent' }])

    await expect(hub.input('c1', 'wren', { type: 'text', text: 'x' })).rejects.toThrow('take control first')
    await hub.setControl('c1', 'wren', 'person')
    expect(() => assertAgentControl(tab)).toThrow('taken control')
    await tab.page.focus('#q')
    await hub.input('c1', 'wren', { type: 'text', text: 'typed by a person' })
    expect(await tab.page.$eval('#q', (el) => (el as HTMLInputElement).value)).toBe('typed by a person')

    // A paste goes in whole: a newline in it does not press Enter and submit the form.
    await tab.page.setContent(
      '<form onsubmit="document.title = \'sent\'; return false"><input id="t"><button>Go</button></form>',
    )
    await tab.page.focus('#t')
    await hub.input('c1', 'wren', { type: 'paste', text: 'line one\nline two' })
    expect(await tab.page.$eval('#t', (el) => (el as HTMLInputElement).value)).toContain('line two')
    expect(await tab.page.title()).toBe('')
    await expect(
      hub.input('c1', 'wren', { type: 'paste', text: 'x'.repeat(BROWSER_PASTE_MAX_CHARS + 1) }),
    ).rejects.toThrow('at most')

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

test.skipIf(!findChrome() || detectSandbox().kind !== 'sandbox-exec')(
  "a sandboxed command cannot reach Chrome's DevTools, which would hand it every tab and cookie",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myr-browser-devtools-'))
    dirs.push(dir)
    const hub = new BrowserHub(join(dir, 'profile'))
    hubs.push(hub)
    const port = new URL((await hub.browser()).wsEndpoint()).port
    // This process (outside the sandbox) does reach it, so the refusal below is the sandbox's.
    expect(
      ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser: string }).Browser,
    ).toBeTruthy()
    const work = join(dir, 'work')
    mkdirSync(work)
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const r = await detectSandbox().run({
        command: `curl -s -m 3 http://${host}:${port}/json/version`,
        cwd: work,
        writable: [work],
        timeoutMs: 10_000,
      })
      expect(r.stdout).not.toContain('Browser')
      expect(r.code).not.toBe(0)
    }
  },
  60_000,
)
