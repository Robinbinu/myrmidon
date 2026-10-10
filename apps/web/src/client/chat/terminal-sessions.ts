import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useSyncExternalStore } from 'react'
import { terminalSocket } from '../api.ts'
import { copy } from '../copy.ts'
import { readStored, store } from '../ui/hooks.ts'
import {
  MAX_TERMINAL_LABEL,
  MAX_TERMINAL_TABS,
  TERMINAL_DEFAULTS,
  TERMINAL_SCROLLBACK_CHOICES,
} from '../ui-config.ts'

/**
 * The person's own shells, kept here rather than in the Terminal view: the view comes and goes (another chat,
 * Settings), and a shell must outlive it, `bun run dev` included. Each project folder has its set of terminals and
 * chats without a project share one in home; a shell ends only by its tab's close, or when the page goes away.
 */

/** How every terminal looks and behaves, picked in the Terminal view's ⋯ menu. */
export interface TerminalPrefs {
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  copyOnSelect: boolean
  scrollback: number
}

export const CURSOR_STYLES = ['block', 'bar', 'underline'] as const
const PREF_KEYS = {
  cursorStyle: 'myr-terminal-cursor',
  cursorBlink: 'myr-terminal-blink',
  copyOnSelect: 'myr-terminal-copy-on-select',
  scrollback: 'myr-terminal-scrollback',
} as const

/** The ⋯ menu's choices as this browser remembers them; anything unreadable falls back to the defaults. */
function readPrefs(): TerminalPrefs {
  const style = readStored<string>(PREF_KEYS.cursorStyle, TERMINAL_DEFAULTS.cursorStyle)
  const lines = Number(readStored(PREF_KEYS.scrollback, String(TERMINAL_DEFAULTS.scrollback)))
  const flag = (key: string, fallback: boolean) => readStored(key, fallback ? '1' : '0') === '1'
  return {
    cursorStyle: CURSOR_STYLES.find((s) => s === style) ?? TERMINAL_DEFAULTS.cursorStyle,
    cursorBlink: flag(PREF_KEYS.cursorBlink, TERMINAL_DEFAULTS.cursorBlink),
    copyOnSelect: flag(PREF_KEYS.copyOnSelect, TERMINAL_DEFAULTS.copyOnSelect),
    scrollback: TERMINAL_SCROLLBACK_CHOICES.find((n) => n === lines) ?? TERMINAL_DEFAULTS.scrollback,
  }
}

// Control characters, and the invisible and direction-changing ones a title could use to pass for another name.
// Written as code points: the characters themselves are invisible in the source, which is the trouble with them.
const UNSEEN_RANGES: [number, number][] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
]
const UNSEEN = new RegExp(
  `[${UNSEEN_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
)

/** Text from a shell or a program, fit for a tab: nothing unseen, and short. */
export function plainLabel(text: string): string {
  return text.replace(UNSEEN, '').trim().slice(0, MAX_TERMINAL_LABEL)
}

/**
 * The folder a shell's title names, as zsh and bash set it by default or with oh-my-zsh ("robin@mac:~/code/app",
 * "~/code/app"): its last part, so the tab follows `cd` as Claude Code's does. Titles that name no folder (a program's
 * own) give nothing, and the tab keeps the folder it started in.
 */
export function folderOfTitle(title: string): string | undefined {
  // Shortened only once the folder is found: a long path would otherwise be cut before its last part.
  const path =
    title
      .replace(UNSEEN, '')
      .trim()
      .split(/[\s:]+/)
      .at(-1) ?? ''
  if (path !== '~' && !path.startsWith('~/') && !path.startsWith('/')) return undefined
  return plainLabel(path.replace(/\/+$/, '').split('/').at(-1) || path)
}

const listeners = new Set<() => void>()
let version = 0
function changed() {
  version += 1
  for (const l of listeners) l()
}

let prefs: TerminalPrefs | undefined
const currentPrefs = () => {
  prefs ??= readPrefs()
  return prefs
}

/** Where a terminal's screen waits while no view shows it: in the page, so it keeps its size and scrollback. */
function parking(): HTMLElement {
  const found = document.getElementById('myr-terminal-parking')
  if (found) return found
  const el = document.body.appendChild(document.createElement('div'))
  el.id = 'myr-terminal-parking'
  el.hidden = true
  return el
}

let ids = 0

/** The eight ANSI colour names, as the --term-* tokens and xterm's theme (with "bright" variants) both use them. */
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/** One shell: its xterm and its socket. */
export class TerminalSession {
  readonly id = ++ids
  /** The shell's own element; a view moves it in to show it and gives it back to the parking place after. */
  readonly screen: HTMLDivElement
  /** The foreground command, or null while the shell waits at its prompt. */
  process: string | null = null
  /** The folder the shell's title names, once it set one. */
  cwd: string | undefined
  /** Why the shell ended, once it has. */
  ended: string | undefined
  private term: Terminal | undefined
  private teardown: (() => void) | undefined

  constructor(
    readonly n: number,
    private readonly project: string | undefined,
  ) {
    this.screen = document.createElement('div')
    this.screen.dataset.terminalScreen = ''
    this.screen.className = 'h-full min-h-0 bg-surface px-2 py-1.5 text-fg'
    parking().append(this.screen)
  }

  /** Shows the shell in `slot`, starting it the first time: xterm measures its font only on screen. */
  attach(slot: HTMLElement) {
    slot.append(this.screen)
    if (!this.term) this.start()
  }

  /** Gives the screen back to the parking place, unless another view took it meanwhile. */
  detach(slot: HTMLElement) {
    if (this.screen.parentElement === slot) parking().append(this.screen)
  }

  focus() {
    this.term?.focus()
  }

  /** A new shell in the same tab, after the last one ended. */
  restart() {
    this.teardown?.()
    this.start()
    changed()
  }

  /** Ends the shell for good: its tab was closed. */
  close() {
    this.teardown?.()
    this.screen.remove()
  }

  apply(p: TerminalPrefs) {
    if (!this.term) return
    this.term.options.cursorStyle = p.cursorStyle
    this.term.options.cursorBlink = p.cursorBlink
    this.term.options.scrollback = p.scrollback
  }

  private start() {
    const el = this.screen
    this.ended = undefined
    this.process = null
    // xterm draws on a canvas, so it takes the panel's colours as values and is given them again on a theme change:
    // the surface and text, and the ANSI palette: a VS Code theme's own (--ansi-*) when one is chosen, else the
    // --term-* tokens, which keep every colour readable on Myrmidon's own looks.
    const colours = () => {
      const style = getComputedStyle(el)
      const root = getComputedStyle(document.documentElement)
      const token = (name: string) =>
        root.getPropertyValue(`--ansi-${name}`).trim() ||
        style.getPropertyValue(`--term-${name}`).trim() ||
        undefined
      const ansi = Object.fromEntries(
        ANSI.flatMap((c) => [
          [c, token(c)],
          [`bright${c[0]?.toUpperCase()}${c.slice(1)}`, token(`bright-${c}`)],
        ]).filter(([, value]) => value),
      )
      return {
        background: style.backgroundColor,
        foreground: style.color,
        cursor: style.color,
        ...ansi,
        ...(token('selection') ? { selectionBackground: token('selection') } : {}),
      }
    }
    const p = currentPrefs()
    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      cursorStyle: p.cursorStyle,
      cursorBlink: p.cursorBlink,
      scrollback: p.scrollback,
      theme: colours(),
    })
    this.term = t
    const retheme = () => {
      t.options.theme = colours()
    }
    const themed = new MutationObserver(retheme)
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    })
    const system = matchMedia('(prefers-color-scheme: dark)')
    system.addEventListener('change', retheme)
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    fit.fit()
    const ws = terminalSocket(this.project, t.cols, t.rows)
    // The shell's output comes as binary frames; the server's notes (what runs in the foreground) as JSON text.
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return t.write(new Uint8Array(e.data as ArrayBuffer))
      const note = JSON.parse(e.data) as { type?: string; name?: unknown }
      if (note.type !== 'process') return
      this.process = typeof note.name === 'string' ? plainLabel(note.name) || null : null
      changed()
    }
    ws.onclose = (e) => {
      this.ended = e.reason || copy.shellTerminal.closed
      this.process = null
      changed()
    }
    const input = t.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })
    const titled = t.onTitleChange((title) => {
      this.cwd = folderOfTitle(title)
      changed()
    })
    const selected = t.onSelectionChange(() => {
      if (!currentPrefs().copyOnSelect || !t.hasSelection()) return
      // The clipboard can refuse (no focus, no permission); the selection stays for ⌘C then.
      navigator.clipboard?.writeText(t.getSelection()).catch(() => undefined)
    })
    const resized = new ResizeObserver(() => {
      // A parked or hidden terminal measures nothing; it fits again once it shows.
      if (!el.clientWidth) return
      fit.fit()
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
    })
    resized.observe(el)
    this.teardown = () => {
      themed.disconnect()
      system.removeEventListener('change', retheme)
      resized.disconnect()
      input.dispose()
      titled.dispose()
      selected.dispose()
      // Closed on purpose: not an ending to report.
      ws.onclose = null
      ws.close()
      t.dispose()
      this.term = undefined
    }
  }
}

/** One project folder's terminals (or home's), and which one shows. */
export interface TerminalSet {
  readonly sessions: TerminalSession[]
  active: number | undefined
}

const sets = new Map<string, TerminalSet>()
const keyOf = (project: string | undefined) => (project ? `project:${project}` : 'home')

/** A project's terminals; the first look opens one, and after that an emptied set stays empty. */
export function terminalSet(project: string | undefined): TerminalSet {
  const key = keyOf(project)
  let set = sets.get(key)
  if (!set) {
    const first = new TerminalSession(1, project)
    set = { sessions: [first], active: first.id }
    sets.set(key, set)
  }
  return set
}

/** Opens another terminal in a project's set and shows it, up to the limit; the new one, if any. */
export function addTerminal(project: string | undefined): TerminalSession | undefined {
  const set = terminalSet(project)
  if (set.sessions.length >= MAX_TERMINAL_TABS) return undefined
  const n = Math.max(0, ...set.sessions.map((s) => s.n)) + 1
  const session = new TerminalSession(n, project)
  set.sessions.push(session)
  set.active = session.id
  changed()
  return session
}

/** Ends one terminal; the neighbour to its right shows in its place, as browser tabs do, else its left one. */
export function closeTerminal(project: string | undefined, id: number) {
  const set = terminalSet(project)
  const at = set.sessions.findIndex((s) => s.id === id)
  if (at === -1) return
  set.sessions.splice(at, 1)[0]?.close()
  if (set.active === id) set.active = set.sessions[Math.min(at, set.sessions.length - 1)]?.id
  changed()
}

export function showTerminal(project: string | undefined, id: number) {
  const set = terminalSet(project)
  if (set.active === id) return
  set.active = id
  changed()
}

/** Re-renders the caller whenever any terminal changes (a name, a tab, the menu's choices). */
export function useTerminals(): number {
  return useSyncExternalStore(
    (on) => {
      listeners.add(on)
      return () => listeners.delete(on)
    },
    () => version,
  )
}

export function terminalPrefs(): TerminalPrefs {
  return currentPrefs()
}

/** Changes how every open terminal looks, in every project, and remembers it in this browser. */
export function setTerminalPrefs(change: Partial<TerminalPrefs>) {
  prefs = { ...currentPrefs(), ...change }
  for (const [key, value] of Object.entries(change))
    store(
      PREF_KEYS[key as keyof TerminalPrefs],
      typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
    )
  for (const set of sets.values()) for (const s of set.sessions) s.apply(prefs)
  changed()
}
