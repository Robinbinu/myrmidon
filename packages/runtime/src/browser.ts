import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type {
  Browser,
  CDPSession,
  ElementHandle,
  HTTPRequest,
  HTTPResponse,
  Page,
  SerializedAXNode,
} from 'puppeteer-core'
import {
  BROWSER_CONNECT_MS,
  BROWSER_LOG_LIMIT,
  BROWSER_NETWORK_LIMIT,
  BROWSER_PASTE_MAX_CHARS,
  BROWSER_VIEWPORT,
  SNAPSHOT_CHARS,
} from './config.ts'
import { leashRunning } from './leashed.ts'
import { prompts } from './prompts.ts'
import { guardLoopbackPort } from './sandbox.ts'
import {
  assertReachableUrl,
  type LocalPorts,
  type Lookup,
  NOT_CONNECTED,
  quickRefusal,
  reachableAddresses,
  UnreachableError,
  urlPort,
} from './web.ts'

/**
 * A real browser for agents: one headless Chrome per server process with its own throwaway profile (never the
 * person's), and one tab per agent per colony. Pages are read as accessibility snapshots with element refs,
 * the text-first model agents handle well; screenshots are there for visual checks.
 */

let networkIds = 0

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
  /** Where downloads land, when the agent has a scratch directory. */
  readonly downloads?: string
  /** Element refs from the latest snapshot. */
  refs: Map<string, SerializedAXNode>
  readonly logs: string[]
  /** Recent requests of all its pages, oldest first; API responses keep their body for browser_network. */
  readonly network: NetworkEntry[]
  readonly watchers: Set<(e: LiveEvent) => void>
  cdp?: CDPSession
  cursor: { x: number; y: number }
  controlledBy: 'agent' | 'person'
  /** The loopback ports this tab may reach: its run's own servers (and any the hub allows every tab); `all` with full access. */
  readonly localPorts: LocalPorts
  /** Whether the proxy behind every tab lets anything through, because a full-access tab is open. */
  readonly proxyOpen: () => boolean
  /** Why the browser last refused a connection, if it did at or after `since`; for saying why a navigation failed. */
  readonly refusal: (since: number) => string | undefined
  readonly onRefused: (reason: string) => void
  /** The colony's published files, served to this tab at their own origin. */
  readonly artifacts?: ArtifactSource
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

export interface NetworkEntry {
  readonly id: number
  readonly method: string
  readonly url: string
  /** Puppeteer's resource type: document, script, xhr, fetch, image, ... */
  readonly type: string
  readonly status?: number
  readonly failure?: string
  readonly ms: number
  /** Kept for xhr/fetch responses, so the body can be read on demand. */
  readonly response?: HTTPResponse
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
  /** Each open tab's reachable loopback ports; the proxy allows their union, the tab itself only its own. */
  private readonly _ports = new Map<string, LocalPorts>()
  private _refused?: { reason: string; at: number }
  /**
   * Chrome's DevTools port, chosen now rather than at launch so that every sandboxed command, even one started before
   * the first tab opens, is kept from it. DevTools over a pipe would need no port, but see _launch.
   */
  private readonly _devtoolsPort = freePort()
  private readonly _beforeClose = new Set<() => Promise<void>>()

  constructor(
    private readonly profileDir: string,
    private readonly executable = findChrome(),
    /** Loopback ports every tab may reach besides its run's own servers: a site the embedder serves itself (tests). */
    private readonly options: { localPorts?: LocalPorts } = {},
  ) {
    guardLoopbackPort(this._devtoolsPort)
  }

  /** Work to finish while Chrome still runs when the hub closes, such as saving the person's kept cookies. */
  beforeClose(fn: () => Promise<void>): void {
    this._beforeClose.add(fn)
  }

  private _allPorts(): ReadonlySet<number> | 'all' {
    const all = new Set<number>()
    for (const ports of [this.options.localPorts, ...this._ports.values()]) {
      const open = ports?.() ?? []
      if (open === 'all') return 'all'
      for (const port of open) all.add(port)
    }
    return all
  }

  private _refuse(reason: string) {
    this._refused = { reason, at: Date.now() }
  }

  get available(): boolean {
    return this.executable !== undefined
  }

  /** The Chrome behind every tab, launched on first use; the person's own browser opens its context in it. */
  browser(): Promise<Browser> {
    return this._launch()
  }

  private _launch(): Promise<Browser> {
    if (!this.executable) throw new Error('no Chrome or Chromium found; install Chrome or set MYR_CHROME')
    this._browser ??= (async () => {
      const { launch } = await import('puppeteer-core')
      mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })
      const proxy = await startBrowserProxy({
        localPorts: () => this._allPorts(),
        onRefused: (reason) => this._refuse(reason),
      })
      const browser = await launch({
        executablePath: this.executable,
        headless: true,
        userDataDir: this.profileDir,
        debuggingPort: this._devtoolsPort,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          // Every connection goes through the proxy, which checks and pins it; `<-loopback>` stops Chrome sending
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
        this._ports.clear()
      })
      return browser
    })()
    return this._browser
  }

  /**
   * The agent's browser in this colony, opened on first use. It can hold several pages (links that open a new
   * window are followed); `downloads` is the folder its downloads land in.
   */
  tab(
    colony: string,
    agent: string,
    options: { downloads?: string; localPorts?: LocalPorts; artifacts?: ArtifactSource } = {},
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
      this._ports.set(key, localPorts)
      tab = (async () => {
        const page = await (await this._launch()).newPage()
        const tab: Tab = {
          localPorts,
          proxyOpen: () => this._allPorts() === 'all',
          onRefused: (reason) => this._refuse(reason),
          refusal: (since) => {
            const refused = this._refused
            return refused && refused.at >= since ? refused.reason : undefined
          },
          page,
          pages: [],
          ...(options.downloads ? { downloads: options.downloads } : {}),
          ...(options.artifacts ? { artifacts: options.artifacts } : {}),
          refs: new Map(),
          logs: [],
          network: [],
          watchers: new Set(),
          cursor: { x: BROWSER_VIEWPORT.width / 2, y: BROWSER_VIEWPORT.height / 2 },
          controlledBy: 'agent',
        }
        await adopt(tab, page)
        return tab
      })()
      this._tabs.set(key, tab)
      tab.catch(() => {
        this._tabs.delete(key)
        this._ports.delete(key)
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

  /** Hands an agent's tab to the person or back. While the person has it, the agent's browser tools wait. */
  async setControl(colony: string, agent: string, by: 'agent' | 'person'): Promise<void> {
    const tab = await this._tabs.get(`${colony}/${agent}`)
    if (!tab) throw new Error(`${agent} has no browser tab open`)
    tab.controlledBy = by
    emit(tab, { type: 'control', by })
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

  /** Closes every tab a colony opened. */
  async closeColony(colony: string): Promise<void> {
    const prefix = `${colony}/`
    const tabs = [...this._tabs.entries()].filter(([k]) => k.startsWith(prefix))
    for (const [key, tab] of tabs) {
      this._tabs.delete(key)
      this._ports.delete(key)
      await tab.then((t) => Promise.all(t.pages.map((p) => p.close().catch(() => {})))).catch(() => {})
    }
  }

  async close(): Promise<void> {
    for (const fn of this._beforeClose) await fn().catch(() => {})
    const browser = this._browser
    this._browser = undefined
    this._tabs.clear()
    this._ports.clear()
    await (await browser?.catch(() => undefined))?.close()
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

/**
 * The page as an indented accessibility outline. Interactive and named elements get a ref (e1, e2, ...) that
 * browser_click and browser_type accept until the next snapshot.
 */
export async function pageSnapshot(tab: Tab): Promise<string> {
  const root = await tab.page.accessibility.snapshot({ interestingOnly: true })
  tab.refs = new Map()
  const lines: string[] = [`url: ${tab.page.url()}`, `title: ${await tab.page.title()}`]
  const walk = (node: SerializedAXNode, depth: number) => {
    const ref = `e${tab.refs.size + 1}`
    const named = node.name?.trim()
    const interactive = INTERACTIVE.has(node.role)
    if (interactive || named) tab.refs.set(ref, node)
    if (node.role !== 'RootWebArea' && (interactive || named || node.value !== undefined)) {
      const states = [
        node.checked !== undefined && `checked=${node.checked}`,
        node.disabled && 'disabled',
        node.expanded !== undefined && `expanded=${node.expanded}`,
        node.focused && 'focused',
        node.level !== undefined && `level=${node.level}`,
      ].filter(Boolean)
      lines.push(
        `${'  '.repeat(depth)}- ${node.role}${named ? ` "${named.slice(0, 160)}"` : ''}${
          node.value !== undefined && node.value !== '' ? ` value="${String(node.value).slice(0, 80)}"` : ''
        }${states.length ? ` (${states.join(', ')})` : ''}${interactive || named ? ` [${ref}]` : ''}`,
      )
    }
    for (const child of node.children ?? []) walk(child, depth + (node.role === 'RootWebArea' ? 0 : 1))
  }
  if (root) walk(root, 0)
  const text = lines.join('\n')
  return text.length > SNAPSHOT_CHARS
    ? `${text.slice(0, SNAPSHOT_CHARS)}${prompts.toolResults.snapshotCut}`
    : text
}

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'option',
  'listbox',
])

/** The element behind a ref from the latest snapshot. */
export async function pageElement(tab: Tab, ref: string): Promise<ElementHandle> {
  const node = tab.refs.get(ref)
  if (!node)
    throw new Error(`unknown ref ${ref}: take a fresh browser_snapshot; refs change after navigation`)
  const handle = await node.elementHandle()
  if (!handle) throw new Error(`${ref} is no longer on the page; take a fresh browser_snapshot`)
  return handle
}

export type { Tab as BrowserTab }

/**
 * Wires a page into an agent's browser: its logs, live-view page events, popups, downloads, and the check that keeps
 * it to its own run's localhost ports (the proxy behind every tab can only tell private from public).
 */
async function adopt(tab: Tab, page: Page): Promise<void> {
  const log = (line: string) => {
    tab.logs.push(line)
    if (tab.logs.length > BROWSER_LOG_LIMIT) tab.logs.shift()
  }
  await page.setRequestInterception(true)
  page.on('request', async (r) => {
    if (r.isInterceptResolutionHandled()) return
    let refused: UnreachableError | undefined
    try {
      const url = new URL(r.url())
      if (tab.artifacts && url.origin === tab.artifacts.origin)
        return void serveArtifact(tab.artifacts, url, r)
      refused = quickRefusal(url, tab.localPorts)
      // While a full-access tab is open the shared proxy lets anything through, so a confined tab looks names up
      // itself: a public name that resolves to a private address is still refused here.
      if (!refused && tab.localPorts() !== 'all' && tab.proxyOpen() && /^(https?|wss?):$/.test(url.protocol))
        await reachableAddresses(url.hostname, urlPort(url), tab.localPorts).catch((err: unknown) => {
          if (err instanceof UnreachableError) refused = err
        })
    } catch {
      refused = undefined
    }
    if (!refused) return void r.continue().catch(() => {})
    tab.onRefused(refused.message)
    log(`blocked: ${r.url()} (${refused.message})`)
    void r.abort('blockedbyclient').catch(() => {})
  })
  page.on('console', (m) => log(`console.${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => log(`page error: ${e instanceof Error ? e.message : String(e)}`))
  page.on('requestfailed', (r) => log(`request failed: ${r.url()} (${r.failure()?.errorText ?? 'unknown'})`))
  page.on('response', (r) => {
    if (r.status() >= 400) log(`HTTP ${r.status()}: ${r.url()}`)
  })
  const started = new WeakMap<HTTPRequest, number>()
  const record = (
    request: HTTPRequest,
    entry: Omit<NetworkEntry, 'id' | 'method' | 'url' | 'type' | 'ms'>,
  ) => {
    tab.network.push({
      id: ++networkIds,
      method: request.method(),
      url: request.url(),
      type: request.resourceType(),
      ms: Date.now() - (started.get(request) ?? Date.now()),
      ...entry,
    })
    if (tab.network.length > BROWSER_NETWORK_LIMIT) tab.network.shift()
  }
  // A response can arrive and the request still fail (Chrome aborts a 404 script), so keep its status apart.
  const statuses = new WeakMap<HTTPRequest, number>()
  page.on('request', (r) => started.set(r, Date.now()))
  page.on('response', (r) => statuses.set(r.request(), r.status()))
  page.on('requestfinished', (r) => {
    const response = r.response()
    const api = r.resourceType() === 'xhr' || r.resourceType() === 'fetch'
    record(r, {
      ...(response ? { status: response.status() } : {}),
      ...(api && response ? { response } : {}),
    })
  })
  page.on('requestfailed', (r) => {
    const status = statuses.get(r)
    record(r, { failure: r.failure()?.errorText ?? 'failed', ...(status ? { status } : {}) })
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && page === tab.page)
      void page.title().then(
        (title) => emit(tab, { type: 'page', url: page.url(), title }),
        () => {},
      )
  })
  // A link that opens a new window is followed, the way a person's browser switches to it.
  page.on('popup', (popup) => {
    if (popup) void adopt(tab, popup).then(() => switchPage(tab, popup))
  })
  page.on('close', () => {
    const i = tab.pages.indexOf(page)
    if (i >= 0) tab.pages.splice(i, 1)
    const next = tab.pages.at(-1)
    if (page === tab.page && next) void switchPage(tab, next)
  })
  if (tab.downloads) {
    mkdirSync(tab.downloads, { recursive: true })
    const session = await page.createCDPSession()
    await session
      .send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: tab.downloads })
      .catch(() => {})
  }
  tab.pages.push(page)
}

/** Answers a request for one of the colony's published files; `/` is index.html, as a web server would. */
async function serveArtifact(source: ArtifactSource, url: URL, r: HTTPRequest): Promise<void> {
  try {
    const name = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
    const file = await source.file(name.endsWith('/') ? `${name}index.html` : name)
    if (!file) {
      await r.respond({
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `no published file ${name}`,
      })
      return
    }
    const text = file.mediaType.startsWith('text/') || /json|xml|javascript/.test(file.mediaType)
    await r.respond({
      status: 200,
      contentType: text ? `${file.mediaType}; charset=utf-8` : file.mediaType,
      headers: { 'cache-control': 'no-store' },
      body: Buffer.from(file.body),
    })
  } catch {
    await r.abort('failed').catch(() => {})
  }
}

/** Makes another of the agent's pages the active one; the live view follows. */
export async function switchPage(tab: Tab, page: Page): Promise<void> {
  if (tab.page === page) return
  const streaming = tab.cdp !== undefined
  if (streaming) stopScreencast(tab)
  tab.page = page
  tab.refs = new Map()
  await page.bringToFront().catch(() => {})
  if (streaming) await startScreencast(tab)
  emit(tab, { type: 'page', url: page.url(), title: await page.title().catch(() => '') })
}

/** Opens a new page in the agent's browser and switches to it. */
export async function openPage(tab: Tab): Promise<Page> {
  const page = await tab.page.browser().newPage()
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
 * Moves the agent's real mouse to an element's centre. While someone watches, the element is highlighted and the
 * cursor glides there in visible steps; otherwise it jumps. Returns the point for the click or typing that follows.
 */
export async function pointAt(
  tab: Tab,
  handle: ElementHandle,
  action: 'click' | 'type',
  label = '',
): Promise<{ x: number; y: number }> {
  await handle.scrollIntoView().catch(() => {})
  const box = await handle.boundingBox()
  if (!box) throw new Error('that element is not visible; take a fresh browser_snapshot')
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  if (watched(tab)) {
    emit(tab, { type: 'highlight', box: { ...box, label } })
    const from = tab.cursor
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      // Ease out, so the pointer decelerates onto its target like a hand would.
      const t = 1 - (1 - i / steps) ** 3
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      await tab.page.mouse.move(p.x, p.y)
      emit(tab, { type: 'cursor', ...p, action: 'move' })
      await Bun.sleep(28)
    }
  } else await tab.page.mouse.move(to.x, to.y)
  tab.cursor = to
  emit(tab, { type: 'cursor', ...to, action })
  return to
}

/** "button: Add" for the element behind a ref, to label the highlight a watcher sees. */
export function refLabel(tab: Tab, ref: string): string {
  const node = tab.refs.get(ref)
  return node ? `${node.role}${node.name ? `: ${node.name.slice(0, 40)}` : ''}` : ''
}

/** Marks a page the browser's proxy served in place of a refused request. */
export const REFUSED_HEADER = 'x-myrmidon-refused'

/**
 * Opens `url` in one of the agent's pages, after checking the agent may reach it, and says why when the browser
 * refused it or a redirect from it (the proxy and the tab's own check refuse quietly, as a network error).
 */
export async function navigate(tab: Tab, page: Page, url: string): Promise<void> {
  const own = tab.artifacts && url.startsWith(`${tab.artifacts.origin}/`)
  if (/^https?:/i.test(url) && !own) await assertReachableUrl(url, tab.localPorts)
  const since = Date.now()
  let response: HTTPResponse | null
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (err) {
    // A tunnel can also fail because the site is down; only a refusal recorded during this navigation is ours.
    const reason = tab.refusal(since)
    if (reason && /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED/.test(String(err)))
      throw new UnreachableError(prompts.toolResults.browserBlocked(url, reason))
    throw err
  }
  if (response?.headers()[REFUSED_HEADER])
    throw new UnreachableError(prompts.toolResults.browserBlocked(url, tab.refusal(since)))
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
