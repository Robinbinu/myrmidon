import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../ui/primitives.tsx'

export interface DiffFile {
  path: string
  /** git's status letter: A added, M modified, D deleted, R renamed. */
  status: string
  added?: number
  removed?: number
}

const STATUS: Record<string, { label: string; className: string }> = {
  A: { label: 'A', className: 'bg-ok-soft text-ok' },
  M: { label: 'M', className: 'bg-warn-soft text-warn' },
  D: { label: 'D', className: 'bg-bad-soft text-bad' },
  R: { label: 'R', className: 'bg-accent-soft text-accent' },
}

/** Splits a unified diff into per-file sections, keyed by the file's new path. */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part)
    if (header?.[2]) out.set(header[2], part)
  }
  return out
}

function Hunks({ text }: { text: string }) {
  const lines = text.split('\n')
  // Skip the per-file header (diff/index/---/+++); hunks start at the first "@@".
  const start = lines.findIndex((l) => l.startsWith('@@'))
  if (start < 0) return <p className="px-3 py-2 text-[12px] text-muted">Binary file or no textual change.</p>
  return (
    <pre className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.55]">
      {lines.slice(start).map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond their position
          key={i}
          className={cn(
            'px-3 whitespace-pre',
            l.startsWith('+') && 'bg-ok-soft text-ok',
            l.startsWith('-') && 'bg-bad-soft text-bad',
            l.startsWith('@@') && 'bg-surface-2 text-muted',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

/** A file list with +/- counts; each file opens to its hunks. */
export function DiffView(props: { files: DiffFile[]; patch: string; truncated?: boolean; open?: string }) {
  const sections = useMemo(() => splitPatch(props.patch), [props.patch])
  const [open, setOpen] = useState<string | undefined>(props.open)
  if (props.files.length === 0) return <p className="px-1 py-2 text-[12.5px] text-muted">No file changes.</p>
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {props.files.map((f) => {
        const s = STATUS[f.status] ?? { label: f.status, className: 'bg-surface-2 text-fg-2' }
        const expanded = open === f.path
        return (
          <div key={f.path}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? undefined : f.path)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-surface-2"
            >
              <ChevronRight
                className={cn('size-3.5 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
              />
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded font-mono text-[10.5px] font-semibold',
                  s.className,
                )}
              >
                {s.label}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              {f.added !== undefined && (
                <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
                  <span className="text-ok">+{f.added}</span> <span className="text-bad">−{f.removed}</span>
                </span>
              )}
            </button>
            {expanded && (
              <div className="border-t border-line">
                <Hunks text={sections.get(f.path) ?? ''} />
              </div>
            )}
          </div>
        )
      })}
      {props.truncated && (
        <p className="px-3 py-2 text-[12px] text-muted">The diff is large; only its first 512 KB is shown.</p>
      )}
    </div>
  )
}
