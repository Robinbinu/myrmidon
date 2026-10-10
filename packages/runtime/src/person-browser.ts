import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, CDPSession, CookieData, HTTPRequest, Page } from 'puppeteer-core'
import { type BrowserProxy, pressInput, REFUSED_HEADER, startBrowserProxy } from './browser.ts'
import {
  BROWSER_PASTE_MAX_CHARS,
  PERSON_BROWSER_COOKIE_SAVE_MS,
  PERSON_BROWSER_COPY_MAX_CHARS,
  PERSON_BROWSER_FAVICON_MAX_BYTES,
  PERSON_BROWSER_HTML_MAX_BYTES,
  PERSON_BROWSER_MAX_SCALE,
  PERSON_BROWSER_MAX_TABS,
  PERSON_BROWSER_VIEWPORTS,
} from './config.ts'
import { atomicWrite } from './settings.ts'
import { quickRefusal, urlPort } from './web.ts'

/**
 * The person's own browser, with tabs, like Claude Code's browser pane: pages in the Chrome Myrmidon already runs for
 * agents, but in a browser context of its own (Target.createBrowserContext), so its cookies, storage and cache are
 * never visible to an agent's tab and an agent's never to it. Its connections go through a proxy of its own with the
 * agents' rule (the public internet, plus only the ports on this computer the person allows), so a page the person
 * opens cannot reach the other services on this computer either. Chrome's DevTools port, through which anything on
 * this computer could reach every context, is kept from sandboxed commands (see BrowserHub); full-access agents run
 * as the person and are not kept from it.
 */

/** How long cookies last: until Myrmidon quits (the context lives in memory), across restarts, or only while a tab is open. */
export type CookieMode = 'quit' | 'always' | 'never'
/** Responsive follows the panel; the others are fixed sizes (PERSON_BROWSER_VIEWPORTS). */
export type ViewportMode = 'responsive' | keyof typeof PERSON_BROWSER_VIEWPORTS

export interface PersonBrowserSettings {
  readonly cookies: CookieMode
  /** Ports on this computer the browser may open besides Myrmidon's own, as `localhost:3000`. */
  readonly allowedSites: readonly string[]
  readonly viewport: ViewportMode
}

const DEFAULTS: PersonBrowserSettings = { cookies: 'quit', allowedSites: [], viewport: 'responsive' }

export interface PersonTab {
  readonly id: string
  readonly url: string
  readonly title: string
  /** A data: URL of the site's icon, when it has a small one of its own. */
  readonly favicon?: string
  /** The name of the HTML file the tab shows, while it shows one opened from the person's computer. */
  readonly file?: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

/** What someone watching one of the person's tabs receives. Frame sizes are CSS pixels of the page's viewport. */
export type PersonEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'tabs'; tabs: PersonTab[] }
  /**
   * The page itself (a link, a script, a redirect) tried to open a local address in the tab. `site` is a port on this
   * computer as `localhost:3000` when `local`, else a host on the local network; `from` is the page's host. The
   * person may allow a port only from the address bar, never from what a page asked for.
   */
  | { type: 'refused'; site: string; from: string; local: boolean }
  /** What a copy (or cut) took out of the page, for the person's clipboard. */
  | { type: 'copied'; text: string }

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

/** Input to a watched tab, in the page's CSS pixels, and the size of the panel it shows in. */
export type PersonInput =
  | {
      type: 'mouse'
      action: 'move' | 'down' | 'up'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; modifiers?: Modifier[] }
  | { type: 'text'; text: string }
  /** Clipboard text, inserted at once like a paste: newlines do not press Enter. */
  | { type: 'paste'; text: string }
  /** Copies the page's selection out to the person; a cut also deletes it. */
  | { type: 'copy'; cut?: boolean }
  | { type: 'resize'; width: number; height: number; scale: number }

/** Keys sent by name; any other key is a single character (an emoji included). */
const KEY_NAMES = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])
const MODIFIERS = new Set<string>(['Alt', 'Control', 'Meta', 'Shift'])
/** ⌘ or Ctrl with these keys: Chrome edits on a command sent with the key, not on the key alone. */
const EDIT_COMMANDS: Record<string, string> = { a: 'selectAll', z: 'undo', y: 'redo' }
/** Coordinates and wheel deltas past this are no page's; they are refused rather than passed on. */
const MAX_COORDINATE = 20_000

/**
 * Input from the dashboard's socket, checked field by field: anything malformed, a key Chrome has no name for, or text
 * longer than a paste, is undefined and dropped.
 */
export function personInput(raw: unknown): PersonInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  const num = (v: unknown, max = MAX_COORDINATE): v is number =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= BROWSER_PASTE_MAX_CHARS
  switch (m.type) {
    case 'mouse': {
      const action = (['move', 'down', 'up'] as const).find((a) => a === m.action)
      const button = (['left', 'right', 'middle'] as const).find((b) => b === m.button)
      if (!action || !num(m.x) || !num(m.y) || (m.button !== undefined && !button)) return undefined
      return { type: 'mouse', action, x: m.x, y: m.y, ...(button ? { button } : {}) }
    }
    case 'wheel':
      return num(m.x) && num(m.y) && num(m.deltaX) && num(m.deltaY)
        ? { type: 'wheel', x: m.x, y: m.y, deltaX: m.deltaX, deltaY: m.deltaY }
        : undefined
    case 'key': {
      const key = m.key
      if (typeof key !== 'string' || !(KEY_NAMES.has(key) || [...key].length === 1)) return undefined
      const modifiers = m.modifiers ?? []
      if (!Array.isArray(modifiers) || !modifiers.every((x) => typeof x === 'string' && MODIFIERS.has(x)))
        return undefined
      return {
        type: 'key',
        key,
        ...(modifiers.length ? { modifiers: [...new Set(modifiers)] as Modifier[] } : {}),
      }
    }
    case 'text':
    case 'paste':
      return text(m.text) ? { type: m.type, text: m.text } : undefined
    case 'copy':
      return { type: 'copy', ...(m.cut === true ? { cut: true } : {}) }
    case 'resize':
      return num(m.width) && num(m.height) && num(m.scale, 16)
        ? { type: 'resize', width: m.width, height: m.height, scale: m.scale }
        : undefined
    default:
      return undefined
  }
}

/**
 * Why the person's browser did not do something: `scheme` an address that is not a web page (file:, javascript:,
 * chrome:), `address` text that is not an address, `blocked` a port on this computer that is not allowed (`site`
 * names it, and the person may allow it), `private` an address on the local network (never opened here), `full` the
 * tab limit, `missing` a tab that is gone, `size` an HTML file too large.
 */
export class PersonBrowserError extends Error {
  override readonly name = 'PersonBrowserError'
  constructor(
    readonly code: 'scheme' | 'address' | 'blocked' | 'private' | 'full' | 'missing' | 'size',
    message: string,
    readonly site?: string,
  ) {
    super(message)
  }
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/**
 * What the address bar opens for what was typed: http(s) URLs as they are, a bare host as a site (http for this
 * computer, https elsewhere), blank for nothing, and data: pages, whose origin is opaque. Everything else, file:,
 * javascript: and chrome: among them, is refused: those reach the files and internals of the computer Myrmidon runs on.
 */
export function browserAddress(typed: string): string {
  const text = typed.trim()
  if (!text || text === 'about:blank') return 'about:blank'
  if (/^data:/i.test(text)) return text
  if (/^https?:\/\//i.test(text)) return new URL(text).href
  // `localhost:4370` reads as a scheme too, so a host with a port is told apart by the digits after the colon.
  const host = /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?(?=[/?#]|$)/i.exec(text)
  if (host && (host[2] || host[1]?.includes('.') || LOOPBACK_HOST.test(host[1] ?? ''))) {
    const local = LOOPBACK_HOST.test(host[1] ?? '') || /\.localhost$/i.test(host[1] ?? '')
    return new URL(`${local ? 'http' : 'https'}://${text}`).href
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text))
    throw new PersonBrowserError('scheme', `${text.split(':')[0]}: addresses cannot be opened here`)
  throw new PersonBrowserError('address', `${text} is not a web address`)
}

/** An allowed site as `localhost:<port>`, from a port, a host and port, or a URL on this computer; undefined otherwise. */
export function allowedSite(text: string): string | undefined {
  const trimmed = text.trim()
  const withHost = /^\d+$/.test(trimmed) ? `localhost:${trimmed}` : trimmed
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(withHost) ? withHost : `http://${withHost}`)
  } catch {
    return undefined
  }
  if (!LOOPBACK_HOST.test(url.hostname) || !url.port) return undefined
  return `localhost:${url.port}`
}

/** What a tab of the person's keeps besides its page. */
interface Entry {
  readonly id: string
  readonly page: Page
  readonly session: CDPSession
  readonly mainFrame: string
  /** The data: URL of an HTML file it opened, and the file's name, while it shows it. */
  file?: { url: string; name: string }
  favicon?: string
  title: string
  loading: boolean
  history: { canGoBack: boolean; canGoForward: boolean }
  readonly watchers: Set<(e: PersonEvent) => void>
  streaming: boolean
}

interface Context {
  readonly context: BrowserContext
  readonly proxy: BrowserProxy
  /** Saves cookies kept Always while the context is open. */
  readonly saver: ReturnType<typeof setInterval>
}

export class PersonBrowser {
  #context?: Promise<Context>
  readonly #tabs = new Map<string, Entry>()
  /** Pages already made tabs, so a page opened here and announced by Chrome becomes one tab, not two. */
  readonly #adopting = new Map<Page, Promise<Entry | undefined>>()
  /** Everyone watching any tab: they all hear when the tabs change. */
  readonly #listeners = new Set<(e: PersonEvent) => void>()
  #settings: PersonBrowserSettings
  /** The panel's size, which a Responsive viewport follows. */
  #panel = { width: 1280, height: 800, scale: 1 }
  #next = 0

  constructor(
    private readonly launch: () => Promise<Browser>,
    private readonly options: {
      /** Where its settings and kept cookies live, readable only by this user. */
      dir: string
      /** Ports it may always open: Myrmidon's own. */
      ownPorts: () => Iterable<number>
      maxTabs?: number
    },
  ) {
    this.#settings = this.#readSettings()
  }

  get settings(): PersonBrowserSettings {
    return this.#settings
  }

  get maxTabs(): number {
    return this.options.maxTabs ?? PERSON_BROWSER_MAX_TABS
  }

  /** The largest HTML file `open` takes, so the page can say so before sending a larger one. */
  get maxHtmlBytes(): number {
    return PERSON_BROWSER_HTML_MAX_BYTES
  }

  updateSettings(patch: Partial<PersonBrowserSettings>): PersonBrowserSettings {
    const allowedSites = patch.allowedSites
      ? [...new Set(patch.allowedSites.flatMap((s) => allowedSite(s) ?? []))]
      : this.#settings.allowedSites
    const next = { ...this.#settings, ...patch, allowedSites }
    const before = this.#settings
    this.#settings = next
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 })
    atomicWrite(this.#file('settings.json'), `${JSON.stringify(next, null, 2)}\n`, 0o600)
    if (before.cookies === 'always' && next.cookies !== 'always')
      rmSync(this.#file('cookies.json'), { force: true })
    if (next.cookies === 'always' && before.cookies !== 'always') void this.#saveCookies()
    if (before.viewport !== next.viewport)
      for (const entry of this.#tabs.values()) if (entry.streaming) void this.#size(entry)
    return next
  }

  tabs(): PersonTab[] {
    return [...this.#tabs.values()].map((e) => this.#info(e))
  }

  /** A tab's page, for tests and the screenshot. */
  page(id: string): Page | undefined {
    return this.#tabs.get(id)?.page
  }

  /** Opens a tab at an address (blank without one), or showing an HTML file from the person's computer. */
  async open(what?: string | { html: string; name: string }): Promise<PersonTab> {
    if (this.#tabs.size >= this.maxTabs)
      throw new PersonBrowserError('full', `at most ${this.maxTabs} tabs can be open`)
    const file = typeof what === 'object' ? this.#fileUrl(what) : undefined
    return this.#openAt(file?.url ?? browserAddress(typeof what === 'string' ? what : ''), file)
  }

  async #openAt(url: string, file?: { url: string; name: string }): Promise<PersonTab> {
    this.#assertAllowed(url)
    const { context } = await this.#ctx()
    const entry = await this.#adopt(await context.newPage())
    if (!entry) throw new PersonBrowserError('full', `at most ${this.maxTabs} tabs can be open`)
    if (file) entry.file = file
    if (url !== 'about:blank') await this.#goto(entry, url)
    return this.#info(entry)
  }

  async close(id: string): Promise<void> {
    const entry = this.#entry(id)
    this.#tabs.delete(id)
    await this.#saveCookies()
    await entry.page.close().catch(() => {})
    this.#changed()
    // Nothing is kept past the last tab: dropping the whole context forgets cookies, storage and cache at once.
    if (this.#tabs.size === 0 && this.#settings.cookies === 'never') await this.#dispose()
  }

  /** Opens an address in a tab, or goes back, forward, or reloads. */
  async go(id: string, to: { url: string } | { action: 'back' | 'forward' | 'reload' }): Promise<PersonTab> {
    const entry = this.#entry(id)
    if ('url' in to) {
      const url = browserAddress(to.url)
      this.#assertAllowed(url)
      entry.file = undefined
      await this.#goto(entry, url)
    } else {
      const options = { waitUntil: 'domcontentloaded', timeout: 30_000 } as const
      if (to.action === 'back') await entry.page.goBack(options)
      else if (to.action === 'forward') await entry.page.goForward(options)
      else await entry.page.reload(options)
      await this.#refresh(entry)
    }
    return this.#info(entry)
  }

  /** Streams a tab: its frames while watched, and every change to the tabs. Returns the function that stops. */
  async watch(id: string, onEvent: (e: PersonEvent) => void): Promise<() => void> {
    const entry = this.#entry(id)
    this.#listeners.add(onEvent)
    entry.watchers.add(onEvent)
    onEvent({ type: 'tabs', tabs: this.tabs() })
    // Only the window's front tab paints in headless Chrome, so the watched one comes to the front.
    await entry.page.bringToFront().catch(() => {})
    if (!entry.streaming) await this.#stream(entry)
    return () => {
      this.#listeners.delete(onEvent)
      entry.watchers.delete(onEvent)
      if (entry.watchers.size === 0 && entry.streaming) {
        entry.streaming = false
        void entry.session.send('Page.stopScreencast').catch(() => {})
      }
    }
  }

  /** Input to a tab; a copy answers with what it took out of the page. */
  async input(id: string, e: PersonInput): Promise<PersonEvent | undefined> {
    const entry = this.#entry(id)
    const { keyboard } = entry.page
    switch (e.type) {
      case 'resize':
        this.#panel = {
          width: Math.round(clamp(e.width, 200, 3840)),
          height: Math.round(clamp(e.height, 150, 2400)),
          scale: Math.round(clamp(e.scale, 1, PERSON_BROWSER_MAX_SCALE) * 100) / 100,
        }
        if (this.#settings.viewport === 'responsive') await this.#size(entry)
        return
      case 'copy': {
        const text = await this.#selection(entry)
        if (e.cut && text) await keyboard.press('Delete')
        return { type: 'copied', text }
      }
      case 'key': {
        const modifiers = e.modifiers ?? []
        const mod = modifiers.includes('Meta') || modifiers.includes('Control')
        const lower = e.key.toLowerCase()
        const command = !mod
          ? undefined
          : lower === 'z' && modifiers.includes('Shift')
            ? 'redo'
            : EDIT_COMMANDS[lower]
        for (const m of modifiers) await keyboard.down(m)
        try {
          await keyboard.press(e.key as never, command ? { commands: [command] } : undefined)
        } finally {
          for (const m of [...modifiers].reverse()) await keyboard.up(m)
        }
        return
      }
      default:
        await pressInput(entry.page, e)
    }
  }

  /** What is selected in the page: in the focused field, else in the document. */
  async #selection(entry: Entry): Promise<string> {
    const text = await entry.page
      .evaluate(() => {
        const field = document.activeElement
        if (
          (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
          field.selectionStart !== null &&
          field.selectionEnd !== null
        )
          return field.value.slice(field.selectionStart, field.selectionEnd)
        return String(window.getSelection() ?? '')
      })
      .catch(() => '')
    return typeof text === 'string' ? text.slice(0, PERSON_BROWSER_COPY_MAX_CHARS) : ''
  }

  /** The tab's viewport as a PNG. */
  async screenshot(id: string): Promise<Uint8Array> {
    return this.#entry(id).page.screenshot({ type: 'png' })
  }

  /**
   * Clear browsing data: the whole context goes (every cookie, the cache, every site's storage, frames' included, and
   * the kept cookies), and the tabs open again where they were in a fresh one, under new ids and without their history.
   */
  async clear(): Promise<void> {
    rmSync(this.#file('cookies.json'), { force: true })
    const open = [...this.#tabs.values()].map((e) => {
      const url = e.page.url()
      return { url: /^(https?|data):|^about:blank$/.test(url) ? url : 'about:blank', file: e.file }
    })
    this.#tabs.clear()
    this.#adopting.clear()
    await this.#dispose()
    for (const tab of open)
      await this.#openAt(tab.url, tab.file && tab.file.url === tab.url ? tab.file : undefined).catch(() => {})
    this.#changed()
  }

  /** Saves the kept cookies and closes the context and its proxy, before Chrome or Myrmidon stops. */
  async shutdown(): Promise<void> {
    await this.#saveCookies().catch(() => {})
    this.#tabs.clear()
    this.#adopting.clear()
    await this.#dispose()
  }

  #entry(id: string): Entry {
    const entry = this.#tabs.get(id)
    if (!entry) throw new PersonBrowserError('missing', 'that tab is closed')
    return entry
  }

  #file(name: string): string {
    return join(this.options.dir, name)
  }

  #readSettings(): PersonBrowserSettings {
    try {
      const raw = JSON.parse(
        readFileSync(this.#file('settings.json'), 'utf8'),
      ) as Partial<PersonBrowserSettings>
      return {
        cookies: (['quit', 'always', 'never'] as const).find((m) => m === raw.cookies) ?? DEFAULTS.cookies,
        allowedSites: Array.isArray(raw.allowedSites)
          ? raw.allowedSites.flatMap((s) => (typeof s === 'string' ? (allowedSite(s) ?? []) : []))
          : [],
        viewport:
          raw.viewport === 'responsive' || (raw.viewport && raw.viewport in PERSON_BROWSER_VIEWPORTS)
            ? raw.viewport
            : DEFAULTS.viewport,
      }
    } catch {
      return DEFAULTS
    }
  }

  #ports(): ReadonlySet<number> {
    return new Set([
      ...this.options.ownPorts(),
      ...this.#settings.allowedSites.map((s) => Number(s.slice(s.lastIndexOf(':') + 1))),
    ])
  }

  /** Refuses a port on this computer the person has not allowed, before going there (the proxy refuses it anyway). */
  #assertAllowed(url: string) {
    if (!/^https?:/.test(url)) return
    const parsed = new URL(url)
    if (!quickRefusal(parsed, () => this.#ports())) return
    const site = `${parsed.hostname}:${urlPort(parsed)}`
    const port = allowedSite(site)
    if (port) throw new PersonBrowserError('blocked', `${site} is not one of the allowed sites`, port)
    throw new PersonBrowserError('private', `${parsed.hostname} is on the local network`, parsed.hostname)
  }

  /** The page itself tried to open a local address in its tab (the proxy refused it): its watchers are told. */
  #refusedNavigation(entry: Entry, url: string) {
    let target: URL
    let from = ''
    try {
      target = new URL(url)
      from = new URL(entry.page.url()).host
    } catch {
      return
    }
    const port = allowedSite(`${target.hostname}:${urlPort(target)}`)
    const event: PersonEvent = { type: 'refused', site: port ?? target.hostname, from, local: !!port }
    for (const fn of entry.watchers) fn(event)
  }

  #fileUrl(file: { html: string; name: string }): { url: string; name: string } {
    const bytes = Buffer.byteLength(file.html)
    if (bytes > PERSON_BROWSER_HTML_MAX_BYTES)
      throw new PersonBrowserError(
        'size',
        `an HTML file can be at most ${PERSON_BROWSER_HTML_MAX_BYTES} bytes`,
      )
    // A data: URL has an opaque origin: the file reaches nothing of Myrmidon's, and no path into the person's folders.
    return {
      url: `data:text/html;charset=utf-8;base64,${Buffer.from(file.html).toString('base64')}`,
      name: file.name.replace(/^.*[\\/]/, '').slice(0, 120) || 'file.html',
    }
  }

  #ctx(): Promise<Context> {
    this.#context ??= (async () => {
      const browser = await this.launch()
      const proxy = await startBrowserProxy({ localPorts: () => this.#ports(), sayWhy: false })
      try {
        const context = await browser.createBrowserContext({
          proxyServer: `http://127.0.0.1:${proxy.port}`,
          // As for the agents: localhost goes through the proxy too, which checks its port.
          proxyBypassList: ['<-loopback>'],
          // Downloads would land in the server's own folders; there is nowhere to show them yet.
          downloadBehavior: { policy: 'deny' },
        })
        context.on('targetcreated', (target) => {
          if (target.type() !== 'page') return
          // A link that opens a new window becomes a tab, as in any browser.
          void target.page().then(async (page) => {
            if (!page || this.#adopting.has(page)) return
            const entry = await this.#adopt(page)
            if (entry) await this.#refresh(entry)
          })
        })
        const saver = setInterval(
          () => void this.#saveCookies().catch(() => {}),
          PERSON_BROWSER_COOKIE_SAVE_MS,
        )
        saver.unref?.()
        browser.once('disconnected', () => {
          clearInterval(saver)
          proxy.close()
          this.#context = undefined
          this.#tabs.clear()
          this.#adopting.clear()
          this.#changed()
        })
        const kept = this.#settings.cookies === 'always' ? this.#keptCookies() : []
        if (kept.length) await context.setCookie(...kept)
        return { context, proxy, saver }
      } catch (err) {
        proxy.close()
        throw err
      }
    })()
    this.#context.catch(() => {
      this.#context = undefined
    })
    return this.#context
  }

  async #dispose(): Promise<void> {
    const pending = this.#context
    this.#context = undefined
    const ctx = await pending?.catch(() => undefined)
    if (!ctx) return
    clearInterval(ctx.saver)
    await ctx.context.close().catch(() => {})
    ctx.proxy.close()
  }

  #keptCookies(): CookieData[] {
    try {
      const raw = JSON.parse(readFileSync(this.#file('cookies.json'), 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as CookieData[]) : []
    } catch {
      return []
    }
  }

  async #saveCookies(): Promise<void> {
    if (this.#settings.cookies !== 'always' || !this.#context) return
    const { context } = await this.#context
    const cookies = await context.cookies().catch(() => undefined)
    if (!cookies || this.#settings.cookies !== 'always') return
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 })
    // Sign-ins are in here: readable by this user only, like the device tokens.
    atomicWrite(this.#file('cookies.json'), `${JSON.stringify(cookies)}\n`, 0o600)
  }

  /** Makes a page of the person's context a tab; a page past the tab limit is closed instead. */
  #adopt(page: Page): Promise<Entry | undefined> {
    const known = this.#adopting.get(page)
    if (known) return known
    const adopting = (async () => {
      if (this.#tabs.size >= this.maxTabs) {
        await page.close().catch(() => {})
        return undefined
      }
      const session = await page.createCDPSession()
      await session.send('Page.enable')
      const { frameTree } = await session.send('Page.getFrameTree')
      const entry: Entry = {
        id: `t${++this.#next}`,
        page,
        session,
        mainFrame: frameTree.frame.id,
        title: '',
        loading: false,
        history: { canGoBack: false, canGoForward: false },
        watchers: new Set(),
        streaming: false,
      }
      session.on(
        'Page.screencastFrame',
        (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
          for (const fn of entry.watchers)
            fn({
              type: 'frame',
              data: f.data,
              width: f.metadata.deviceWidth,
              height: f.metadata.deviceHeight,
            })
          void session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
        },
      )
      session.on('Page.frameStartedLoading', ({ frameId }: { frameId: string }) => {
        if (frameId !== entry.mainFrame) return
        entry.loading = true
        this.#changed()
      })
      session.on('Page.frameStoppedLoading', ({ frameId }: { frameId: string }) => {
        if (frameId !== entry.mainFrame) return
        entry.loading = false
        void this.#refresh(entry).then(() => this.#findFavicon(entry))
      })
      // A refused navigation of the tab's own: a page served in its place over http, or a tunnel refused for https.
      const ownNavigation = (r: HTTPRequest) => r.isNavigationRequest() && r.frame() === page.mainFrame()
      page.on('response', (r) => {
        if (r.headers()[REFUSED_HEADER] && ownNavigation(r.request())) this.#refusedNavigation(entry, r.url())
      })
      page.on('requestfailed', (r) => {
        // One answered by the proxy's refusal page was told above, when it answered.
        if (!ownNavigation(r) || r.response()) return
        try {
          if (quickRefusal(new URL(r.url()), () => this.#ports())) this.#refusedNavigation(entry, r.url())
        } catch {}
      })
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return
        const url = page.url()
        if (entry.file && url !== entry.file.url) entry.file = undefined
        entry.favicon = undefined
        void this.#refresh(entry)
      })
      page.on('close', () => {
        if (this.#tabs.get(entry.id) !== entry) return
        this.#tabs.delete(entry.id)
        this.#changed()
      })
      this.#tabs.set(entry.id, entry)
      this.#changed()
      return entry
    })()
    this.#adopting.set(page, adopting)
    return adopting
  }

  async #goto(entry: Entry, url: string): Promise<void> {
    try {
      await entry.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } finally {
      await this.#refresh(entry)
    }
  }

  /** Reads the tab's title and its back and forward state anew, and tells the watchers. */
  async #refresh(entry: Entry): Promise<void> {
    entry.title = await entry.page.title().catch(() => entry.title)
    const history = await entry.session
      .send('Page.getNavigationHistory')
      .catch(() => ({ currentIndex: 0, entries: [{}] }))
    entry.history = {
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
    }
    this.#changed()
  }

  #info(entry: Entry): PersonTab {
    const url = entry.page.url()
    const file = entry.file && url === entry.file.url ? entry.file.name : undefined
    return {
      id: entry.id,
      url,
      title: entry.title,
      ...(entry.favicon ? { favicon: entry.favicon } : {}),
      ...(file ? { file } : {}),
      loading: entry.loading,
      ...entry.history,
    }
  }

  #changed() {
    const tabs = this.tabs()
    for (const fn of this.#listeners) fn({ type: 'tabs', tabs })
  }

  /** The site's own small icon, read by the page itself (same origin), as a data: URL checked to be an image. */
  async #findFavicon(entry: Entry): Promise<void> {
    if (!/^https?:/.test(entry.page.url())) return
    const icon = await entry.page
      .evaluate(async (max: number) => {
        const link = document.querySelector<HTMLLinkElement>('link[rel~="icon" i]')
        const href = link?.href || `${location.origin}/favicon.ico`
        if (href.startsWith('data:')) return href.length <= max ? href : undefined
        if (new URL(href).origin !== location.origin) return undefined
        const res = await fetch(href, { credentials: 'omit' })
        const blob = await res.blob()
        if (!res.ok || !blob.type.startsWith('image/') || blob.size > max) return undefined
        return await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.readAsDataURL(blob)
        })
      }, PERSON_BROWSER_FAVICON_MAX_BYTES)
      .catch(() => undefined)
    // The page could answer anything: only a base64 image goes on to the dashboard, which shows it in an <img>.
    if (
      typeof icon === 'string' &&
      icon.length <= PERSON_BROWSER_FAVICON_MAX_BYTES * 1.4 &&
      /^data:image\/(png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(
        icon,
      )
    ) {
      entry.favicon = icon
      this.#changed()
    }
  }

  /** The viewport the settings call for: the panel's size, or a fixed device's. */
  async #size(entry: Entry): Promise<void> {
    const mode = this.#settings.viewport
    const fixed = mode === 'responsive' ? undefined : PERSON_BROWSER_VIEWPORTS[mode]
    const viewport = fixed
      ? { ...fixed, deviceScaleFactor: this.#panel.scale }
      : {
          width: this.#panel.width,
          height: this.#panel.height,
          deviceScaleFactor: this.#panel.scale,
          isMobile: false,
          hasTouch: false,
        }
    await entry.page.setViewport(viewport)
    if (entry.streaming) {
      await entry.session.send('Page.stopScreencast').catch(() => {})
      await this.#startScreencast(entry)
    }
  }

  async #stream(entry: Entry): Promise<void> {
    await this.#size(entry)
    entry.streaming = true
    await this.#startScreencast(entry)
  }

  async #startScreencast(entry: Entry): Promise<void> {
    const viewport = entry.page.viewport()
    const scale = viewport?.deviceScaleFactor ?? 1
    await entry.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: Math.round((viewport?.width ?? this.#panel.width) * scale),
      maxHeight: Math.round((viewport?.height ?? this.#panel.height) * scale),
    })
  }
}

const clamp = (n: number, min: number, max: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
