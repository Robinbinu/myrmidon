import type { ColonyState, MadeToolInput } from '@myrmidon/protocol'
import { BookmarkCheck, BookmarkPlus, ChevronRight, Trash2, Wrench } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { api, send } from '../api.ts'
import { Button, cn, Pill } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

/** A tool as the library stores it; a colony's made tools add who made it and whether it came from the library. */
export interface LibraryTool {
  name: string
  description: string
  inputs: MadeToolInput[]
  language: 'typescript' | 'python' | 'bash'
  source: string
}

function useLibrary() {
  const [tools, setTools] = useState<LibraryTool[]>()
  useEffect(() => {
    api<{ tools: LibraryTool[] }>('/api/tools')
      .then((r) => setTools(r.tools))
      .catch(() => setTools([]))
  }, [])
  return [tools, setTools] as const
}

function ToolRow(props: { tool: LibraryTool; meta: string; action?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const t = props.tool
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Wrench className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] font-medium">tool_{t.name}</div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-fg-2">{t.description}</p>
          <div className="mt-1 text-[11.5px] text-muted">{props.meta}</div>
        </div>
        {props.action}
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 border-t border-line px-3 py-1.5 text-left text-[11.5px] text-muted hover:text-fg"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {t.inputs.length
          ? `Inputs: ${t.inputs.map((i) => `${i.name}${i.optional ? '?' : ''}: ${i.type}`).join(', ')}`
          : 'No inputs'}
        <span className="ml-auto">{open ? 'Hide source' : 'Source'}</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-line bg-surface-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed">
          {t.source}
        </pre>
      )}
    </div>
  )
}

/** Tools the colony's agents made, each with "Keep" to add it to the person's library. */
export function ColonyTools(props: { colonyId: string; tools: ColonyState['madeTools'] }) {
  const toast = useToast()
  const [library, setLibrary] = useLibrary()
  const [busy, setBusy] = useState<string>()
  const tools = Object.values(props.tools).sort((a, b) => a.name.localeCompare(b.name))
  if (tools.length === 0) return null
  const keep = async (name: string) => {
    setBusy(name)
    try {
      const r = await send<{ tools: LibraryTool[] }>('POST', '/api/tools', { colonyId: props.colonyId, name })
      setLibrary(r.tools)
      toast(`Kept tool_${name}: new rounds start with it`, 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="px-1.5 pt-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
        Tools made here
      </div>
      {tools.map((t) => {
        const kept = t.library || library?.some((l) => l.name === t.name && l.source === t.source)
        return (
          <ToolRow
            key={t.name}
            tool={t}
            meta={`${t.library ? 'from your library' : `made by ${t.agent}`} · ${t.language}`}
            action={
              kept ? (
                <Pill tone="ok">
                  <BookmarkCheck className="size-3" /> Kept
                </Pill>
              ) : (
                <Button
                  size="sm"
                  disabled={busy === t.name || !library}
                  onClick={() => keep(t.name)}
                  icon={<BookmarkPlus className="size-3.5" />}
                  title="Keep in your library: every new round starts with this tool"
                >
                  Keep
                </Button>
              )
            }
          />
        )
      })}
    </div>
  )
}

/** The person's kept tools, for Settings. */
export function ToolLibraryList() {
  const toast = useToast()
  const [tools, setTools] = useLibrary()
  const remove = async (name: string) => {
    try {
      setTools((await send<{ tools: LibraryTool[] }>('DELETE', `/api/tools/${name}`)).tools)
      toast(`Removed tool_${name} from your library`, 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }
  if (!tools) return null
  if (tools.length === 0)
    return (
      <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-[13px] text-muted">
        When agents make a tool with create_tool, it shows in the chat's Files view. Choose Keep there and
        every new round starts with it.
      </p>
    )
  return (
    <div className="flex flex-col gap-2">
      {tools.map((t) => (
        <ToolRow
          key={t.name}
          tool={t}
          meta={t.language}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove(t.name)}
              aria-label={`Remove tool_${t.name}`}
              icon={<Trash2 className="size-3.5" />}
            >
              Remove
            </Button>
          }
        />
      ))}
    </div>
  )
}
