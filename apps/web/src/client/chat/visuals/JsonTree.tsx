import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { copy } from '../../copy.ts'
import { cn } from '../../ui/primitives.tsx'
import { TREE_ENTRIES_SHOWN, TREE_OPEN_DEPTH } from '../../ui-config.ts'

const say = copy.visuals.tree

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted">null</span>
  if (typeof value === 'string') return <span className="break-all text-ok-ink">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="text-accent-fg">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="text-work-ink">{String(value)}</span>
  return <span className="text-muted">{String(value)}</span>
}

function Node(props: { name?: string; value: unknown; depth: number }) {
  const branch = !!props.value && typeof props.value === 'object'
  const [open, setOpen] = useState(props.depth < TREE_OPEN_DEPTH)
  const [more, setMore] = useState(false)
  const name = props.name !== undefined && <span className="text-fg-2">{props.name}: </span>
  if (!branch)
    return (
      <li className="pl-4">
        {name}
        <Leaf value={props.value} />
      </li>
    )
  const array = Array.isArray(props.value)
  const entries = array
    ? (props.value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(props.value as Record<string, unknown>)
  const shown = more ? entries : entries.slice(0, TREE_ENTRIES_SHOWN)
  const count = array ? say.items(entries.length) : say.keys(entries.length)
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={say.toggle(props.name ?? (array ? '[]' : '{}'))}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-0.5 rounded hover:bg-fill"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-muted transition-transform less-motion:transition-none',
            open && 'rotate-90',
          )}
        />
        {name}
        <span className="text-muted">
          {array ? '[' : '{'}
          {!open && ` ${count} ${array ? ']' : '}'}`}
        </span>
      </button>
      {open && (
        <ul className="ml-[7px] border-l border-line">
          {shown.map(([k, v]) => (
            <Node key={k} name={array ? undefined : k} value={v} depth={props.depth + 1} />
          ))}
          {entries.length > shown.length && (
            <li className="pl-4">
              <button type="button" onClick={() => setMore(true)} className="text-accent-fg hover:underline">
                {say.more(entries.length - shown.length)}
              </button>
            </li>
          )}
          <li className="pl-1 text-muted">{array ? ']' : '}'}</li>
        </ul>
      )}
    </li>
  )
}

/** A JSON value as a tree that folds: objects and arrays open TREE_OPEN_DEPTH levels deep, long ones a page at a time. */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <ul className="overflow-x-auto px-3 py-2 font-mono text-callout leading-relaxed">
      <Node value={value} depth={0} />
    </ul>
  )
}
