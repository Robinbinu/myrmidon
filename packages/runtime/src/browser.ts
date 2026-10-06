import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Browser, ElementHandle, Page, SerializedAXNode } from 'puppeteer-core'

/**
 * A real browser for agents: one headless Chrome per server process with its own throwaway profile (never the
 * person's), and one tab per agent per colony. Pages are read as accessibility snapshots with element refs,
 * the text-first model agents handle well; screenshots are there for visual checks.
 */

const SNAPSHOT_CHARS = 12_000
const LOG_LIMIT = 200

interface Tab {
  readonly page: Page
  /** Element refs from the latest snapshot. */
  refs: Map<string, SerializedAXNode>
  readonly logs: string[]
}

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
        defaultViewport: { width: 1280, height: 800 },
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
        return { page, refs: new Map(), logs }
      })()
      this._tabs.set(key, tab)
      tab.catch(() => this._tabs.delete(key))
    }
    return tab
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
