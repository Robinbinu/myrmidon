import {
  BarChart3,
  ChevronRight,
  Folder,
  FolderPlus,
  Monitor,
  Moon,
  Network,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useRef, useState } from 'react'
import type { ChatSummary, Project } from '../api.ts'
import type { ThemeChoice } from '../ui/hooks.ts'
import { Logo } from '../ui/Logo.tsx'
import { cn, Dot, IconButton, spring } from '../ui/primitives.tsx'
import { PermissionMark } from './ProjectPermissions.tsx'

export type View = 'chat' | 'colonies' | 'compare'

const GROUPS: { label: string; maxAgeDays: number }[] = [
  { label: 'Today', maxAgeDays: 1 },
  { label: 'Yesterday', maxAgeDays: 2 },
  { label: 'Previous 7 days', maxAgeDays: 7 },
  { label: 'Older', maxAgeDays: Number.POSITIVE_INFINITY },
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
        GROUPS.find((g) => (c.updatedAt ? ageDays(c.updatedAt) : 0) < g.maxAgeDays)?.label ?? 'Older'
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
            aria-label="Chat title"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => finishRename(c, !cancelled.current)}
            onKeyDown={(e) => {
              // Both keys leave through blur, which saves unless Escape asked to cancel.
              if (e.key === 'Escape') cancelled.current = true
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
            className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] outline-none focus:ring-2 focus:ring-accent-soft"
          />
        ) : (
          <button
            type="button"
            onClick={() => props.onSelect(c.chatId)}
            onDoubleClick={() => startRename(c)}
            title={c.title}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'relative flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-16 text-left text-[13.5px] transition-colors',
              on ? 'text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
            )}
          >
            {on && (
              <motion.span
                layoutId="chat-active"
                transition={spring}
                className="absolute inset-0 rounded-lg bg-surface-3/70"
              />
            )}
            <span className="relative flex min-w-0 flex-1 items-center gap-2.5">
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
            aria-label={`Rename “${c.title}”`}
            title="Rename chat"
            className="absolute right-9 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          hidden={editing === c.chatId}
          onClick={() => props.onDelete(c)}
          aria-label={`Delete “${c.title}”`}
          title="Delete chat"
          className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-bad-soft hover:text-bad focus-visible:opacity-100 group-hover:opacity-100"
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
      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition-colors',
      on ? 'bg-surface-3/70 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
    )

  return (
    <aside
      className="flex h-full w-[272px] flex-col border-r border-line bg-surface/60"
      aria-label="Conversations"
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="flex flex-1 items-center gap-2.5 text-[16px] font-semibold tracking-[-0.03em]">
          <Logo size={30} />
          Myrmidon
        </div>
        <IconButton label="Collapse sidebar" title="Collapse sidebar (⌘B)" onClick={props.onCollapse}>
          <PanelLeftClose className="size-4" />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2">
        <button
          type="button"
          onClick={props.onNew}
          className="group flex h-10 items-center gap-2 rounded-full bg-ink pl-3.5 pr-2 text-[13.5px] font-medium text-on-ink shadow-card transition-all duration-150 hover:opacity-90 active:scale-[0.98]"
        >
          <Plus className="size-4 transition-transform duration-200 group-hover:rotate-90" /> New task
          <span className="ml-auto rounded-full bg-on-ink/15 px-2 py-0.5 font-mono text-[10.5px] text-on-ink/70">
            ⌘K
          </span>
        </button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search chats"
            className="h-9 w-full rounded-lg bg-surface-2 pl-8 pr-3 text-[13.5px] outline-none transition-shadow placeholder:text-muted focus:ring-2 focus:ring-accent-soft"
          />
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        <div className="group/projects flex items-center px-3 pb-1 pt-3">
          <span className="flex-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
            Projects
          </span>
          <button
            type="button"
            onClick={props.onAddProject}
            aria-label="Add a project folder"
            title="Add a project folder"
            className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </div>
        {props.projects.length === 0 && (
          <button
            type="button"
            onClick={props.onAddProject}
            className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Folder className="size-4" /> Open a folder to work in
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
                  className="flex w-full items-center gap-2 rounded-lg py-2 pl-2 pr-24 text-left text-[13.5px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <ChevronRight
                    className={cn('size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')}
                  />
                  <Folder className="size-4 shrink-0 text-muted" />
                  <span className="truncate font-medium">{p.name}</span>
                  <PermissionMark {...(p.permissions ? { mode: p.permissions.mode } : {})} />
                </button>
                <button
                  type="button"
                  onClick={() => props.onProjectPermissions(p)}
                  aria-label={`Permissions for ${p.name}`}
                  title="What agents may do in this folder"
                  className="absolute right-[4.25rem] top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <ShieldCheck className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => props.onNewInProject(p)}
                  aria-label={`New chat in ${p.name}`}
                  title={`New chat in ${p.name}`}
                  className="absolute right-9 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Plus className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => props.onRemoveProject(p)}
                  aria-label={`Remove ${p.name} from projects`}
                  title="Remove from projects (the folder and its chats stay)"
                  className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {open && (
                <div className="ml-4 border-l border-line pl-1">
                  {chats.map(row)}
                  {chats.length === 0 && <p className="px-3 py-1.5 text-[12px] text-muted">No chats yet</p>}
                </div>
              )}
            </div>
          )
        })}
        {props.chats.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-muted">Your conversations will appear here.</p>
        )}
        {props.chats.length > 0 && hits.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-muted">No chats match “{query}”.</p>
        )}
        {grouped.map((g) => (
          <div key={g.label}>
            <div className="px-3 pb-1 pt-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
              {g.label}
            </div>
            {g.chats.map(row)}
          </div>
        ))}
      </nav>
      <div className="grid gap-0.5 border-t border-line p-2">
        <button
          type="button"
          className={navItem(props.view === 'colonies')}
          onClick={() => props.onView('colonies')}
        >
          <Network className="size-4" /> Colonies
        </button>
        <button
          type="button"
          className={navItem(props.view === 'compare')}
          onClick={() => props.onView('compare')}
        >
          <BarChart3 className="size-4" /> Compare runs
        </button>
        <div className="flex items-center gap-1">
          <button type="button" className={navItem(false)} onClick={props.onSettings}>
            <Settings className="size-4" /> Settings
          </button>
          <IconButton
            label={`Theme: ${props.theme}. Switch to ${nextTheme}`}
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
