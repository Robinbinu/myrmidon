import {
  BarChart3,
  ChevronRight,
  Folder,
  FolderPlus,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useRef, useState } from 'react'
import type { ChatSummary, Project } from '../api.ts'
import { copy } from '../copy.ts'
import type { ThemeChoice } from '../ui/hooks.ts'
import { Logo } from '../ui/Logo.tsx'
import { isMac } from '../ui/platform.ts'
import { cn, Dot, IconButton } from '../ui/primitives.tsx'
import { comboLabel } from '../ui/shortcuts.ts'
import { Toolbar } from '../ui/Toolbar.tsx'
import { spring } from '../ui-config.ts'
import { PermissionMark } from './ProjectPermissions.tsx'

export type View = 'chat' | 'colonies' | 'compare'

const GROUPS: { label: string; maxAgeDays: number }[] = [
  { label: copy.sidebar.groups.today, maxAgeDays: 1 },
  { label: copy.sidebar.groups.yesterday, maxAgeDays: 2 },
  { label: copy.sidebar.groups.previous7Days, maxAgeDays: 7 },
  { label: copy.sidebar.groups.older, maxAgeDays: Number.POSITIVE_INFINITY },
]

function ageDays(iso: string) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const d = new Date(iso)
  return d >= start ? 0 : Math.ceil((start.getTime() - d.getTime()) / 86_400_000)
}

export function Sidebar(props: {
  chats: ChatSummary[]
  activeChat?: string
  view: View
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  onSelect(chatId: string): void
  onDelete(chat: ChatSummary): void
  onRename(chat: ChatSummary, title: string): Promise<void>
  onNew(): void
  projects: Project[]
  onNewInProject(project: Project): void
  onAddProject(): void
  onRemoveProject(project: Project): void
  onProjectPermissions(project: Project): void
  onView(v: View): void
  onSettings(): void
  onCollapse(): void
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string>()
  const [draft, setDraft] = useState('')
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const cancelled = useRef(false)
  const startRename = (c: ChatSummary) => {
    cancelled.current = false
    setEditing(c.chatId)
    setDraft(c.title)
  }
  const finishRename = (c: ChatSummary, save: boolean) => {
    setEditing(undefined)
    const next = draft.trim()
    if (save && next && next !== c.title) void props.onRename(c, next)
  }
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return props.chats.filter(
      (c) =>
        !q || c.title.toLowerCase().includes(q) || c.rounds.some((r) => r.request.toLowerCase().includes(q)),
    )
  }, [props.chats, query])
  // A chat whose project was removed from the list falls back to the date groups.
  const known = useMemo(() => new Set(props.projects.map((p) => p.id)), [props.projects])
  const byProject = useMemo(() => {
    const out = new Map<string, ChatSummary[]>()
    for (const c of hits) {
      if (!c.project || !known.has(c.project.id)) continue
      out.set(c.project.id, [...(out.get(c.project.id) ?? []), c])
    }
    return out
  }, [hits, known])
  const grouped = useMemo(() => {
    const out: { label: string; chats: ChatSummary[] }[] = []
    for (const c of hits) {
      if (c.project && known.has(c.project.id)) continue
      const label =
        GROUPS.find((g) => (c.updatedAt ? ageDays(c.updatedAt) : 0) < g.maxAgeDays)?.label ??
        copy.sidebar.groups.older
      const group = out.find((g) => g.label === label)
      if (group) group.chats.push(c)
      else out.push({ label, chats: [c] })
    }
    return out
  }, [hits, known])
  const toggle = (id: string) =>
    setClosed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const row = (c: ChatSummary) => {
    const on = c.chatId === props.activeChat && props.view === 'chat'
    return (
      <div key={c.chatId} className="group relative">
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
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
            className="h-7 w-full rounded-md border border-focus bg-control px-2 text-[13px] outline-none ring-3 ring-focus/30"
          />
        ) : (
          <button
            type="button"
            onClick={() => props.onSelect(c.chatId)}
            onDoubleClick={() => startRename(c)}
            title={c.title}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'relative flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-14 text-left text-[13px] transition-colors',
              on ? 'text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
            )}
          >
            {on && (
              <motion.span
                layoutId="chat-active"
                transition={spring}
                className="absolute inset-0 rounded-md bg-row-selected"
              />
            )}
            <span className="relative flex min-w-0 flex-1 items-center gap-2">
              <Dot status={c.status === 'running' || c.status === 'created' ? 'working' : c.status} />
              <span className="truncate">{c.title}</span>
              {c.rounds.length > 1 && (
                <span className="ml-auto text-[11px] tabular-nums text-muted">{c.rounds.length}</span>
              )}
            </span>
          </button>
        )}
        {editing !== c.chatId && (
          <button
            type="button"
            onClick={() => startRename(c)}
            aria-label={copy.sidebar.chat.renameLabel(c.title)}
            title={copy.sidebar.chat.rename}
            className="absolute right-7 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          hidden={editing === c.chatId}
          onClick={() => props.onDelete(c)}
          aria-label={copy.sidebar.chat.deleteLabel(c.title)}
          title={copy.sidebar.chat.delete}
          className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-bad-soft hover:text-bad-ink focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
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
      'flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
      on ? 'bg-row-selected text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
    )

  return (
    <aside
      className="material-sidebar flex h-full w-full flex-col border-r border-line"
      aria-label={copy.sidebar.label}
    >
      <Toolbar inset material={false} className="border-b-0">
        <span className="hidden items-center gap-2 pl-1 text-[13px] font-semibold tracking-[-0.01em] browser:flex">
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
      <div className="px-2.5 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            placeholder={copy.sidebar.search.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={copy.sidebar.search.label}
            className="h-7 w-full rounded-md bg-fill-strong/60 pl-7 pr-2 text-[13px] outline-none placeholder:text-muted focus:ring-3 focus:ring-focus/30"
          />
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">
        <div className="group/projects flex items-center px-2 pb-1 pt-3">
          <span className="flex-1 text-[11px] font-semibold text-muted">{copy.sidebar.projects.heading}</span>
          <button
            type="button"
            onClick={props.onAddProject}
            aria-label={copy.sidebar.projects.add}
            title={copy.sidebar.projects.add}
            className="grid size-5 place-items-center rounded-md text-muted transition-colors hover:bg-fill-strong hover:text-fg"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </div>
        {props.projects.length === 0 && (
          <button
            type="button"
            onClick={props.onAddProject}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted hover:bg-fill/70 hover:text-fg"
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
                  aria-expanded={open}
                  title={p.path}
                  className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1 pr-20 text-left text-[13px] text-fg-2 transition-colors hover:bg-fill/70 hover:text-fg"
                >
                  <ChevronRight
                    className={cn('size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')}
                  />
                  <Folder className="size-4 shrink-0 text-muted" />
                  <span className="truncate">{p.name}</span>
                  <PermissionMark {...(p.permissions ? { mode: p.permissions.mode } : {})} />
                </button>
                <button
                  type="button"
                  onClick={() => props.onProjectPermissions(p)}
                  aria-label={copy.sidebar.projects.permissionsLabel(p.name)}
                  title={copy.sidebar.projects.permissionsTitle}
                  className="absolute right-[3.25rem] top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <ShieldCheck className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => props.onNewInProject(p)}
                  aria-label={copy.sidebar.projects.newChatIn(p.name)}
                  title={copy.sidebar.projects.newChatIn(p.name)}
                  className="absolute right-7 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Plus className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => props.onRemoveProject(p)}
                  aria-label={copy.sidebar.projects.removeLabel(p.name)}
                  title={copy.sidebar.projects.removeTitle}
                  className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {open && (
                <div className="pl-5">
                  {chats.map(row)}
                  {chats.length === 0 && (
                    <p className="px-2 py-1 text-[12px] text-muted">{copy.sidebar.projects.noChats}</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {props.chats.length === 0 && (
          <p className="px-2 py-4 text-[12.5px] text-muted">{copy.sidebar.empty}</p>
        )}
        {props.chats.length > 0 && hits.length === 0 && (
          <p className="px-2 py-4 text-[12.5px] text-muted">{copy.sidebar.noMatches(query)}</p>
        )}
        {grouped.map((g) => (
          <div key={g.label}>
            <div className="px-2 pb-1 pt-4 text-[11px] font-semibold text-muted">{g.label}</div>
            {g.chats.map(row)}
          </div>
        ))}
      </nav>
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
        <div className="flex items-center gap-1">
          <button type="button" className={navItem(false)} onClick={props.onSettings}>
            <Settings className="size-4" /> {copy.sidebar.nav.settings}
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
