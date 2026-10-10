import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectOwnerOnly } from '../../../tests/platform.ts'
import { BrowserHub, findChrome } from '../src/browser.ts'
import { BROWSER_PASTE_MAX_CHARS } from '../src/config.ts'
import {
  allowedSite,
  browserAddress,
  PersonBrowser,
  PersonBrowserError,
  type PersonEvent,
  personInput,
} from '../src/person-browser.ts'

const dirs: string[] = []
const hubs: BrowserHub[] = []
const sites: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  for (const s of sites.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A local site to browse, so no test reaches the internet. */
function site() {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const url = new URL(req.url)
      // `?set=name=value` sets a cookie the way a site does, so tests need not write document.cookie.
      const set = url.searchParams.get('set')
      return new Response(
        `<title>page ${url.pathname}</title><input id="q" autofocus><a id="next" href="/next">next</a>`,
        {
          headers: {
            'content-type': 'text/html',
            ...(set ? { 'set-cookie': `${set}; Max-Age=3600; Path=/` } : {}),
          },
        },
      )
    },
  })
  sites.push(server)
  return { port: server.port ?? 0, url: `http://127.0.0.1:${server.port}` }
}

function setup(ownPorts: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'myr-person-browser-'))
  dirs.push(dir)
  const hub = new BrowserHub(join(dir, 'profile'), undefined, { localPorts: () => new Set(ownPorts) })
  hubs.push(hub)
  const person = new PersonBrowser(() => hub.browser(), {
    dir: join(dir, 'person'),
    ownPorts: () => ownPorts,
  })
  return { dir, hub, person }
}

/** Waits for Chrome to report something: a loaded machine can take seconds, so the bound is the test's, not a guess. */
async function until(check: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await Bun.sleep(25)
}

const code = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  return err instanceof PersonBrowserError ? err.code : err
}

test('the address bar takes URLs and bare hosts, and refuses what is not a web page', () => {
  expect(browserAddress('localhost:4370/?setup=welcome')).toBe('http://localhost:4370/?setup=welcome')
  expect(browserAddress('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
  expect(browserAddress('example.com/docs')).toBe('https://example.com/docs')
  expect(browserAddress('  https://example.com  ')).toBe('https://example.com/')
  expect(browserAddress('')).toBe('about:blank')
  expect(browserAddress('data:text/html,<p>hi')).toBe('data:text/html,<p>hi')
  for (const bad of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'chrome://settings',
    'view-source:https://example.com',
    'about:config',
    'devtools://devtools',
  ])
    expect(() => browserAddress(bad)).toThrow(PersonBrowserError)
  expect(() => browserAddress('two words')).toThrow(PersonBrowserError)
})

test('an allowed site is a port on this computer, however it is written', () => {
  expect(allowedSite('localhost:3000')).toBe('localhost:3000')
  expect(allowedSite('http://127.0.0.1:5173/app')).toBe('localhost:5173')
  expect(allowedSite('[::1]:8080')).toBe('localhost:8080')
  expect(allowedSite('3000')).toBe('localhost:3000')
  expect(allowedSite('example.com')).toBeUndefined()
  expect(allowedSite('localhost')).toBeUndefined()
  expect(allowedSite('localhost:99999')).toBeUndefined()
})

test.skipIf(!findChrome())(
  "the person's tabs live in their own context: agents never see its cookies, and it never sees theirs",
  async () => {
    const page = site()
    const { hub, person } = setup([page.port])
    const agent = await hub.tab('c1', 'wren')
    await agent.page.goto(`${page.url}/?set=who=agent`)

    const tab = await person.open(`${page.url}/`)
    expect(person.tabs()).toMatchObject([{ id: tab.id, title: 'page /' }])
    const entry = person.page(tab.id)
    expect(await entry?.evaluate(() => document.cookie)).toBe('')
    await entry?.goto(`${page.url}/?set=who=person`)
    expect(await agent.page.evaluate(() => document.cookie)).toBe('who=agent')
    // The agents' live view lists their tabs only.
    expect((await hub.tabs('c1')).map((t) => t.agent)).toEqual(['wren'])
  },
  60_000,
)

test.skipIf(!findChrome())(
  'tabs open, navigate, go back and forward, and close; other local ports wait until they are allowed',
  async () => {
    const page = site()
    const other = site()
    const { person } = setup([page.port])
    const a = await person.open()
    const b = await person.open(`${page.url}/`)
    expect(person.tabs().map((t) => t.id)).toEqual([a.id, b.id])
    await person.go(b.id, { url: `${page.url}/next` })
    let info = person.tabs().find((t) => t.id === b.id)
    expect(info).toMatchObject({ title: 'page /next', canGoBack: true, canGoForward: false })
    await person.go(b.id, { action: 'back' })
    info = person.tabs().find((t) => t.id === b.id)
    expect(info).toMatchObject({ title: 'page /', canGoForward: true })
    await person.go(b.id, { action: 'forward' })
    expect(person.tabs().find((t) => t.id === b.id)?.url).toBe(`${page.url}/next`)

    expect(await code(person.go(b.id, { url: 'file:///etc/passwd' }))).toBe('scheme')
    expect(await code(person.go(b.id, { url: `localhost:${other.port}` }))).toBe('blocked')
    person.updateSettings({ allowedSites: [`localhost:${other.port}`] })
    await person.go(b.id, { url: `localhost:${other.port}/` })
    expect(person.tabs().find((t) => t.id === b.id)?.title).toBe('page /')

    await person.close(a.id)
    expect(person.tabs().map((t) => t.id)).toEqual([b.id])
    expect(await code(person.close(a.id))).toBe('missing')
  },
  60_000,
)

test.skipIf(!findChrome())(
  'a watched tab streams frames and tab changes, takes input, sizes to the panel, and saves a screenshot',
  async () => {
    const page = site()
    const { person } = setup([page.port])
    const tab = await person.open(`${page.url}/`)
    const events: PersonEvent[] = []
    const unwatch = await person.watch(tab.id, (e) => events.push(e))
    await person.input(tab.id, { type: 'resize', width: 600, height: 400, scale: 1 })
    await until(() => events.some((e) => e.type === 'frame' && e.width === 600))
    expect(events.find((e) => e.type === 'frame' && e.width === 600)).toMatchObject({ height: 400 })
    expect(events.some((e) => e.type === 'tabs')).toBe(true)

    await person.page(tab.id)?.focus('#q')
    await person.input(tab.id, { type: 'text', text: 'typed by a person' })
    expect(await person.page(tab.id)?.$eval('#q', (el) => (el as HTMLInputElement).value)).toBe(
      'typed by a person',
    )
    const png = await person.screenshot(tab.id)
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])

    // An HTML file from the person's computer opens as a page of its own, named after the file.
    const file = await person.open({ html: '<p>report</p>', name: 'report.html' })
    expect(person.tabs().find((t) => t.id === file.id)).toMatchObject({ file: 'report.html' })

    // The keyboard with its modifiers: select all, a selection by Shift+arrow, copy out, an emoji in.
    await person.page(tab.id)?.focus('#q')
    await person.input(tab.id, { type: 'key', key: 'a', modifiers: ['Meta'] })
    expect(await person.input(tab.id, { type: 'copy' })).toEqual({
      type: 'copied',
      text: 'typed by a person',
    })
    await person.input(tab.id, { type: 'key', key: 'End' })
    await person.input(tab.id, { type: 'key', key: 'ArrowLeft', modifiers: ['Shift'] })
    expect(await person.input(tab.id, { type: 'copy', cut: true })).toEqual({ type: 'copied', text: 'n' })
    await person.input(tab.id, { type: 'text', text: '😀' })
    expect(await person.page(tab.id)?.$eval('#q', (el) => (el as HTMLInputElement).value)).toBe(
      'typed by a perso😀',
    )
    unwatch()
  },
  60_000,
)

test.skipIf(!findChrome())(
  'cookies kept always survive a restart; never forgets them with the last tab; clearing wipes cookies and storage',
  async () => {
    const page = site()
    const first = setup([page.port])
    first.person.updateSettings({ cookies: 'always' })
    const tab = await first.person.open(`${page.url}/?set=kept=1`)
    await first.person.close(tab.id)
    const saved = join(first.dir, 'person', 'cookies.json')
    expect(readFileSync(saved, 'utf8')).toContain('kept')
    expectOwnerOnly(saved)

    // A new Chrome with the same folder (as after quitting) brings them back.
    const hub = new BrowserHub(join(first.dir, 'profile2'), undefined, {
      localPorts: () => new Set([page.port]),
    })
    hubs.push(hub)
    const again = new PersonBrowser(() => hub.browser(), {
      dir: join(first.dir, 'person'),
      ownPorts: () => [page.port],
    })
    const back = await again.open(`${page.url}/`)
    expect(await again.page(back.id)?.evaluate(() => document.cookie)).toBe('kept=1')

    again.updateSettings({ cookies: 'never' })
    expect(existsSync(saved)).toBe(false)
    await again.close(back.id)
    const fresh = await again.open(`${page.url}/`)
    expect(await again.page(fresh.id)?.evaluate(() => document.cookie)).toBe('')

    await again.go(fresh.id, { url: `${page.url}/?set=temp=1` })
    await again.page(fresh.id)?.evaluate(() => localStorage.setItem('k', 'v'))
    await again.clear()
    // The tab opens again where it was, in a fresh context: under a new id, with nothing kept.
    const [cleared] = again.tabs()
    expect(cleared?.id).not.toBe(fresh.id)
    expect(cleared?.url).toBe(`${page.url}/?set=temp=1`)
    const reopened = again.page(cleared?.id ?? '')
    // The page set its cookie again on loading; the storage it wrote before is gone.
    expect(await reopened?.evaluate(() => localStorage.getItem('k'))).toBeNull()

    // A cookie a page's script sets (a sign-in by fetch) is saved too, at the latest when Myrmidon stops.
    again.updateSettings({ cookies: 'always' })
    await reopened?.evaluate((u) => fetch(u).then(() => {}), `${page.url}/api?set=spa=1`)
    await again.shutdown()
    expect(readFileSync(saved, 'utf8')).toContain('spa')
    expect(again.tabs()).toEqual([])
  },
  60_000,
)

test('socket input is checked field by field before it reaches the page', () => {
  expect(personInput({ type: 'mouse', action: 'down', x: 3, y: 4, button: 'middle' })).toEqual({
    type: 'mouse',
    action: 'down',
    x: 3,
    y: 4,
    button: 'middle',
  })
  expect(personInput({ type: 'key', key: 'Tab', modifiers: ['Shift'] })).toEqual({
    type: 'key',
    key: 'Tab',
    modifiers: ['Shift'],
  })
  expect(personInput({ type: 'key', key: '😀' })).toEqual({ type: 'key', key: '😀' })
  for (const bad of [
    { type: 'mouse', action: 'down', x: Number.NaN, y: 0 },
    { type: 'mouse', action: 'down', x: 1e9, y: 0 },
    { type: 'mouse', action: 'drag', x: 0, y: 0 },
    { type: 'key', key: 'F13' },
    { type: 'key', key: 'ab' },
    { type: 'key', key: 'a', modifiers: ['Hyper'] },
    { type: 'text', text: 'x'.repeat(BROWSER_PASTE_MAX_CHARS + 1) },
    { type: 'navigate', url: 'file:///etc/passwd' },
    'mouse',
    null,
  ])
    expect(personInput(bad)).toBeUndefined()
})

test.skipIf(!findChrome())(
  'a page that opens a local address itself is refused and named, with no way to allow it from the page',
  async () => {
    const page = site()
    const other = site()
    const { person } = setup([page.port])
    const tab = await person.open(`${page.url}/`)
    const events: PersonEvent[] = []
    const unwatch = await person.watch(tab.id, (e) => events.push(e))
    const refused = () => events.filter((e) => e.type === 'refused')
    await person.page(tab.id)?.evaluate((u) => {
      location.href = u
    }, `http://127.0.0.1:${other.port}/`)
    await until(() => refused().length > 0)
    expect(refused()).toEqual([
      { type: 'refused', site: `localhost:${other.port}`, from: `127.0.0.1:${page.port}`, local: true },
    ])
    // A fetch to another port is refused quietly: only the tab's own navigations are reported.
    await person.go(tab.id, { url: `${page.url}/` })
    await person.page(tab.id)?.evaluate((u) => fetch(u).catch(() => {}), `http://127.0.0.1:${other.port}/`)
    await Bun.sleep(300)
    expect(refused()).toHaveLength(1)
    // The local network is never opened, and is not offered as a site to allow.
    expect(await code(person.go(tab.id, { url: 'http://192.168.1.1/' }))).toBe('private')
    unwatch()
  },
  60_000,
)
