import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Browser,
  CDPSession,
  ElementHandle,
  HTTPRequest,
  HTTPResponse,
  Page,
  SerializedAXNode,
} from 'puppeteer-core'

/**
 * A real browser for agents: one headless Chrome per server process with its own throwaway profile (never the
 * person's), and one tab per agent per colony. Pages are read as accessibility snapshots with element refs,
 * the text-first model agents handle well; screenshots are there for visual checks.
 */

const SNAPSHOT_CHARS = 12_000
const LOG_LIMIT = 200
const NETWORK_LIMIT = 300
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
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
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

const VIEWPORT = { width: 1280, height: 800 }

/** Chrome, Chromium, or the Chromium omp downloaded, whichever is installed. */
export function findChrome(): string | undefined {
  const fixed = [
    process.env.MYR_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const p of fixed) if (p && existsSync(p)) return p
  const managed = join(homedir(), '.omp', 'puppeteer', 'chrome')
  if (!existsSync(managed)) return undefined
  for (const build of readdirSync(managed).sort().reverse()) {
    const candidates = [
      join(
        managed,
        build,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ),
      join(
        managed,
        build,
        'chrome-mac-x64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ),
      join(managed, build, 'chrome-linux64', 'chrome'),
    ]
    const found = candidates.find((c) => existsSync(c))
    if (found) return found
  }
  return undefined
}

export class BrowserHub {
  private _browser?: Promise<Browser>
  private readonly _tabs = new Map<string, Promise<Tab>>()

  constructor(
    private readonly profileDir: string,
    private readonly executable = findChrome(),
  ) {}

  get available(): boolean {
    return this.executable !== undefined
  }

  private _launch(): Promise<Browser> {
    if (!this.executable) throw new Error('no Chrome or Chromium found; install Chrome or set MYR_CHROME')
    this._browser ??= (async () => {
      const { launch } = await import('puppeteer-core')
      mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })
      const browser = await launch({
        executablePath: this.executable,
        headless: true,
        userDataDir: this.profileDir,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
        defaultViewport: VIEWPORT,
      })
      browser.once('disconnected', () => {
        this._browser = undefined
        this._tabs.clear()
      })
      return browser
    })()
    return this._browser
  }

  /**
   * The agent's browser in this colony, opened on first use. It can hold several pages (links that open a new
   * window are followed); `downloads` is the folder its downloads land in.
   */
  tab(colony: string, agent: string, options: { downloads?: string } = {}): Promise<Tab> {
    const key = `${colony}/${agent}`
    let tab = this._tabs.get(key)
    if (!tab) {
      tab = (async () => {
        const page = await (await this._launch()).newPage()
        const tab: Tab = {
          page,
          pages: [],
          ...(options.downloads ? { downloads: options.downloads } : {}),
          refs: new Map(),
          logs: [],
          network: [],
          watchers: new Set(),
          cursor: { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 },
          controlledBy: 'agent',
        }
        await adopt(tab, page)
        return tab
      })()
      this._tabs.set(key, tab)
      tab.catch(() => this._tabs.delete(key))
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
    const { mouse, keyboard } = tab.page
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
      case 'navigate':
        if (!/^https?:\/\//.test(e.url)) throw new Error('only http(s) URLs')
        await tab.page.goto(e.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
  }

  /** Closes every tab a colony opened. */
  async closeColony(colony: string): Promise<void> {
    const prefix = `${colony}/`
    const tabs = [...this._tabs.entries()].filter(([k]) => k.startsWith(prefix))
    for (const [key, tab] of tabs) {
      this._tabs.delete(key)
      await tab.then((t) => Promise.all(t.pages.map((p) => p.close().catch(() => {})))).catch(() => {})
    }
  }

  async close(): Promise<void> {
    const browser = this._browser
    this._browser = undefined
    this._tabs.clear()
    await (await browser?.catch(() => undefined))?.close()
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
    ? `${text.slice(0, SNAPSHOT_CHARS)}\n… (snapshot cut; scroll or use browser_eval to read a specific part)`
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

/** Wires a page into an agent's browser: its logs, live-view page events, popups, and downloads. */
async function adopt(tab: Tab, page: Page): Promise<void> {
  const log = (line: string) => {
    tab.logs.push(line)
    if (tab.logs.length > LOG_LIMIT) tab.logs.shift()
  }
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
    if (tab.network.length > NETWORK_LIMIT) tab.network.shift()
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
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
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
