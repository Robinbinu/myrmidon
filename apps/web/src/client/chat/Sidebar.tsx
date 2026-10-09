import {
  BarChart3,
  ChevronRight,
  CircleAlert,
  Download,
  Folder,
  FolderPlus,
  HeartPulse,
  Link,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  Sun,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react'
import { motion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ChatSummary, type Project } from '../api.ts'
import { copy } from '../copy.ts'
import { useScope } from '../DeviceGate.tsx'
import { useStatus } from '../status.tsx'
import { ChannelLogo } from '../ui/ChannelLogo.tsx'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'
import { type ThemeChoice, useUnreadChats } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Logo } from '../ui/Logo.tsx'
import { copyAction, openContextMenu } from '../ui/Menu.tsx'
import { isMac } from '../ui/platform.ts'
import { Button, CountBadge, cn, Dot, IconButton } from '../ui/primitives.tsx'
import { comboLabel, matchCombo } from '../ui/shortcuts.ts'
import { needsYou, runPhase } from '../ui/status.ts'
import { useToast } from '../ui/Toast.tsx'
import { Toolbar } from '../ui/Toolbar.tsx'
import { MESSAGE_SEARCH_DELAY_MS, spring } from '../ui-config.ts'
import { GatewaySwitcher } from './GatewaySwitcher.tsx'
import { PermissionMark } from './ProjectPermissions.tsx'

export type View = 'chat' | 'colonies' | 'compare' | 'system'

const GROUPS: { label: string; maxAgeDays: number }[] = [
  { label: copy.sidebar.groups.today, maxAgeDays: 1 },
  { label: copy.sidebar.groups.yesterday, maxAgeDays: 2 },
  { label: copy.sidebar.groups.previous7Days, maxAgeDays: 7 },
  { label: copy.sidebar.groups.older, maxAgeDays: Number.POSITIVE_INFINITY },
]

/** A chat whose messages matched the search (GET /api/chats/search). */
interface MessageHit {
  chatId: string
  from: string
  snippet: string
  /** Where the match is in the snippet; the server folds case, which can change lengths (İ), so it says. */
  match?: { start: number; end: number }
}

/** The snippet with the match in bold. */
function marked(hit: MessageHit): ReactNode {
  const m = hit.match
  if (!m) return hit.snippet
  return (
    <>
      {hit.snippet.slice(0, m.start)}
      <b className="font-semibold text-fg-2">{hit.snippet.slice(m.start, m.end)}</b>
      {hit.snippet.slice(m.end)}
    </>
  )
}

/** The chat's title or one of its requests contains `q` (lower case). */
const titled = (c: ChatSummary, q: string) =>
  c.title.toLowerCase().includes(q) || c.rounds.some((r) => r.request.toLowerCase().includes(q))

/** The one chat row the Tab key lands on: the first preferred one that is on screen, else the first row shown. */
export function tabStopRow(shown: readonly string[], preferred: readonly (string | undefined)[]) {
  return preferred.find((id) => id !== undefined && shown.includes(id)) ?? shown[0]
}

function ageDays(iso: string) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const d = new Date(iso)
  return d >= start ? 0 : Math.ceil((start.getTime() - d.getTime()) / 86_400_000)
}

export function Sidebar(props: {
  chats: ChatSummary[]
  /** The chat list has answered at least once; until then an empty list is not "no conversations". */
  loaded: boolean
  activeChat?: string
  view: View
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  onSelect(chatId: string): void
  /** One chat, or the chats selected together, in list order. */
  onDelete(chats: ChatSummary[]): void
  onRename(chat: ChatSummary, title: string): Promise<void>
  onExport?(chat: ChatSummary): void
  onNew(): void
  projects: Project[]
  onNewInProject(project: Project): void
  /** The project actions; each left out (a chats-only device) hides its control. */
  onAddProject?(): void
  onRemoveProject?(project: Project): void
  onProjectPermissions?(project: Project): void
  onView(v: View): void
  onSettings(): void
  onGateways(): void
  onCollapse(): void
}) {
  const [query, setQuery] = useState('')
  const toast = useToast()
  const { status } = useStatus()
  // System reports on this machine and points to Settings, both of which a chats-only device cannot use.
  const fullAccess = useScope() === 'full'
  const waiting = status?.waiting?.length ?? 0
  // Which chats came from a channel, for their logo; looked up again when the list of chats changes.
  const [channelOf, setChannelOf] = useState<Record<string, string>>({})
  const chatIds = props.chats.map((c) => c.chatId).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the set of chats changes
  useEffect(() => {
    api<{ chats: Record<string, string> }>('/api/channels/chats')
      .then((r) => setChannelOf(r.chats))
      // A chats-only device may not see channels; its chats simply show no logo.
      .catch(() => setChannelOf({}))
  }, [chatIds])
  const unread = useUnreadChats(
    props.chats,
    props.loaded,
    props.view === 'chat' ? props.activeChat : undefined,
  )
  const [editing, setEditing] = useState<string>()
  const [draft, setDraft] = useState('')
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const cancelled = useRef(false)
  // A rename finished from the keyboard puts focus back on its row, so the list can be walked on from there.
  const backToRow = useRef(false)
  const nav = useRef<HTMLElement>(null)
  const focusRow = (chatId: string) =>
    nav.current?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(chatId)}"]`)?.focus()
  const startRename = (c: ChatSummary) => {
    cancelled.current = false
    setEditing(c.chatId)
    setDraft(c.title)
  }
  const finishRename = (c: ChatSummary, save: boolean) => {
    setEditing(undefined)
    const next = draft.trim()
    if (save && next && next !== c.title) void props.onRename(c, next)
    if (backToRow.current) requestAnimationFrame(() => focusRow(c.chatId))
    backToRow.current = false
  }
  // Titles and requests match as the person types; what was said in a chat comes from the server a moment later.
  const [found, setFound] = useState<{ query: string; hits: ReadonlyMap<string, MessageHit> }>()
  useEffect(() => {
    const q = query.trim()
    if (!q) return setFound(undefined)
    // A newer query cancels the request for an older one.
    const abort = new AbortController()
    const timer = setTimeout(() => {
      api<MessageHit[]>(`/api/chats/search?q=${encodeURIComponent(q)}`, abort.signal)
        .then((list) => setFound({ query: q, hits: new Map(list.map((h) => [h.chatId, h])) }))
        .catch(() => {
          // Without the server's answer the list still matches titles and requests.
          if (!abort.signal.aborted) setFound({ query: q, hits: new Map() })
        })
    }, MESSAGE_SEARCH_DELAY_MS)
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [query])
  // Matches for an earlier query are not shown while the current one is on its way.
  const said = found?.query === query.trim() ? found.hits : undefined
  const searching = !!query.trim() && !said
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return props.chats.filter((c) => !q || titled(c, q) || said?.has(c.chatId))
  }, [props.chats, query, said])
  // Chats waiting on the person come first, as in Codex and Claude Code, out of their project or date group.
  const waitingOnYou = useMemo(() => hits.filter(needsYou), [hits])
  const rest = useMemo(() => hits.filter((c) => !needsYou(c)), [hits])
  // A chat whose project was removed from the list falls back to the date groups.
  const known = useMemo(() => new Set(props.projects.map((p) => p.id)), [props.projects])
  const byProject = useMemo(() => {
    const out = new Map<string, ChatSummary[]>()
    for (const c of rest) {
      if (!c.project || !known.has(c.project.id)) continue
      out.set(c.project.id, [...(out.get(c.project.id) ?? []), c])
    }
    return out
  }, [rest, known])
  const grouped = useMemo(() => {
    const out: { label: string; chats: ChatSummary[] }[] = []
    for (const c of rest) {
      if (c.project && known.has(c.project.id)) continue
      const label =
        GROUPS.find((g) => (c.updatedAt ? ageDays(c.updatedAt) : 0) < g.maxAgeDays)?.label ??
        copy.sidebar.groups.older
      const group = out.find((g) => g.label === label)
      if (group) group.chats.push(c)
      else out.push({ label, chats: [c] })
    }
    return out
  }, [rest, known])
  // The chat list is one Tab stop: the row last focused (or the open chat, or the first) takes it, and the arrow keys
  // walk the rest. Its rename and delete buttons are for the pointer; F2 and Delete do the same from the keyboard.
  const [lastRow, setLastRow] = useState<string>()
  // Only rows on screen can hold it: a chat inside a folded project has no row to Tab to.
  const shownRows = [
    ...waitingOnYou,
    ...props.projects.filter((p) => !closed.has(p.id)).flatMap((p) => byProject.get(p.id) ?? []),
    ...grouped.flatMap((g) => g.chats),
  ].map((c) => c.chatId)
  const tabRow = tabStopRow(shownRows, [lastRow, props.activeChat])
  // Chats picked together, as in a Mac list: ⌘-click toggles one, ⇧-click takes a range, ⌘A takes all shown, Esc or a
  // plain click lets go. Only rows on screen count, so a search or a folded project leaves out what it hides.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<string>(undefined)
  const picked = shownRows.filter((id) => selected.has(id))
  const pickedChats = () => picked.flatMap((id) => props.chats.find((c) => c.chatId === id) ?? [])
  const shownActive = props.view === 'chat' && props.activeChat && shownRows.includes(props.activeChat)
  const clearSelection = () => setSelected(new Set())
  const selectRange = (to: string) => {
    const from = [anchor.current, shownActive ? props.activeChat : undefined].find(
      (id) => id !== undefined && shownRows.includes(id),
    )
    const a = shownRows.indexOf(from ?? to)
    const b = shownRows.indexOf(to)
    setSelected(new Set(shownRows.slice(Math.min(a, b), Math.max(a, b) + 1)))
    anchor.current = from ?? to
  }
  const exportAll = (chats: readonly ChatSummary[]) => {
    for (const c of chats) props.onExport?.(c)
  }
  /** Rows of one heading's chats: a list the person can pick several from. */
  const rowList = (label: string, chats: readonly ChatSummary[]) =>
    chats.length > 0 && (
      <div role="listbox" aria-multiselectable="true" aria-label={label}>
        {chats.map(row)}
      </div>
    )
  const toggleSelected = (id: string) => {
    // The open chat counts as selected, as the highlighted row of a Mac list does, so ⌘-click adds to it.
    const base = picked.length || !shownActive ? picked : [props.activeChat as string]
    const next = new Set(base)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
    anchor.current = id
  }
  // A deleted chat takes its row, and the focus on it, away; the row after it (or before, at the end) takes focus.
  const afterDelete = useRef<{ chatIds: string[]; next?: string }>(undefined)
  /** Deletes the row's chat, or the whole selection when the row is part of it. */
  const requestDelete = (c: ChatSummary) => {
    const chats = picked.includes(c.chatId) ? pickedChats() : [c]
    const ids = chats.map((x) => x.chatId)
    const last = Math.max(...ids.map((id) => shownRows.indexOf(id)))
    const first = Math.min(...ids.map((id) => shownRows.indexOf(id)))
    const next = shownRows.slice(last + 1).find((id) => !ids.includes(id)) ?? shownRows[first - 1]
    afterDelete.current = { chatIds: ids, ...(next ? { next } : {}) }
    props.onDelete(chats)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list of chats changes
  useEffect(() => {
    const pending = afterDelete.current
    if (!pending || props.chats.some((c) => pending.chatIds.includes(c.chatId))) return
    afterDelete.current = undefined
    setSelected(new Set())
    const lost = !document.activeElement || document.activeElement === document.body
    if (lost && pending.next) focusRow(pending.next)
  }, [props.chats])
  const walkRows = (e: KeyboardEvent<HTMLElement>) => {
    const rows = [...(nav.current?.querySelectorAll<HTMLElement>('[data-chat]') ?? [])]
    const at = rows.indexOf(e.target as HTMLElement)
    if (at === -1) return
    if (matchCombo('mod+a', e)) {
      e.preventDefault()
      setSelected(new Set(shownRows))
      return
    }
    if (e.key === 'Escape' && picked.length) {
      // Only lets go of the selection; the page around keeps its own Escape for another press.
      e.preventDefault()
      e.stopPropagation()
      clearSelection()
      return
    }
    const next =
      e.key === 'ArrowDown'
        ? Math.min(rows.length - 1, at + 1)
        : e.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? rows.length - 1
              : undefined
    if (next === undefined) return
    e.preventDefault()
    const target = rows[next]
    target?.focus()
    // With ⇧ the selection grows from the row it started on, as in a Mac list.
    const id = target?.dataset.chat
    if (e.shiftKey && id) {
      if (!picked.length) anchor.current = rows[at]?.dataset.chat
      selectRange(id)
    }
  }
  const toggle = (id: string) =>
    setClosed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const row = (c: ChatSummary) => {
    const on = c.chatId === props.activeChat && props.view === 'chat'
    const phase = runPhase(c)
    // A chat that finished while the person was elsewhere is marked until they open it; one that needs them or failed
    // keeps its own mark.
    const dot = (phase === 'completed' || phase === 'stopped') && unread(c) ? 'unread' : phase
    // A chat found only by its messages shows the line that matched.
    const q = query.trim()
    const line = q && !titled(c, q.toLowerCase()) ? said?.get(c.chatId) : undefined
    const isSelected = selected.has(c.chatId)
    return (
      <div key={c.chatId} role="presentation" className="group relative">
        {editing === c.chatId ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: focus moves into the field the user just asked to edit
            autoFocus
            value={draft}
            maxLength={120}
            aria-label={copy.sidebar.chat.titleField}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => finishRename(c, !cancelled.current)}
            onKeyDown={(e) => {
              // Both keys leave through blur, which saves unless Escape asked to cancel.
              if (e.key === 'Escape') cancelled.current = true
              if (e.key === 'Enter' || e.key === 'Escape') {
                backToRow.current = true
                e.currentTarget.blur()
              }
            }}
            className="h-7 w-full rounded-md border border-focus bg-control px-2 text-body outline-none ring-3 ring-focus/30"
          />
        ) : (
          <button
            type="button"
            data-chat={c.chatId}
            tabIndex={c.chatId === tabRow ? 0 : -1}
            onFocus={() => setLastRow(c.chatId)}
            // ⇧-click would otherwise select the text of every row it spans.
            onMouseDown={(e) => e.shiftKey && e.preventDefault()}
            onClick={(e) => {
              if (e.shiftKey) return selectRange(c.chatId)
              if (isMac ? e.metaKey : e.ctrlKey) return toggleSelected(c.chatId)
              clearSelection()
              anchor.current = c.chatId
              props.onSelect(c.chatId)
            }}
            onDoubleClick={() => startRename(c)}
            onContextMenu={(e) => {
              const m = copy.contextMenu.chat
              if (picked.length > 1 && isSelected) {
                const s = copy.sidebar.selection
                const chats = pickedChats()
                return openContextMenu(e, s.count(chats.length), [
                  props.onExport && {
                    label: s.export(chats.length),
                    icon: Download,
                    run: () => exportAll(chats),
                  },
                  {
                    label: s.delete(chats.length),
                    icon: Trash2,
                    destructive: true,
                    run: () => requestDelete(c),
                  },
                ])
              }
              const link = new URL(location.pathname, location.origin)
              link.searchParams.set('chat', c.chatId)
              openContextMenu(e, m.label(c.title), [
                { label: m.rename, icon: Pencil, combo: 'f2', run: () => startRename(c) },
                props.onExport && { label: m.export, icon: Download, run: () => props.onExport?.(c) },
                { ...copyAction(m.copyLink, link.href, () => toast(m.linkCopied, 'success')), icon: Link },
                { label: m.delete, icon: Trash2, destructive: true, run: () => requestDelete(c) },
              ])
            }}
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                e.preventDefault()
                startRename(c)
              } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
                e.preventDefault()
                requestDelete(c)
              } else if (e.key === ' ' && (isMac ? e.metaKey : e.ctrlKey)) {
                // ⌘Space picks the focused row from the keyboard; Space alone opens it, as Enter does.
                e.preventDefault()
                toggleSelected(c.chatId)
              }
            }}
            aria-keyshortcuts="F2 Delete Meta+Backspace"
            title={c.title}
            aria-current={on ? 'page' : undefined}
            role="option"
            aria-selected={isSelected}
            className={cn(
              'relative flex w-full items-center gap-2 rounded-md pl-2 pr-14 text-left text-body transition-colors',
              line ? 'flex-wrap gap-y-0 py-1' : 'h-7',
              isSelected && 'bg-row-selected',
              on || isSelected ? 'text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
            )}
          >
            {on && !picked.length && (
              <motion.span
                layoutId="chat-active"
                transition={spring}
                className="absolute inset-0 rounded-md bg-row-selected"
              />
            )}
            <span className="relative flex min-w-0 flex-1 items-center gap-2">
              <Dot status={dot} />
              {channelOf[c.chatId] && (
                <ChannelLogo id={channelOf[c.chatId] ?? ''} size={15} className="relative" />
              )}
              <span className="truncate">{c.title}</span>
              <span className="sr-only">{copy.status.spoken(copy.status.run[dot])}</span>
              {c.rounds.length > 1 && (
                <span
                  className="ml-auto text-caption tabular-nums text-muted"
                  title={copy.sidebar.chat.rounds(c.rounds.length)}
                >
                  <span aria-hidden="true">{c.rounds.length}</span>
                  <span className="sr-only">{copy.sidebar.chat.rounds(c.rounds.length)}</span>
                </span>
              )}
            </span>
            {line && (
              <span className="relative basis-full truncate pl-4 text-footnote text-muted">
                {copy.sidebar.chat.matchFrom(line.from)}
                {marked(line)}
              </span>
            )}
          </button>
        )}
        {/* The listbox may own only its options, so these pointer shortcuts stay out of the accessibility tree: F2,
            Delete and the context menu (named in the row's aria-keyshortcuts) do the same from the keyboard. */}
        {editing !== c.chatId && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => startRename(c)}
            aria-label={copy.sidebar.chat.renameLabel(c.title)}
            title={copy.sidebar.chat.rename}
            className="absolute right-7 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          hidden={editing === c.chatId}
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => requestDelete(c)}
          aria-label={copy.sidebar.chat.deleteLabel(c.title)}
          title={copy.sidebar.chat.delete}
          className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-bad-soft hover:text-bad-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    )
  }

  const ThemeIcon = props.theme === 'dark' ? Moon : props.theme === 'light' ? Sun : Monitor
  const nextTheme: ThemeChoice =
    props.theme === 'system' ? 'light' : props.theme === 'light' ? 'dark' : 'system'
  const navItem = (on: boolean) =>
    cn(
      'flex h-7 w-full items-center gap-2 rounded-md px-2 text-body transition-colors',
      on ? 'bg-row-selected text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
    )

  return (
    <aside
      className="material-sidebar flex h-full w-full flex-col border-r border-line"
      aria-label={copy.sidebar.label}
    >
      <Toolbar inset material={false} className="border-b-0">
        <span className="hidden items-center gap-2 pl-1 text-body font-semibold tracking-[-0.01em] browser:flex">
          <Logo size={20} />
          {copy.brand.name}
        </span>
        <span className="flex-1" />
        <IconButton
          label={copy.sidebar.hide}
          title={copy.sidebar.withShortcut(copy.sidebar.hide, comboLabel('mod+b', isMac))}
          onClick={props.onCollapse}
        >
          <PanelLeft className="size-4" />
        </IconButton>
        <IconButton
          label={copy.sidebar.newTask}
          title={copy.sidebar.withShortcut(copy.sidebar.newTask, comboLabel('mod+n', isMac))}
          onClick={props.onNew}
        >
          <SquarePen className="size-4" />
        </IconButton>
      </Toolbar>
      <GatewaySwitcher onManage={props.onGateways} />
      <div className="px-2.5 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            placeholder={copy.sidebar.search.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={copy.sidebar.search.label}
            className="h-7 w-full rounded-md bg-fill-strong/60 pl-7 pr-2 text-body outline-none placeholder:text-muted focus:ring-3 focus:ring-focus/30"
          />
        </div>
      </div>
      <nav ref={nav} onKeyDown={walkRows} className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">
        {waitingOnYou.length > 0 && (
          <div>
            <div className="px-2 pb-1 pt-3 text-caption font-semibold text-muted">
              {copy.sidebar.groups.needsYou}
            </div>
            {rowList(copy.sidebar.groups.needsYou, waitingOnYou)}
          </div>
        )}
        {(props.projects.length > 0 || props.onAddProject) && (
          <div className="group/projects flex items-center px-2 pb-1 pt-3">
            <span className="flex-1 text-caption font-semibold text-muted">
              {copy.sidebar.projects.heading}
            </span>
            {props.onAddProject && (
              <button
                type="button"
                onClick={props.onAddProject}
                aria-label={copy.sidebar.projects.add}
                title={copy.sidebar.projects.add}
                className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-fill-strong hover:text-fg"
              >
                <FolderPlus className="size-3.5" />
              </button>
            )}
          </div>
        )}
        {props.projects.length === 0 && props.onAddProject && (
          <button
            type="button"
            onClick={props.onAddProject}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-callout text-muted hover:bg-fill/70 hover:text-fg"
          >
            <Folder className="size-4" /> {copy.sidebar.projects.empty}
          </button>
        )}
        {props.projects.map((p) => {
          const open = !closed.has(p.id)
          const chats = byProject.get(p.id) ?? []
          return (
            <div key={p.id}>
              <div className="group relative">
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  onContextMenu={(e) => {
                    const m = copy.contextMenu.project
                    openContextMenu(e, m.label(p.name), [
                      { label: m.newChat, icon: Plus, run: () => props.onNewInProject(p) },
                      props.onProjectPermissions && {
                        label: m.permissions,
                        icon: FEATURE_ICONS.permissions,
                        run: () => props.onProjectPermissions?.(p),
                      },
                      copyAction(m.copyPath, p.path, () => toast(m.pathCopied, 'success')),
                    ])
                  }}
                  aria-expanded={open}
                  title={p.path}
                  className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1 pr-20 text-left text-body text-fg-2 transition-colors hover:bg-fill/70 hover:text-fg"
                >
                  <ChevronRight
                    className={cn('size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')}
                  />
                  <Folder className="size-4 shrink-0 text-muted" />
                  <span className="truncate">{p.name}</span>
                  <PermissionMark preset={p.permissions?.preset} />
                </button>
                {props.onProjectPermissions && (
                  <button
                    type="button"
                    onClick={() => props.onProjectPermissions?.(p)}
                    aria-label={copy.sidebar.projects.permissionsLabel(p.name)}
                    title={copy.sidebar.projects.permissionsTitle}
                    className="absolute right-[3.25rem] top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-has-[[data-armed]]:invisible"
                  >
                    <FEATURE_ICONS.permissions className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => props.onNewInProject(p)}
                  aria-label={copy.sidebar.projects.newChatIn(p.name)}
                  title={copy.sidebar.projects.newChatIn(p.name)}
                  className="absolute right-7 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-has-[[data-armed]]:invisible"
                >
                  <Plus className="size-3.5" />
                </button>
                {props.onRemoveProject && (
                  // Visible while armed too: the armed button holds focus, and the row's other buttons make room.
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <ConfirmButton
                      icon={<X className="size-3.5" />}
                      label={copy.sidebar.projects.removeLabel(p.name)}
                      title={copy.sidebar.projects.removeTitle}
                      confirm={copy.sidebar.projects.removeConfirm}
                      onConfirm={() => props.onRemoveProject?.(p)}
                    />
                  </span>
                )}
              </div>
              {open && (
                <div className="pl-5">
                  {rowList(p.name, chats)}
                  {chats.length === 0 && (
                    <p className="px-2 py-1 text-small text-muted">{copy.sidebar.projects.noChats}</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {props.loaded && props.chats.length === 0 && (
          <p className="px-2 py-4 text-callout text-muted">
            {copy.sidebar.empty(comboLabel('mod+n', isMac))}
          </p>
        )}
        {props.chats.length > 0 && hits.length === 0 && (
          <p className="px-2 py-4 text-callout text-muted">
            {searching ? copy.sidebar.searchingMessages : copy.sidebar.noMatches(query)}
          </p>
        )}
        {grouped.map((g) => (
          <div key={g.label}>
            <div className="px-2 pb-1 pt-4 text-caption font-semibold text-muted">{g.label}</div>
            {rowList(g.label, g.chats)}
          </div>
        ))}
      </nav>
      {picked.length > 0 && (
        <div
          role="toolbar"
          aria-label={copy.sidebar.selection.label}
          className="mx-2.5 mb-1.5 flex items-center gap-1 rounded-base border border-line bg-fill/60 py-1 pl-2.5 pr-1"
        >
          <span className="flex-1 whitespace-nowrap text-callout font-medium text-fg-2" aria-live="polite">
            {copy.sidebar.selection.count(picked.length)}
          </span>
          {props.onExport && (
            <IconButton
              size="sm"
              label={copy.sidebar.selection.export(picked.length)}
              title={copy.sidebar.selection.export(picked.length)}
              onClick={() => exportAll(pickedChats())}
            >
              <Download className="size-3.5" />
            </IconButton>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              const first = pickedChats()[0]
              if (first) requestDelete(first)
            }}
          >
            {copy.sidebar.selection.delete(picked.length)}
          </Button>
          <IconButton
            size="sm"
            label={copy.sidebar.selection.clear}
            title={copy.sidebar.selection.clearTitle(comboLabel('escape', isMac))}
            onClick={clearSelection}
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}
      <GatewayChip {...(fullAccess ? { onOpen: () => props.onView('system') } : {})} />
      <div className="grid gap-px border-t border-line p-2.5">
        <button
          type="button"
          className={navItem(props.view === 'colonies')}
          onClick={() => props.onView('colonies')}
        >
          <Network className="size-4" /> {copy.sidebar.nav.crews}
        </button>
        <button
          type="button"
          className={navItem(props.view === 'compare')}
          onClick={() => props.onView('compare')}
        >
          <BarChart3 className="size-4" /> {copy.sidebar.nav.compare}
        </button>
        {fullAccess && (
          <button
            type="button"
            className={navItem(props.view === 'system')}
            onClick={() => props.onView('system')}
          >
            <HeartPulse className="size-4" /> {copy.system.nav}
          </button>
        )}
        <div className="flex items-center gap-1">
          <button type="button" className={navItem(false)} onClick={props.onSettings}>
            <Settings className="size-4" /> {copy.sidebar.nav.settings}
            {waiting > 0 && (
              <CountBadge
                count={waiting}
                tone="accent"
                label={copy.settings.channels.waitingBadge(waiting)}
                className="ml-auto"
              />
            )}
          </button>
          <IconButton
            label={copy.sidebar.theme(props.theme, nextTheme)}
            onClick={() => props.onTheme(nextTheme)}
          >
            <motion.span
              key={props.theme}
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              transition={spring}
            >
              <ThemeIcon className="size-4" />
            </motion.span>
          </IconButton>
        </div>
      </div>
    </aside>
  )
}

/**
 * The gateway indicator, OpenClaw-style: nothing while all is well. Unreachable, a chip that retries at once; a
 * problem (a channel down, no model can answer), a chip naming it that opens System.
 */
function GatewayChip(props: { onOpen?(): void }) {
  const t = copy.gatewayStatus
  const { status, offline, refresh } = useStatus()
  const problems = status?.problems ?? []
  if (!offline && !problems.length) return null
  const first = problems[0]
  const label = offline ? t.offline : first?.kind === 'channel' ? t.channelDown(first.label) : t.noModels
  return (
    <div className="px-2.5 pb-1.5" role="status" aria-live="polite">
      <button
        type="button"
        onClick={offline ? refresh : props.onOpen}
        title={offline ? t.offlineHint : props.onOpen ? t.open : undefined}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-base px-2.5 text-callout font-medium transition-colors',
          offline
            ? 'bg-bad-soft text-bad-ink hover:bg-bad-soft/80'
            : 'bg-warn-soft text-warn-ink hover:bg-warn-soft/80',
        )}
      >
        {offline ? <WifiOff className="size-3.5 shrink-0" /> : <CircleAlert className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {offline ? (
          <span className="shrink-0">{t.retry}</span>
        ) : (
          problems.length > 1 && <span className="shrink-0 opacity-80">{t.more(problems.length - 1)}</span>
        )}
      </button>
    </div>
  )
}
