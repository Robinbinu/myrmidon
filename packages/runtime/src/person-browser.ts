import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, CDPSession, CookieData, Page } from 'puppeteer-core'
import { type BrowserProxy, type LiveInput, pressInput, startBrowserProxy } from './browser.ts'
import {
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
 * opens cannot reach the other services on this computer either.
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
  /** A page asked for a port on this computer that is not allowed, as `localhost:3000`. */
  | { type: 'blocked'; site: string }

/** Input to a watched tab: the mouse and keyboard as in an agent's tab, and the size of the panel it shows in. */
export type PersonInput =
  | Exclude<LiveInput, { type: 'navigate' }>
  | { type: 'resize'; width: number; height: number; scale: number }

/**
 * Why the person's browser did not do something: `scheme` an address that is not a web page (file:, javascript:,
 * chrome:), `address` text that is not an address, `blocked` a port on this computer that is not allowed (`site`
 * names it), `full` the tab limit, `missing` a tab that is gone, `size` an HTML file too large.
 */
export class PersonBrowserError extends Error {
  override readonly name = 'PersonBrowserError'
  constructor(
    readonly code: 'scheme' | 'address' | 'blocked' | 'full' | 'missing' | 'size',
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
}

export class PersonBrowser {
  #context?: Promise<Context>
  readonly #tabs = new Map<string, Entry>()
  /** Pages already made tabs, so a page opened here and announced by Chrome becomes one tab, not two. */
  readonly #adopting = new Map<Page, Promise<Entry | undefined>>()
  /** Everyone watching any tab: they all hear when the tabs change. */
  readonly #listeners = new Set<(e: PersonEvent) => void>()
  /** Sites the pages have been on, whose storage Clear browsing data clears. */
  readonly #origins = new Set<string>()
  #settings: PersonBrowserSettings
  /** The panel's size, which a Responsive viewport follows. */
  #panel = { width: 1280, height: 800, scale: 1 }
  #next = 0
  #saving?: ReturnType<typeof setTimeout>

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
    const url = file?.url ?? browserAddress(typeof what === 'string' ? what : '')
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

  async input(id: string, e: PersonInput): Promise<void> {
    const entry = this.#entry(id)
    if (e.type !== 'resize') return pressInput(entry.page, e)
    this.#panel = {
      width: Math.round(clamp(e.width, 200, 3840)),
      height: Math.round(clamp(e.height, 150, 2400)),
      scale: Math.round(clamp(e.scale, 1, PERSON_BROWSER_MAX_SCALE) * 100) / 100,
    }
    if (this.#settings.viewport === 'responsive') await this.#size(entry)
  }

  /** The tab's viewport as a PNG. */
  async screenshot(id: string): Promise<Uint8Array> {
    return this.#entry(id).page.screenshot({ type: 'png' })
  }

  /** Clear browsing data: every cookie, the cache, and each site's storage, kept cookies included. */
  async clear(): Promise<void> {
    rmSync(this.#file('cookies.json'), { force: true })
    const entry = this.#tabs.values().next().value
    if (!entry) return this.#dispose()
    const { context } = await this.#ctx()
    await context.deleteCookie(...(await context.cookies()))
    await entry.session.send('Network.clearBrowserCache').catch(() => {})
    for (const origin of this.#origins)
      await entry.session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => {})
    this.#origins.clear()
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
    throw new PersonBrowserError(
      'blocked',
      `${site} is not one of the allowed sites`,
      allowedSite(site) ?? site,
    )
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
      const proxy = await startBrowserProxy({
        localPorts: () => this.#ports(),
        sayWhy: false,
        onRefused: (_reason, host, port) => {
          const site = allowedSite(`${host}:${port}`) ?? `${host}:${port}`
          for (const fn of this.#listeners) fn({ type: 'blocked', site })
        },
      })
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
        browser.once('disconnected', () => {
          proxy.close()
          this.#context = undefined
          this.#tabs.clear()
          this.#adopting.clear()
          this.#changed()
        })
        const kept = this.#settings.cookies === 'always' ? this.#keptCookies() : []
        if (kept.length) await context.setCookie(...kept)
        return { context, proxy }
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
    this.#origins.clear()
    const ctx = await pending?.catch(() => undefined)
    if (!ctx) return
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
    clearTimeout(this.#saving)
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
        this.#scheduleSave()
      })
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return
        const url = page.url()
        if (/^https?:/.test(url)) this.#origins.add(new URL(url).origin)
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

  #scheduleSave() {
    if (this.#settings.cookies !== 'always') return
    clearTimeout(this.#saving)
    this.#saving = setTimeout(() => void this.#saveCookies().catch(() => {}), 1_000)
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
