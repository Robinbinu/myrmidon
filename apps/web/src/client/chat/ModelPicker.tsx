import { Brain, Check, ChevronDown, ChevronsUpDown, Search } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelOption } from '../api.ts'
import { ProviderGlyph } from '../ui/ProviderGlyph.tsx'
import { cn, spring } from '../ui/primitives.tsx'

/** Searchable model selector grouped by provider, with arrow-key navigation. */
export function ModelPicker(props: {
  label: string
  icon?: ReactNode
  value: string
  models: ModelOption[]
  onChange(ref: string): void
  /** Open upward (inside the composer) or downward (in settings). */
  placement?: 'up' | 'down'
  /**
   * `field` (default) is a labelled box; `compact` a small popup button for a settings row, its list aligned right;
   * `chip` a glass pill with the model's mark, for the composer toolbar.
   */
  variant?: 'field' | 'compact' | 'chip'
}) {
  const variant = props.variant ?? 'field'
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const visible = useMemo(
    () => props.models.filter((m) => !m.hidden || m.ref === props.value),
    [props.models, props.value],
  )
  const current = props.models.find((m) => m.ref === props.value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return visible.filter((m) => !q || `${m.ref} ${m.name}`.toLowerCase().includes(q)).slice(0, 400)
  }, [visible, query])

  const groups = useMemo(() => {
    const byProvider = new Map<string, { m: ModelOption; i: number }[]>()
    for (const [i, m] of hits.entries())
      byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), { m, i }])
    return [...byProvider]
  }, [hits])

  const choose = (ref: string) => {
    props.onChange(ref)
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  const up = (props.placement ?? 'up') === 'up'
  return (
    <div className="relative min-w-0" ref={box}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open)
          setActive(
            Math.max(
              0,
              hits.findIndex((m) => m.ref === props.value),
            ),
          )
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={variant === 'field' ? undefined : `${props.label} model`}
        title={variant === 'chip' ? `${props.label}: ${current?.name ?? props.value}` : undefined}
        className={
          variant === 'chip'
            ? cn(
                'group inline-flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-fill/40 pl-1.5 pr-2.5 text-[12.5px] font-medium text-fg-2 shadow-[inset_0_0.5px_0_rgb(255_255_255/0.07)] transition-colors hover:bg-fill hover:text-fg',
                open && 'bg-fill text-fg',
              )
            : variant === 'compact'
              ? 'group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line-strong/70 bg-control pl-2.5 pr-1.5 text-[13px] shadow-[0_0.5px_1px_rgb(0_0_0/0.08)] transition-colors hover:bg-control-hover'
              : 'group flex w-full flex-col items-start gap-0.5 rounded-xl border border-line bg-surface px-3 py-2 text-left transition-all duration-150 hover:border-line-strong hover:shadow-soft'
        }
      >
        {variant === 'chip' ? (
          <>
            <ProviderGlyph model={`${props.value} ${current?.name ?? ''}`} />
            <span className="truncate">{current?.name ?? (props.value || 'Choose a model')}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted" />
          </>
        ) : variant === 'compact' ? (
          <>
            <span className="truncate">{current?.name ?? (props.value || 'Choose a model')}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted" />
          </>
        ) : (
          <>
            <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {props.icon}
              {props.label}
            </span>
            <span className="flex w-full items-center justify-between gap-2 text-[13px] font-medium">
              <span className="truncate">{current?.name ?? (props.value || 'Choose a model')}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted transition-colors group-hover:text-fg" />
            </span>
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: up ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: up ? 4 : -4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={spring}
            className={cn(
              'absolute z-50 flex max-h-[400px] w-[min(420px,90vw)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop',
              variant === 'compact' ? 'right-0' : 'left-0',
              variant === 'chip' && 'material-menu border-line',
              up ? 'bottom-[calc(100%+6px)] origin-bottom-left' : 'top-[calc(100%+6px)] origin-top-left',
            )}
          >
            <div className="relative border-b border-line p-2">
              <Search className="pointer-events-none absolute left-4.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                type="search"
                // biome-ignore lint/a11y/noAutofocus: the popover exists to search
                autoFocus
                placeholder={`Search ${visible.length} models…`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false)
                  else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActive((a) => Math.min(hits.length - 1, a + 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActive((a) => Math.max(0, a - 1))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    const hit = hits[active]
                    if (hit) choose(hit.ref)
                  }
                }}
                aria-label={`Search ${props.label} models`}
                className="w-full rounded-lg bg-surface-2 py-2 pl-8 pr-3 text-[13px] outline-none placeholder:text-muted focus:ring-2 focus:ring-accent-soft"
              />
            </div>
            <div
              className="overflow-auto p-1.5"
              role="listbox"
              ref={list}
              aria-label={`${props.label} model`}
            >
              {groups.length === 0 && (
                <div className="px-3 py-6 text-center text-[13px] text-muted">No models match “{query}”.</div>
              )}
              {groups.map(([provider, items]) => (
                <div key={provider}>
                  <div className="sticky top-0 z-10 bg-surface px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {provider}
                  </div>
                  {items.map(({ m, i }) => (
                    <button
                      key={m.ref}
                      type="button"
                      role="option"
                      aria-selected={m.ref === props.value}
                      data-active={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(m.ref)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                        i === active && 'bg-surface-2',
                        m.ref === props.value && 'text-accent-fg',
                      )}
                    >
                      <ProviderGlyph model={`${m.ref} ${m.name}`} size={20} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium">{m.name}</span>
                        <span className="truncate font-mono text-[11px] text-muted">{m.id}</span>
                      </span>
                      {m.reasoning && (
                        <span title="Supports extended thinking" className="text-muted">
                          <Brain className="size-3.5" />
                        </span>
                      )}
                      {m.source && m.source !== 'omp' && (
                        <span className="rounded bg-accent-soft px-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
                          {m.source === 'custom' ? 'custom' : 'key'}
                        </span>
                      )}
                      {m.ref === props.value && <Check className="size-4 shrink-0" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
