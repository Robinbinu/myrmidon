import {
  BarChart3,
  Monitor,
  Moon,
  Network,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useState } from 'react'
import type { ChatSummary } from '../api.ts'
import type { ThemeChoice } from '../ui/hooks.ts'
import { Logo } from '../ui/Logo.tsx'
import { cn, Dot, IconButton, spring } from '../ui/primitives.tsx'

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
  onNew(): void
  onView(v: View): void
  onSettings(): void
  onCollapse(): void
}) {
  const [query, setQuery] = useState('')
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = props.chats.filter(
      (c) =>
        !q || c.title.toLowerCase().includes(q) || c.rounds.some((r) => r.request.toLowerCase().includes(q)),
    )
    const out: { label: string; chats: ChatSummary[] }[] = []
    for (const c of hits) {
      const label =
        GROUPS.find((g) => (c.updatedAt ? ageDays(c.updatedAt) : 0) < g.maxAgeDays)?.label ?? 'Older'
      const group = out.find((g) => g.label === label)
      if (group) group.chats.push(c)
      else out.push({ label, chats: [c] })
    }
    return out
  }, [props.chats, query])

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
        {props.chats.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-muted">Your conversations will appear here.</p>
        )}
        {props.chats.length > 0 && grouped.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-muted">No chats match “{query}”.</p>
        )}
        {grouped.map((g) => (
          <div key={g.label}>
            <div className="px-3 pb-1 pt-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
              {g.label}
            </div>
            {g.chats.map((c) => {
              const on = c.chatId === props.activeChat && props.view === 'chat'
              return (
                <div key={c.chatId} className="group relative">
                  <button
                    type="button"
                    onClick={() => props.onSelect(c.chatId)}
                    title={c.title}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'relative flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-9 text-left text-[13.5px] transition-colors',
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
                  <button
                    type="button"
                    onClick={() => props.onDelete(c)}
                    aria-label={`Delete “${c.title}”`}
                    title="Delete chat"
                    className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-bad-soft hover:text-bad focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )
            })}
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
