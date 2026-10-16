import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import type { Browser, BrowserContext, CDPSession, CookieData, Page } from 'puppeteer-core'
import { CdmClient } from './cdm.ts'
import { BROWSER_CONNECT_MS, BROWSER_PASTE_MAX_CHARS, BROWSER_VIEWPORT } from './config.ts'
import { leashRunning } from './leashed.ts'
import { prompts } from './prompts.ts'
import { guardLoopbackPort } from './sandbox.ts'
import { atomicWrite } from './settings.ts'
import {
  assertReachableUrl,
  type LocalPorts,
  type Lookup,
  NOT_CONNECTED,
  reachableAddresses,
  UnreachableError,
  urlPort,
} from './web.ts'

/**
 * A real browser for agents: one headless Chrome per server process with its own throwaway profile (never the
 * person's), and one browser context per agent, so agents never share cookies, storage or pages. Each context has its
 * own proxy, which lets that agent reach the public internet and its own round's localhost ports only.
 * chrome-devtools-mcp (cdm.ts) reads and drives the pages; this hub (the supervisor) owns what the engine does not:
 * Chrome's launch and lifetime, the contexts and their proxies, published files, downloads, sign-ins kept per chat,
 * and the live view a person watches and takes over. browser-agent.ts is the agents' side.
 */

/** What a person watching an agent's tab receives. Coordinates are CSS pixels in the page viewport. */
export type LiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'cursor'; x: number; y: number; action: 'move' | 'click' | 'type' }
  | { type: 'page'; url: string; title: string }
  | { type: 'control'; by: 'agent' | 'person' }
  /** The element the agent is about to act on, or null once it is done. */
  | { type: 'highlight'; box: { x: number; y: number; width: number; height: number; label: string } | null }

/** Input from a person who has taken control, in CSS pixels. */
export type LiveInput =
  | {
      type: 'mouse'
      action: 'move' | 'down' | 'up'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  /** Clipboard text, inserted at once like a paste: newlines do not press Enter. */
  | { type: 'paste'; text: string }
  | { type: 'navigate'; url: string }

interface Tab {
  /** The page the agent is on; `pages` are all its open pages, in the order they opened. */
  page: Page
  readonly pages: Page[]
  /** The agent's own browser context: its cookies, storage and cache, behind its own proxy. */
  readonly context: BrowserContext
  /** Where downloads land, when the agent has a scratch directory. */
  readonly downloads?: string
  readonly watchers: Set<(e: LiveEvent) => void>
  cdp?: CDPSession
  cursor: { x: number; y: number }
  controlledBy: 'agent' | 'person'
  /** The loopback ports this tab may reach: its run's own servers (and any the hub allows every tab); `all` with full access. */
  readonly localPorts: LocalPorts
  /** Why the proxy last refused a connection, if it did at or after `since`; for saying why a navigation failed. */
  readonly refusal: (since: number) => string | undefined
  /** The colony's published files, served to this tab at their own origin. */
  readonly artifacts?: ArtifactSource
  /** The engine, started on first use; one for every tab of the hub. */
  readonly engine: () => CdmClient
  /** The engine's id for one of the tab's pages, which every engine call names. */
  readonly idOf: (page: Page) => Promise<number>
}

/**
 * A colony's published files as its agents' browsers see them: at an http origin of the colony's own, answered from
 * the colony's store by request interception, so a page's relative loads (fetch, ES modules) are same-origin, as
 * they would be on a web server, instead of the cross-origin requests a file:// page makes. Nothing
 * listens there: a request never reaches the network.
 */
export interface ArtifactSource {
  readonly origin: string
  file(name: string): Promise<{ readonly body: Uint8Array; readonly mediaType: string } | undefined>
}

/** The origin a colony's published files are served at; `.localhost` makes it a secure context, like localhost. */
export function artifactOrigin(colony: string): string {
  const label =
    colony
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 63) || 'colony'
  return `http://${label}.artifacts.localhost`
}

export interface TabInfo {
  readonly agent: string
  readonly url: string
  readonly title: string
  readonly controlledBy: 'agent' | 'person'
}

/** A loopback port free right now. */
function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

/** The pages the engine lists, `3: Title (https://…)` or `3: https://…` for a page without a title. */
export function enginePages(text: string): { id: number; url: string }[] {
  return text.split('\n').flatMap((line) => {
    const m = /^(\d+): (.*?)(?: \[selected\])?(?: isolatedContext=\S+)?$/.exec(line.trim())
    if (!m) return []
    const rest = m[2] ?? ''
    const url = /\(([a-z][a-z0-9+.-]*:[^\s()]*)\)$/i.exec(rest)?.[1] ?? rest
    return [{ id: Number(m[1]), url }]
  })
}

/** A chat or agent name made safe as one path segment. */
const segment = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || '_'

/**
 * Where Chrome or Chromium is installed on `platform`, most likely first; on Windows, Edge (Chromium too, and always
 * there) after them. Linux's snap and Flatpak launchers come after the distributions' own packages.
 */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  if (platform === 'win32') {
    const { join } = win32
    const programs = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
      (d): d is string => !!d,
    )
    return [
      ...programs.map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe')] : []),
      ...programs.map((d) => join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    posix.join(home, '.local/share/flatpak/exports/bin/com.google.Chrome'),
    posix.join(home, '.local/share/flatpak/exports/bin/org.chromium.Chromium'),
  ]
}

/** The Chrome for Testing builds omp downloads, inside one build folder, for every system it has them for. */
function managedChrome(build: string): string[] {
  const app = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
  return [
    join(build, 'chrome-mac-arm64', ...app),
    join(build, 'chrome-mac-x64', ...app),
    join(build, 'chrome-linux64', 'chrome'),
    join(build, 'chrome-win64', 'chrome.exe'),
    join(build, 'chrome-win32', 'chrome.exe'),
  ]
}

/** Chrome, Chromium, or the Chromium omp downloaded, whichever is installed. */
export function findChrome(): string | undefined {
  for (const p of [process.env.MYR_CHROME, ...chromeCandidates()]) if (p && existsSync(p)) return p
  const managed = join(homedir(), '.omp', 'puppeteer', 'chrome')
  if (!existsSync(managed)) return undefined
  for (const build of readdirSync(managed).sort().reverse()) {
    const found = managedChrome(join(managed, build)).find((c) => existsSync(c))
    if (found) return found
  }
  return undefined
}

export class BrowserHub {
  private _browser?: Promise<Browser>
  private readonly _tabs = new Map<string, Promise<Tab>>()
  /** What each open tab needs closed with it: its proxy, and where its sign-ins are kept between rounds. */
  private readonly _owned = new Map<string, { close(): void; logins?: string }>()
  /**
   * Chrome's DevTools port, chosen now rather than at launch so that every sandboxed command, even one started before
   * the first tab opens, is kept from it. DevTools over a pipe would need no port, but see _launch. The engine
   * attaches over it too (--browserUrl), from this process, outside every sandbox.
   */
  private readonly _devtoolsPort = freePort()
  private readonly _beforeClose = new Set<() => Promise<void>>()
  private _engine?: CdmClient
  /** The engine's page ids some tab has claimed, so a page is never handed to two agents. */
  private readonly _claimed = new Set<number>()
  /** The engine generation the claims are for: a restarted engine numbers its pages anew. */
  private _generation = -1
  private _mapping: Promise<unknown> = Promise.resolve()
  private _markers = 0

  constructor(
    private readonly profileDir: string,
    private readonly executable = findChrome(),
    private readonly options: {
      /** Loopback ports every tab may reach besides its run's own servers: a site the embedder serves itself (tests). */
      localPorts?: LocalPorts
      /** Where each chat's agents keep their sign-ins between rounds; next to the profile by default. */
      logins?: string
    } = {},
  ) {
    guardLoopbackPort(this._devtoolsPort)
  }

  /** Work to finish while Chrome still runs when the hub closes, such as saving the person's kept cookies. */
  beforeClose(fn: () => Promise<void>): void {
    this._beforeClose.add(fn)
  }

  get available(): boolean {
    return this.executable !== undefined
  }

  /** Why the agents' browser engine cannot run here (no Node, say), or undefined when it can. */
  get engineMissing(): string | undefined {
    return this._engineClient().missing
  }

  private get _loginsDir(): string {
    return this.options.logins ?? join(dirname(this.profileDir), 'browser-logins')
  }

  /** The Chrome behind every tab, launched on first use; the person's own browser opens its context in it. */
  browser(): Promise<Browser> {
    return this._launch()
  }

  private _engineClient(): CdmClient {
    this._engine ??= new CdmClient([
      '--browserUrl',
      `http://127.0.0.1:${this._devtoolsPort}`,
      '--no-usage-statistics',
      '--no-performance-crux',
      '--fileNavigations=false',
      // Its file tools (uploads) only ever get paths this layer checked inside the agent's own folders; without a root
      // they would be held to the temporary directory.
      '--workspace',
      '/',
    ])
    return this._engine
  }

  private _launch(): Promise<Browser> {
    if (!this.executable) throw new Error('no Chrome or Chromium found; install Chrome or set MYR_CHROME')
    this._browser ??= (async () => {
      const { launch } = await import('puppeteer-core')
      mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })
      // Every agent's context has a proxy of its own; this one is for a page outside them all, which reaches only
      // the public internet (and the ports every tab may).
      const proxy = await startBrowserProxy({ localPorts: () => this.options.localPorts?.() ?? new Set() })
      const browser = await launch({
        executablePath: this.executable,
        headless: true,
        userDataDir: this.profileDir,
        debuggingPort: this._devtoolsPort,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          // Every connection goes through a proxy, which checks and pins it; `<-loopback>` stops Chrome sending
          // localhost around it, and QUIC and WebRTC's UDP would bypass an HTTP proxy.
          `--proxy-server=http://127.0.0.1:${proxy.port}`,
          '--proxy-bypass-list=<-loopback>',
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
        defaultViewport: BROWSER_VIEWPORT,
      }).catch((err: unknown) => {
        proxy.close()
        throw err
      })
      // puppeteer stops Chrome when this process exits or gets SIGINT, SIGTERM or SIGHUP; the leash also does when it
      // is SIGKILLed or crashes. DevTools stays on a port, which the sandbox denies (guardLoopbackPort): over a pipe,
      // under Bun 1.3.14, closing it double-closes a guarded descriptor and macOS kills the whole process (EXC_GUARD,
      // which takes down the chat tests).
      const pid = browser.process()?.pid
      const leash = pid ? leashRunning(pid) : undefined
      browser.once('disconnected', () => {
        // A Chrome this hub has let go of is stopped, so the next launch does not find the profile in use.
        leash?.stdin.end()
        proxy.close()
        this._browser = undefined
        this._tabs.clear()
        for (const owned of this._owned.values()) owned.close()
        this._owned.clear()
        this._claimed.clear()
        // The engine was attached to that Chrome; the next launch starts it again.
        this._engine?.close()
      })
      return browser
    })()
    return this._browser
  }

  /**
   * The engine's id for a page, found once: a fresh page is marked with a unique blank URL first, a page that opened
   * by itself (a popup) is found by its URL among the pages no tab claimed. One mapping at a time, so two agents never
   * take the same page.
   */
  private _idOf(ids: Map<Page, number>, page: Page): Promise<number> {
    const engine = this._engineClient()
    if (engine.generation !== this._generation) {
      this._generation = engine.generation
      this._claimed.clear()
      ids.clear()
    }
    const known = ids.get(page)
    if (known !== undefined) return Promise.resolve(known)
    const mapped = this._mapping.then(async () => {
      if (ids.has(page)) return ids.get(page) as number
      let url = page.url()
      if (url === 'about:blank') {
        url = `about:blank#myr-${++this._markers}`
        await page.goto(url)
      }
      const listed = enginePages((await engine.call('list_pages', {})).text)
      if (engine.generation !== this._generation) {
        this._generation = engine.generation
        this._claimed.clear()
        ids.clear()
      }
      const found = listed.filter((p) => !this._claimed.has(p.id) && p.url === url).at(-1)
      if (!found) throw new Error(`the browser engine does not list ${url}; open the page again`)
      this._claimed.add(found.id)
      ids.set(page, found.id)
      page.once('close', () => {
        this._claimed.delete(found.id)
        ids.delete(page)
      })
      return found.id
    })
    this._mapping = mapped.catch(() => {})
    return mapped
  }

  /**
   * The agent's browser in this colony, opened on first use: a context of its own behind its own proxy, holding
   * several pages (links that open a new window are followed). `downloads` is the folder its downloads land in;
   * `chat` keeps its sign-ins for the chat's later rounds (forgotten with the chat).
   */
  tab(
    colony: string,
    agent: string,
    options: { downloads?: string; localPorts?: LocalPorts; artifacts?: ArtifactSource; chat?: string } = {},
  ): Promise<Tab> {
    const key = `${colony}/${agent}`
    let tab = this._tabs.get(key)
    if (!tab) {
      const own = options.localPorts
      const localPorts: LocalPorts = () => {
        const hub = this.options.localPorts?.() ?? []
        const mine = own?.() ?? []
        return hub === 'all' || mine === 'all' ? 'all' : new Set([...hub, ...mine])
      }
      tab = (async () => {
        const browser = await this._launch()
        let refused: { reason: string; at: number } | undefined
        const proxy = await startBrowserProxy({
          localPorts,
          onRefused: (reason) => {
            refused = { reason, at: Date.now() }
          },
        })
        const logins = options.chat
          ? join(this._loginsDir, segment(options.chat), `${segment(agent)}.json`)
          : undefined
        this._owned.set(key, { close: () => proxy.close(), ...(logins ? { logins } : {}) })
        if (options.downloads) mkdirSync(options.downloads, { recursive: true })
        const context = await browser.createBrowserContext({
          proxyServer: `http://127.0.0.1:${proxy.port}`,
          proxyBypassList: ['<-loopback>'],
          ...(options.downloads
            ? { downloadBehavior: { policy: 'allow' as const, downloadPath: options.downloads } }
            : { downloadBehavior: { policy: 'deny' as const } }),
        })
        const kept = logins ? keptCookies(logins) : []
        if (kept.length) await context.setCookie(...kept).catch(() => {})
        const ids = new Map<Page, number>()
        const t: Tab = {
          localPorts,
          refusal: (since) => (refused && refused.at >= since ? refused.reason : undefined),
          page: undefined as unknown as Page,
          pages: [],
          context,
          ...(options.downloads ? { downloads: options.downloads } : {}),
          ...(options.artifacts ? { artifacts: options.artifacts } : {}),
          watchers: new Set(),
          cursor: { x: BROWSER_VIEWPORT.width / 2, y: BROWSER_VIEWPORT.height / 2 },
          controlledBy: 'agent',
          engine: () => this._engineClient(),
          idOf: (page) => this._idOf(ids, page),
        }
        // A link that opens a new window is followed, the way a person's browser switches to it.
        context.on('targetcreated', (target) => {
          if (target.type() !== 'page') return
          void target.page().then(async (page) => {
            if (!page || t.pages.includes(page)) return
            await adopt(t, page)
            await switchPage(t, page)
          })
        })
        const page = await context.newPage()
        await adopt(t, page)
        t.page = page
        return t
      })()
      this._tabs.set(key, tab)
      tab.catch(() => {
        this._tabs.delete(key)
        this._owned.get(key)?.close()
        this._owned.delete(key)
      })
    }
    return tab
  }

  /** The tabs a colony has open, for the live view. */
  async tabs(colony: string): Promise<TabInfo[]> {
    const prefix = `${colony}/`
    const out: TabInfo[] = []
    for (const [key, pending] of this._tabs) {
      if (!key.startsWith(prefix)) continue
      const tab = await pending.catch(() => undefined)
      if (!tab || tab.page.isClosed()) continue
      out.push({
        agent: key.slice(prefix.length),
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        controlledBy: tab.controlledBy,
      })
    }
    return out
  }

  /**
   * Streams an agent's tab to a watcher: screencast frames, the agent's cursor, page changes, and who has control.
   * The screencast runs only while someone watches. Returns the function that stops watching.
   */
  async watch(colony: string, agent: string, onEvent: (e: LiveEvent) => void): Promise<() => void> {
    const key = `${colony}/${agent}`
    const pending = this._tabs.get(key)
    if (!pending) throw new Error(`${agent} has no browser tab open`)
    const tab = await pending
    tab.watchers.add(onEvent)
    onEvent({ type: 'page', url: tab.page.url(), title: await tab.page.title().catch(() => '') })
    onEvent({ type: 'control', by: tab.controlledBy })
    onEvent({ type: 'cursor', ...tab.cursor, action: 'move' })
    if (!tab.cdp) await startScreencast(tab)
    return () => {
      tab.watchers.delete(onEvent)
      if (tab.watchers.size === 0) stopScreencast(tab)
    }
  }

  /**
   * Hands an agent's tab to the person or back. While the person has it, the agent's browser tools wait. Handing it
   * back keeps what the person signed in to for the chat's later rounds.
   */
  async setControl(colony: string, agent: string, by: 'agent' | 'person'): Promise<void> {
    const key = `${colony}/${agent}`
    const tab = await this._tabs.get(key)
    if (!tab) throw new Error(`${agent} has no browser tab open`)
    tab.controlledBy = by
    emit(tab, { type: 'control', by })
    if (by === 'agent') await this._keepLogins(key, tab)
  }

  /** Input from the person controlling a tab. */
  async input(colony: string, agent: string, e: LiveInput): Promise<void> {
    const tab = await this._tabs.get(`${colony}/${agent}`)
    if (!tab) throw new Error(`${agent} has no browser tab open`)
    if (tab.controlledBy !== 'person') throw new Error('take control first')
    if (e.type === 'navigate') {
      if (!/^https?:\/\//.test(e.url)) throw new Error('only http(s) URLs')
      await tab.page.goto(e.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return
    }
    await pressInput(tab.page, e)
  }

  private async _keepLogins(key: string, tab: Tab): Promise<void> {
    const file = this._owned.get(key)?.logins
    if (!file) return
    const cookies = await tab.context.cookies().catch(() => undefined)
    if (!cookies) return
    if (cookies.length === 0) {
      rmSync(file, { force: true })
      return
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // Sign-ins are in here: readable by this user only, like the person's own kept cookies.
    atomicWrite(file, `${JSON.stringify(cookies)}\n`, 0o600)
  }

  /** Closes every tab a colony opened, keeping each agent's sign-ins for the chat's next round first. */
  async closeColony(colony: string): Promise<void> {
    const prefix = `${colony}/`
    const tabs = [...this._tabs.entries()].filter(([k]) => k.startsWith(prefix))
    for (const [key, pending] of tabs) {
      this._tabs.delete(key)
      const tab = await pending.catch(() => undefined)
      if (tab) {
        stopScreencast(tab)
        await this._keepLogins(key, tab).catch(() => {})
        await tab.context.close().catch(() => {})
      }
      this._owned.get(key)?.close()
      this._owned.delete(key)
    }
  }

  /** Forgets every sign-in a chat's agents kept, when the chat is deleted. */
  forgetChat(chat: string): void {
    rmSync(join(this._loginsDir, segment(chat)), { recursive: true, force: true })
  }

  async close(): Promise<void> {
    for (const fn of this._beforeClose) await fn().catch(() => {})
    for (const key of [...this._tabs.keys()]) await this.closeColony(key.slice(0, key.indexOf('/')))
    const browser = this._browser
    this._browser = undefined
    this._tabs.clear()
    this._engine?.close()
    await (await browser?.catch(() => undefined))?.close()
  }
}

function keptCookies(file: string): CookieData[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as CookieData[]) : []
  } catch {
    return []
  }
}

/** A person's mouse, wheel or keyboard input on a page, in CSS pixels; shared by agents' tabs and the person's own. */
export async function pressInput(page: Page, e: Exclude<LiveInput, { type: 'navigate' }>): Promise<void> {
  const { mouse, keyboard } = page
  switch (e.type) {
    case 'mouse':
      if (e.action === 'move') await mouse.move(e.x, e.y)
      else if (e.action === 'down') {
        await mouse.move(e.x, e.y)
        await mouse.down({ button: e.button ?? 'left' })
      } else await mouse.up({ button: e.button ?? 'left' })
      return
    case 'wheel':
      await mouse.move(e.x, e.y)
      await mouse.wheel({ deltaX: e.deltaX, deltaY: e.deltaY })
      return
    case 'key':
      await keyboard.press(e.key as never)
      return
    case 'text':
      await keyboard.type(e.text)
      return
    case 'paste':
      if (e.text.length > BROWSER_PASTE_MAX_CHARS)
        throw new Error(`a paste can be at most ${BROWSER_PASTE_MAX_CHARS} characters`)
      await keyboard.sendCharacter(e.text)
  }
}

export type { Tab as BrowserTab }

/**
 * Wires a page into an agent's browser: live-view page events, the colony's published files, and the switch to the
 * page before it when it closes. A page is adopted once, however it opened.
 */
async function adopt(tab: Tab, page: Page): Promise<void> {
  if (tab.pages.includes(page)) return
  tab.pages.push(page)
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && page === tab.page)
      void page.title().then(
        (title) => emit(tab, { type: 'page', url: page.url(), title }),
        () => {},
      )
  })
  page.on('close', () => {
    const i = tab.pages.indexOf(page)
    if (i >= 0) tab.pages.splice(i, 1)
    const next = tab.pages.at(-1)
    if (page === tab.page && next) void switchPage(tab, next)
  })
  if (tab.artifacts) await serveArtifacts(page, tab.artifacts).catch(() => {})
}

/**
 * Answers the page's requests for the colony's published files from its store; `/` is index.html, as a web server
 * would. Only that origin is intercepted (Fetch with a pattern), so the engine's own work on the page is untouched.
 */
async function serveArtifacts(page: Page, source: ArtifactSource): Promise<void> {
  const session = await page.createCDPSession()
  session.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string } }) => {
    void (async () => {
      try {
        const url = new URL(e.request.url)
        const name = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
        const file = await source.file(name.endsWith('/') ? `${name}index.html` : name)
        const text =
          file && (file.mediaType.startsWith('text/') || /json|xml|javascript/.test(file.mediaType))
        await session.send('Fetch.fulfillRequest', {
          requestId: e.requestId,
          responseCode: file ? 200 : 404,
          responseHeaders: [
            {
              name: 'content-type',
              value: file
                ? text
                  ? `${file.mediaType}; charset=utf-8`
                  : file.mediaType
                : 'text/plain; charset=utf-8',
            },
            { name: 'cache-control', value: 'no-store' },
          ],
          body: Buffer.from(
            file ? file.body : new TextEncoder().encode(`no published file ${name}`),
          ).toString('base64'),
        })
      } catch {
        await session
          .send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' })
          .catch(() => {})
      }
    })()
  })
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: `${source.origin}/*`, requestStage: 'Request' }],
  })
}

/** Makes another of the agent's pages the active one; the live view follows. */
export async function switchPage(tab: Tab, page: Page): Promise<void> {
  if (tab.page === page) return
  const streaming = tab.cdp !== undefined
  if (streaming) stopScreencast(tab)
  tab.page = page
  await page.bringToFront().catch(() => {})
  if (streaming) await startScreencast(tab)
  emit(tab, { type: 'page', url: page.url(), title: await page.title().catch(() => '') })
}

/** Opens a new page in the agent's own context and switches to it. */
export async function openPage(tab: Tab): Promise<Page> {
  const page = await tab.context.newPage()
  await adopt(tab, page)
  await switchPage(tab, page)
  return page
}

async function startScreencast(tab: Tab): Promise<void> {
  const cdp = await tab.page.createCDPSession()
  tab.cdp = cdp
  cdp.on(
    'Page.screencastFrame',
    (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      emit(tab, {
        type: 'frame',
        data: f.data,
        width: f.metadata.deviceWidth,
        height: f.metadata.deviceHeight,
      })
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    },
  )
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 70,
    maxWidth: BROWSER_VIEWPORT.width,
    maxHeight: BROWSER_VIEWPORT.height,
  })
}

function stopScreencast(tab: Tab): void {
  const cdp = tab.cdp
  if (!cdp) return
  tab.cdp = undefined
  void cdp
    .send('Page.stopScreencast')
    .then(() => cdp.detach())
    .catch(() => {})
}

function emit(tab: Tab, e: LiveEvent) {
  for (const fn of tab.watchers) fn(e)
}

/** Refuses an agent's browser action while the person has control. */
export function assertAgentControl(tab: Tab): void {
  if (tab.controlledBy === 'person')
    throw new Error(
      'the person has taken control of your browser. Stop here with one short line; you will be woken when they hand it back',
    )
}

/** Whether anyone is watching this tab; agents only slow down to be followed when someone is. */
export function watched(tab: Tab): boolean {
  return tab.watchers.size > 0
}

/** Clears the highlight once the agent's action is done. */
export function doneWith(tab: Tab): void {
  if (watched(tab)) emit(tab, { type: 'highlight', box: null })
}

/**
 * Shows a watcher what the agent is about to act on: the box is highlighted and the cursor glides to its centre in
 * visible steps. Nobody watching, nothing is sent and nothing waits.
 */
export async function glideTo(
  tab: Tab,
  box: { x: number; y: number; width: number; height: number },
  action: 'click' | 'type',
  label = '',
): Promise<void> {
  if (!watched(tab)) return
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  emit(tab, { type: 'highlight', box: { ...box, label } })
  const from = tab.cursor
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    // Ease out, so the pointer decelerates onto its target like a hand would.
    const t = 1 - (1 - i / steps) ** 3
    emit(tab, {
      type: 'cursor',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      action: 'move',
    })
    await Bun.sleep(28)
  }
  tab.cursor = to
  emit(tab, { type: 'cursor', ...to, action })
}

/** Marks a page the browser's proxy served in place of a refused request. */
export const REFUSED_HEADER = 'x-myrmidon-refused'

/**
 * Opens `url` in one of the agent's pages through the engine, after checking the agent may reach it, and says why
 * when the agent's proxy refused it or a redirect from it (the proxy refuses quietly, as a network error or a 403
 * page with the reason).
 */
export async function navigate(tab: Tab, page: Page, url: string): Promise<string> {
  const own = tab.artifacts && url.startsWith(`${tab.artifacts.origin}/`)
  if (/^https?:/i.test(url) && !own) await assertReachableUrl(url, tab.localPorts)
  const since = Date.now()
  const pageId = await tab.idOf(page)
  let said: string
  try {
    said = (await tab.engine().call('navigate_page', { pageId, type: 'url', url, timeout: 30_000 })).text
  } catch (err) {
    // A tunnel can also fail because the site is down; only a refusal recorded during this navigation is ours.
    const reason = tab.refusal(since)
    if (
      reason &&
      /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_HTTP_RESPONSE_CODE_FAILURE/.test(String(err))
    )
      throw new UnreachableError(prompts.toolResults.browserBlocked(url, reason))
    throw err
  }
  const reason = tab.refusal(since)
  if (reason) {
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    if (body.trim() === reason.trim())
      throw new UnreachableError(prompts.toolResults.browserBlocked(url, reason))
  }
  return said
}

/** Opens a TCP connection to the first of `addresses` that answers. */
function connectFirst(addresses: readonly string[], port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (i: number) => {
      const socket = connect({ host: addresses[i] ?? '', port })
      const next = i + 1 < addresses.length
      // An address that never answers (IPv6 without a route, say) should not hold up the ones after it.
      const slow = next
        ? setTimeout(
            () => socket.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
            BROWSER_CONNECT_MS,
          )
        : undefined
      socket.once('connect', () => {
        clearTimeout(slow)
        socket.removeAllListeners('error')
        resolve(socket)
      })
      socket.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(slow)
        socket.destroy()
        if (next && (NOT_CONNECTED.has(err.code ?? '') || err.code === 'ETIMEDOUT')) attempt(i + 1)
        else reject(err)
      })
    }
    attempt(0)
  })
}

export interface BrowserProxy {
  readonly port: number
  close(): void
}

// Hop-by-hop headers, which describe the connection to the proxy rather than the request.
const HOP_HEADERS = [
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
]

/**
 * The HTTP proxy every connection of the agents' Chrome goes through. It resolves each host once, checks every
 * address (`reachableAddresses` with the union of the open tabs' ports), and connects to a checked address, so a
 * page, a subresource, a redirect hop or a WebSocket cannot reach a private address, DNS rebinding included. TLS
 * passes through untouched (CONNECT), so Chrome still checks certificates against the name.
 */
export async function startBrowserProxy(options: {
  localPorts: LocalPorts
  lookup?: Lookup
  onRefused?: (reason: string, host: string, port: number) => void
  /**
   * Whether a refused page says why. The reason is written for agents; the person's browser shows its own words
   * beside the page instead, so its refusals are blank.
   */
  sayWhy?: boolean
}): Promise<BrowserProxy> {
  const check = async (host: string, port: number) => {
    try {
      return await reachableAddresses(host, port, options.localPorts, options.lookup)
    } catch (err) {
      if (err instanceof UnreachableError) options.onRefused?.(err.message, host, port)
      throw err
    }
  }
  const server = createServer(async (req, res) => {
    // Chrome sends plain-http requests to a proxy in absolute form: GET http://host:port/path.
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    let address: string
    try {
      const addresses = await check(url.hostname, urlPort(url))
      if (addresses.length > 1) {
        // Find one that answers first: a dev server on "localhost" may listen on ::1 or 127.0.0.1 only.
        const probe = await connectFirst(addresses, urlPort(url))
        address = probe.remoteAddress ?? addresses[0] ?? ''
        probe.destroy()
      } else address = addresses[0] ?? ''
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof UnreachableError)
        res
          .writeHead(403, { 'content-type': 'text/plain; charset=utf-8', [REFUSED_HEADER]: '1' })
          .end(options.sayWhy === false ? '' : message)
      else res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(message)
      return
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host }
    for (const h of HOP_HEADERS) delete headers[h]
    const upstream = request(
      {
        host: address,
        port: urlPort(url),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('connect', async (req, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy())
    // The URL parser turns other spellings of an address (2130706433, 0x7f.1) into dotted form for the check.
    let target: URL
    try {
      target = new URL(`http://${req.url ?? ''}`)
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const port = Number(target.port || 443)
    let upstream: Socket
    try {
      upstream = await connectFirst(await check(target.hostname, port), port)
    } catch (err) {
      client.end(`HTTP/1.1 ${err instanceof UnreachableError ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`)
      return
    }
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the browser proxy did not get a port')
  return {
    port: address.port,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}
