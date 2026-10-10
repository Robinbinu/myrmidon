import { Ellipsis, Maximize2, Minimize2, Plus, RotateCcw, X } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { useArmGuard } from '../ui/ConfirmButton.tsx'
import { anyDialogOpen } from '../ui/dialog.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { MenuItem, MenuSeparator, Popover } from '../ui/Popover.tsx'
import { isMac } from '../ui/platform.ts'
import { Button, cn, Empty, IconButton } from '../ui/primitives.tsx'
import { comboLabel, matchCombo } from '../ui/shortcuts.ts'
import { MAX_TERMINAL_TABS, TERMINAL_COMBOS, TERMINAL_SCROLLBACK_CHOICES } from '../ui-config.ts'
import {
  addTerminal,
  CURSOR_STYLES,
  closeTerminal,
  setTerminalPrefs,
  showTerminal,
  type TerminalPrefs,
  type TerminalSession,
  terminalPrefs,
  terminalSet,
  useTerminals,
} from './terminal-sessions.ts'

const t = copy.shellTerminal

/**
 * The workspace's Terminal view: the project's shells as tabs, like Claude Code's terminal panel. Each tab is its own
 * shell, named by what runs in it (else the folder it is in). The shells live in terminal-sessions.ts, so they keep
 * running while another tab, view, chat or Settings shows. A ⋯ menu sets how all of them look, and the view can fill
 * the window.
 */
export function TerminalPanel(props: { project?: { id: string; name: string } }) {
  useTerminals()
  const project = props.project?.id
  const set = terminalSet(project)
  const tabs = set.sessions
  const active = set.active
  // The terminal to give focus to once it shows: the shown one as the view opens, then the one a click or a shortcut
  // picks (not arrowing along the tabs).
  const focusNext = useRef(active)
  const [closing, setClosing] = useState<number>()
  const [maximized, setMaximized] = useState(false)
  const ids = useId()
  const tabId = (id: number) => `${ids}-tab-${id}`
  const panelId = (id: number) => `${ids}-panel-${id}`
  const guard = useArmGuard()
  const folder = props.project?.name ?? '~'
  const full = tabs.length >= MAX_TERMINAL_TABS
  const newCombo = isMac ? TERMINAL_COMBOS.newMac : TERMINAL_COMBOS.new

  const nameOf = (tab: TerminalSession) => t.name(tab.n)
  const whatOf = (tab: TerminalSession) => tab.process ?? tab.cwd ?? folder
  const labelOf = (tab: TerminalSession) => t.tab(tab.n, whatOf(tab))
  const show = (id: number) => {
    showTerminal(project, id)
    focusNext.current = id
  }
  const add = () => {
    const added = addTerminal(project)
    if (added) focusNext.current = added.id
  }
  const remove = (id: number) => {
    setClosing(undefined)
    closeTerminal(project, id)
    if (terminalSet(project).active !== undefined) focusNext.current = terminalSet(project).active
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

  // After the shown terminal is on screen (and started, if new): the slots attach in their effects, before this one.
  useEffect(() => {
    const id = focusNext.current
    if (id === undefined) return
    focusNext.current = undefined
    tabs.find((tab) => tab.id === id)?.focus()
  })

  const asking = tabs.find((tab) => tab.id === closing)
  // The command ended (or the tab went) while the question showed: there is nothing left to ask about.
  useEffect(() => {
    if (closing !== undefined && asking?.process == null) setClosing(undefined)
  }, [closing, asking?.process])

  // Along the tabs: arrows, Home and End pick a tab (focus stays on the tabs), Delete closes the focused one.
  const tabKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (active !== undefined) close(active)
      return
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
    showTerminal(project, next.id)
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

  return (
    <div
      onKeyDownCapture={viewKeys}
      className={cn(
        'flex min-h-0 flex-1 flex-col bg-surface',
        // Filling the window below its title bar, as a full sheet does, keeps the panel's own close button in reach.
        maximized && 'fixed inset-x-0 bottom-0 top-[52px] z-[60] border-t border-line shadow-pop',
      )}
    >
      <div className="@container flex h-9 shrink-0 items-center gap-1 border-b border-line pl-2 pr-1.5">
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
                  aria-label={labelOf(tab)}
                  aria-selected={selected}
                  aria-controls={panelId(tab.id)}
                  aria-keyshortcuts="Delete Backspace"
                  aria-describedby={`${ids}-close-hint`}
                  tabIndex={selected ? 0 : -1}
                  title={labelOf(tab)}
                  onClick={() => show(tab.id)}
                  className={cn(
                    'group flex h-7 min-w-24 max-w-60 shrink items-center gap-1 rounded-md pl-2.5 pr-0.5 text-small transition-colors',
                    selected ? 'bg-fill-strong text-fg' : 'text-fg-2 hover:bg-fill hover:text-fg',
                  )}
                >
                  <span className="truncate">
                    {/* A narrow panel with several tabs keeps room for what runs; the name stays in the tooltip. */}
                    <span className={cn(tabs.length > 1 && 'hidden @2xl:inline')}>{t.tabPrefix(tab.n)}</span>
                    {whatOf(tab)}
                  </span>
                  {/* For the pointer; keyboards close the focused tab with Delete, so this is no second Tab stop. */}
                  <span
                    aria-hidden="true"
                    title={t.close(nameOf(tab))}
                    onClick={(e) => {
                      e.stopPropagation()
                      close(tab.id)
                    }}
                    className={cn(
                      'grid size-6 shrink-0 place-items-center rounded-sm text-muted hover:bg-fill-strong hover:text-fg',
                      // Hidden, it takes no clicks; the shown tab always has it, as touch screens cannot hover.
                      selected
                        ? 'opacity-100'
                        : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
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
        <TerminalOptions prefs={terminalPrefs()} onChange={setTerminalPrefs} />
        <IconButton
          size="sm"
          label={maximized ? t.restore : t.maximize}
          onClick={() => setMaximized(!maximized)}
        >
          {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconButton>
      </div>
      {asking?.process && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 text-small text-fg-2">
            {t.stillRunning(nameOf(asking), asking.process)}
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
          <TerminalSlot session={tab} />
        </div>
      ))}
    </div>
  )
}

/** Where one shell shows: its screen moves in while the slot is on the page and back to waiting after. */
function TerminalSlot(props: { session: TerminalSession }) {
  const slot = useRef<HTMLDivElement>(null)
  const { session } = props
  useEffect(() => {
    const el = slot.current
    if (!el) return
    session.attach(el)
    return () => session.detach(el)
  }, [session])
  return (
    <div className="flex h-full min-h-0 flex-col">
      {session.ended && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-footnote text-muted">
          <span role="status" className="min-w-0 flex-1 truncate" title={session.ended}>
            {session.ended}
          </span>
          <Button
            size="sm"
            variant="borderless"
            onClick={() => session.restart()}
            icon={<RotateCcw className="size-3.5" />}
          >
            {t.newShell}
          </Button>
        </div>
      )}
      <div ref={slot} className="min-h-0 flex-1" />
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
