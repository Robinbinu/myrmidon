import type { ColonyState, MadeToolInput } from '@myrmidon/protocol'
import { BookmarkCheck, BookmarkPlus, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { api, send } from '../api.ts'
import { copy } from '../copy.ts'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Badge, Button, cn } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

/** A tool as the library stores it; a colony's made tools add who made it and whether it came from the library. */
export interface LibraryTool {
  name: string
  description: string
  inputs: MadeToolInput[]
  language: 'typescript' | 'python' | 'bash' | 'browser'
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
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
          <FEATURE_ICONS.tools className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-body font-medium">tool_{t.name}</div>
          <p className="mt-0.5 text-callout leading-snug text-fg-2">{t.description}</p>
          <div className="mt-1 text-footnote text-muted">{props.meta}</div>
        </div>
        {props.action}
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 border-t border-line px-3 py-1.5 text-left text-footnote text-muted hover:text-fg"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {t.inputs.length
          ? copy.madeTools.inputs(
              t.inputs.map((i) => `${i.name}${i.optional ? '?' : ''}: ${i.type}`).join(', '),
            )
          : copy.madeTools.noInputs}
        <span className="ml-auto">{open ? copy.madeTools.hideSource : copy.madeTools.source}</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-line bg-fill px-3 py-2 font-mono text-footnote leading-relaxed">
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
      toast(copy.madeTools.keptToast(name), 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="px-1.5 pt-2 section-label text-muted">{copy.madeTools.heading}</div>
      {tools.map((t) => {
        const kept = t.library || library?.some((l) => l.name === t.name && l.source === t.source)
        return (
          <ToolRow
            key={t.name}
            tool={t}
            meta={`${t.library ? copy.madeTools.fromLibrary : copy.madeTools.madeBy(t.agent)} · ${t.language}`}
            action={
              kept ? (
                <Badge tone="ok">
                  <BookmarkCheck className="size-3" /> {copy.madeTools.kept}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  disabled={busy === t.name || !library}
                  onClick={() => keep(t.name)}
                  icon={<BookmarkPlus className="size-3.5" />}
                  title={copy.madeTools.keepTitle}
                >
                  {copy.madeTools.keep}
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
      toast(copy.madeTools.removedToast(name), 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }
  if (!tools) return null
  if (tools.length === 0)
    return (
      <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-body text-muted">
        {copy.madeTools.empty}
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
            <ConfirmButton
              label={copy.madeTools.remove}
              name={copy.madeTools.removeLabel(t.name)}
              confirm={copy.madeTools.confirmRemove}
              onConfirm={() => void remove(t.name)}
            />
          }
        />
      ))}
    </div>
  )
}
