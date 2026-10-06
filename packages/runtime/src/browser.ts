import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Browser, CDPSession, ElementHandle, Page, SerializedAXNode } from 'puppeteer-core'

/**
 * A real browser for agents: one headless Chrome per server process with its own throwaway profile (never the
 * person's), and one tab per agent per colony. Pages are read as accessibility snapshots with element refs,
 * the text-first model agents handle well; screenshots are there for visual checks.
 */

const SNAPSHOT_CHARS = 12_000
const LOG_LIMIT = 200

/** What a person watching an agent's tab receives. Coordinates are CSS pixels in the page viewport. */
export type LiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'cursor'; x: number; y: number; action: 'move' | 'click' | 'type' }
  | { type: 'page'; url: string; title: string }
  | { type: 'control'; by: 'agent' | 'person' }

/** Input from a person who has taken control, in CSS pixels. */
export type LiveInput =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }

interface Tab {
  readonly page: Page
  /** Element refs from the latest snapshot. */
  refs: Map<string, SerializedAXNode>
  readonly logs: string[]
  readonly watchers: Set<(e: LiveEvent) => void>
  cdp?: CDPSession
  cursor: { x: number; y: number }
  controlledBy: 'agent' | 'person'
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

  /** The agent's tab in this colony, opened on first use. */
  tab(colony: string, agent: string): Promise<Tab> {
    const key = `${colony}/${agent}`
    let tab = this._tabs.get(key)
    if (!tab) {
      tab = (async () => {
        const page = await (await this._launch()).newPage()
        const logs: string[] = []
        const log = (line: string) => {
          logs.push(line)
          if (logs.length > LOG_LIMIT) logs.shift()
        }
        page.on('console', (m) => log(`console.${m.type()}: ${m.text()}`))
        page.on('pageerror', (e) => log(`page error: ${e instanceof Error ? e.message : String(e)}`))
        page.on('requestfailed', (r) =>
          log(`request failed: ${r.url()} (${r.failure()?.errorText ?? 'unknown'})`),
        )
        page.on('response', (r) => {
          if (r.status() >= 400) log(`HTTP ${r.status()}: ${r.url()}`)
        })
        const tab: Tab = {
          page,
          refs: new Map(),
          logs,
          watchers: new Set(),
          cursor: { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 },
          controlledBy: 'agent',
        }
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame())
            void page.title().then(
              (title) => emit(tab, { type: 'page', url: page.url(), title }),
              () => {},
            )
        })
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
    if (!tab.cdp) {
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
    return () => {
      tab.watchers.delete(onEvent)
      if (tab.watchers.size > 0 || !tab.cdp) return
      const cdp = tab.cdp
      tab.cdp = undefined
      void cdp
        .send('Page.stopScreencast')
        .then(() => cdp.detach())
        .catch(() => {})
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
      await tab.then((t) => t.page.close()).catch(() => {})
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

/**
 * Moves the agent's (real) mouse to an element's centre in a few steps, so a watcher sees the cursor travel,
 * and returns that point for the click or typing that follows.
 */
export async function pointAt(
  tab: Tab,
  handle: ElementHandle,
  action: 'click' | 'type',
): Promise<{ x: number; y: number }> {
  await handle.scrollIntoView().catch(() => {})
  const box = await handle.boundingBox()
  if (!box) throw new Error('that element is not visible; take a fresh browser_snapshot')
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await tab.page.mouse.move(to.x, to.y, { steps: 8 })
  tab.cursor = to
  emit(tab, { type: 'cursor', ...to, action })
  return to
}
