import { Ellipsis, Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { useArmGuard } from '../ui/ConfirmButton.tsx'
import { anyDialogOpen } from '../ui/dialog.ts'
import { readStored, store } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { MenuItem, MenuSeparator, Popover } from '../ui/Popover.tsx'
import { isMac } from '../ui/platform.ts'
import { Button, cn, Empty, IconButton } from '../ui/primitives.tsx'
import { comboLabel, matchCombo } from '../ui/shortcuts.ts'
import {
  MAX_TERMINAL_TABS,
  TERMINAL_COMBOS,
  TERMINAL_DEFAULTS,
  TERMINAL_SCROLLBACK_CHOICES,
} from '../ui-config.ts'
import { ShellTerminal, type TerminalPrefs } from './ShellTerminal.tsx'

const t = copy.shellTerminal

/** One open terminal: its number in this chat and what it last said runs in it. */
interface Tab {
  id: number
  n: number
  /** The foreground command, or null while the shell waits at its prompt. */
  process: string | null
  /** A title the shell set, used while nothing else names the tab. */
  title?: string
}

const CURSOR_STYLES = ['block', 'bar', 'underline'] as const
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

function useTerminalPrefs(): [TerminalPrefs, (change: Partial<TerminalPrefs>) => void] {
  const [prefs, setPrefs] = useState(readPrefs)
  return [
    prefs,
    (change) => {
      setPrefs((p) => ({ ...p, ...change }))
      for (const [key, value] of Object.entries(change))
        store(
          PREF_KEYS[key as keyof TerminalPrefs],
          typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
        )
    },
  ]
}

/**
 * The workspace's Terminal view: the person's own shells as tabs, like Claude Code's terminal panel. Each tab is its
 * own shell, named by what runs in it (else the folder it started in); every tab stays alive while another shows.
 * A ⋯ menu sets how all of them look, and the view can fill the window.
 */
export function TerminalPanel(props: { project?: { id: string; name: string } }) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, n: 1, process: null }])
  const [active, setActive] = useState(1)
  const nextId = useRef(2)
  // Bumped when the shown terminal should take focus (a click or a shortcut, not arrowing along the tabs).
  const [focusRequest, setFocusRequest] = useState(0)
  const [closing, setClosing] = useState<number>()
  const [prefs, setPrefs] = useTerminalPrefs()
  const [maximized, setMaximized] = useState(false)
  const ids = useId()
  const tabId = (id: number) => `${ids}-tab-${id}`
  const panelId = (id: number) => `${ids}-panel-${id}`
  const guard = useArmGuard()
  const folder = props.project?.name ?? '~'
  const full = tabs.length >= MAX_TERMINAL_TABS
  const newCombo = isMac ? TERMINAL_COMBOS.newMac : TERMINAL_COMBOS.new

  const nameOf = (tab: Tab) => t.name(tab.n)
  const labelOf = (tab: Tab) => t.tab(tab.n, tab.process ?? tab.title ?? folder)
  const update = (id: number, change: Partial<Tab>) =>
    setTabs((list) => list.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)))
  const show = (id: number) => {
    setActive(id)
    setFocusRequest((n) => n + 1)
  }
  const add = () => {
    if (full) return
    const id = nextId.current++
    setTabs((list) => [...list, { id, n: Math.max(0, ...list.map((tab) => tab.n)) + 1, process: null }])
    setActive(id)
  }
  const remove = (id: number) => {
    setClosing(undefined)
    const at = tabs.findIndex((tab) => tab.id === id)
    const rest = tabs.filter((tab) => tab.id !== id)
    setTabs(rest)
    // The neighbour to the right takes its place, as browser tabs do; the last one's left neighbour otherwise.
    const next = rest[Math.min(at, rest.length - 1)]
    if (active === id && next) show(next.id)
  }
  // A terminal with a command still running asks first; an idle shell closes at once.
  const close = (id: number) => {
    if (tabs.find((tab) => tab.id === id)?.process === null) return remove(id)
    guard.arm()
    setClosing(id)
  }
  const step = (by: number) => {
    const at = tabs.findIndex((tab) => tab.id === active)
    const next = tabs[(at + by + tabs.length) % tabs.length]
    if (next) show(next.id)
  }

  // Along the tabs: arrows, Home and End pick a tab (focus stays on the tabs), Delete closes the focused one.
  const tabKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      return close(active)
    }
    const at = tabs.findIndex((tab) => tab.id === active)
    const to =
      e.key === 'ArrowRight'
        ? at + 1
        : e.key === 'ArrowLeft'
          ? at - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : undefined
    if (to === undefined) return
    e.preventDefault()
    const next = tabs[(to + tabs.length) % tabs.length]
    if (!next) return
    setActive(next.id)
    document.getElementById(tabId(next.id))?.focus()
  }

  // Shortcuts while focus is anywhere in the view, the shell included: caught before the shell sees the key.
  const viewKeys = (e: KeyboardEvent<HTMLElement>) => {
    const key = e.nativeEvent
    // `mod` matches Control too, and ⌃T is the shell's own (it swaps two letters), so only ⌘T opens one on a Mac.
    if (matchCombo(newCombo, key) && (!isMac || key.metaKey)) add()
    else if (matchCombo(TERMINAL_COMBOS.next, key)) step(1)
    else if (matchCombo(TERMINAL_COMBOS.previous, key)) step(-1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    if (!maximized) return
    // Escape typed into a shell is the shell's (vim, less); anywhere else in the view it restores the panel.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || anyDialogOpen()) return
      if ((e.target as Element | null)?.closest?.('[data-terminal-screen]')) return
      setMaximized(false)
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [maximized])

  const asking = tabs.find((tab) => tab.id === closing)

  return (
    <div
      onKeyDownCapture={viewKeys}
      className={cn(
        'flex min-h-0 flex-1 flex-col bg-surface',
        // Filling the window below its title bar, as a full sheet does, keeps the panel's own close button in reach.
        maximized && 'fixed inset-x-0 bottom-0 top-[52px] z-[60] border-t border-line shadow-pop',
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-2 pr-1.5">
        {tabs.length > 0 && (
          <div
            role="tablist"
            aria-label={t.tabs}
            onKeyDown={tabKeys}
            className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto"
          >
            {tabs.map((tab) => {
              const selected = tab.id === active
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  aria-selected={selected}
                  aria-controls={panelId(tab.id)}
                  aria-keyshortcuts="Delete"
                  aria-describedby={`${ids}-close-hint`}
                  tabIndex={selected ? 0 : -1}
                  title={labelOf(tab)}
                  onClick={() => show(tab.id)}
                  className={cn(
                    'group flex h-7 min-w-0 max-w-60 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-small transition-colors',
                    selected ? 'bg-fill-strong text-fg' : 'text-fg-2 hover:bg-fill hover:text-fg',
                  )}
                >
                  <span className="truncate">{labelOf(tab)}</span>
                  {/* For the pointer; keyboards close the focused tab with Delete, so this is no second Tab stop. */}
                  <span
                    aria-hidden="true"
                    title={t.close(nameOf(tab))}
                    onClick={(e) => {
                      e.stopPropagation()
                      close(tab.id)
                    }}
                    className={cn(
                      'grid size-5 shrink-0 place-items-center rounded-sm text-muted hover:bg-fill-strong hover:text-fg',
                      selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                  >
                    <X className="size-3" />
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <span id={`${ids}-close-hint`} hidden>
          {t.closeHint}
        </span>
        <IconButton
          size="sm"
          label={t.add}
          title={full ? t.full(MAX_TERMINAL_TABS) : t.addTitle(comboLabel(newCombo, isMac))}
          disabled={full}
          onClick={add}
        >
          <Plus className="size-3.5" />
        </IconButton>
        <span className="flex-1" />
        <TerminalOptions prefs={prefs} onChange={setPrefs} />
        <IconButton
          size="sm"
          label={maximized ? t.restore : t.maximize}
          onClick={() => setMaximized(!maximized)}
        >
          {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconButton>
      </div>
      {asking && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 text-small text-fg-2">
            {t.stillRunning(nameOf(asking), asking.process ?? '')}
          </span>
          <Button
            size="sm"
            variant="danger"
            autoFocus
            onKeyDown={(e) => {
              if (guard.repeat(e) || e.key !== 'Escape') return
              // Escape here only takes the question back; it must not also restore a maximized view.
              e.stopPropagation()
              setClosing(undefined)
              document.getElementById(tabId(asking.id))?.focus()
            }}
            onClick={() => {
              if (!guard.tooSoon()) remove(asking.id)
            }}
          >
            {t.confirmClose}
          </Button>
          <Button size="sm" variant="borderless" onClick={() => setClosing(undefined)}>
            {t.cancel}
          </Button>
        </div>
      )}
      {tabs.length === 0 && (
        <div className="grid min-h-0 flex-1 place-items-center">
          <Empty icon={<FEATURE_ICONS.personalShell className="size-5" />} title={t.emptyTitle}>
            <p>{t.emptyBody}</p>
            <Button className="mt-3" icon={<Plus className="size-3.5" />} onClick={add}>
              {t.add}
            </Button>
          </Empty>
        </div>
      )}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={panelId(tab.id)}
          aria-labelledby={tabId(tab.id)}
          className={tab.id === active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <ShellTerminal
            {...(props.project ? { project: props.project.id } : {})}
            active={tab.id === active}
            focusRequest={focusRequest}
            prefs={prefs}
            onProcess={(process) => update(tab.id, { process })}
            onTitle={(title) => update(tab.id, { title })}
          />
        </div>
      ))}
    </div>
  )
}

/** The ⋯ menu: cursor style, blink, copy on select and scrollback, for every terminal at once. */
function TerminalOptions(props: { prefs: TerminalPrefs; onChange(change: Partial<TerminalPrefs>): void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const { prefs, onChange } = props
  return (
    <div ref={box} className="relative">
      <IconButton
        size="sm"
        label={t.options}
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis className="size-3.5" />
      </IconButton>
      <AnimatePresence>
        {open && (
          <Popover
            role="menu"
            label={t.options}
            onClose={() => setOpen(false)}
            within={box}
            className="material-menu absolute right-0 z-40 top-[calc(100%+4px)] w-56 origin-top-right rounded-lg border border-line p-1.5"
          >
            <MenuGroup title={t.cursorStyle}>
              {CURSOR_STYLES.map((style) => (
                <MenuItem
                  key={style}
                  title={t.cursorStyles[style]}
                  checked={prefs.cursorStyle === style}
                  onSelect={() => onChange({ cursorStyle: style })}
                />
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup label={t.cursor}>
              <MenuItem
                title={t.blink}
                checkbox
                checked={prefs.cursorBlink}
                onSelect={() => onChange({ cursorBlink: !prefs.cursorBlink })}
              />
              <MenuItem
                title={t.copyOnSelect}
                checkbox
                checked={prefs.copyOnSelect}
                onSelect={() => onChange({ copyOnSelect: !prefs.copyOnSelect })}
              />
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup title={t.scrollback}>
              {TERMINAL_SCROLLBACK_CHOICES.map((lines) => (
                <MenuItem
                  key={lines}
                  title={t.lines(lines)}
                  checked={prefs.scrollback === lines}
                  onSelect={() => onChange({ scrollback: lines })}
                />
              ))}
            </MenuGroup>
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A run of a menu's items under a small heading (`title`), or named for screen readers only (`label`). */
function MenuGroup(props: { title?: string; label?: string; children: ReactNode }) {
  const id = useId()
  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu groups its items this way; fieldset is for forms
    <div role="group" {...(props.title ? { 'aria-labelledby': id } : { 'aria-label': props.label })}>
      {props.title && (
        <div id={id} className="px-2 pb-0.5 pt-1 text-caption font-semibold text-muted">
          {props.title}
        </div>
      )}
      {props.children}
    </div>
  )
}
