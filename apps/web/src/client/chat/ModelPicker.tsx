import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelOption } from '../api.ts'

/** Searchable model selector grouped by provider. */
export function ModelPicker(props: {
  label: string
  value: string
  models: ModelOption[]
  onChange(ref: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const current = props.models.find((m) => m.ref === props.value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = props.models.filter((m) => !q || `${m.ref} ${m.name}`.toLowerCase().includes(q))
    const byProvider = new Map<string, ModelOption[]>()
    for (const m of hits.slice(0, 400)) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m])
    return [...byProvider]
  }, [props.models, query])

  return (
    <div className="picker" ref={box}>
      <button type="button" className="picker-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="picker-label">{props.label}</span>
        <span className="picker-value">{current?.name ?? (props.value || 'choose model')}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="picker-pop" role="listbox" aria-label={`${props.label} model`}>
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover exists to search
            autoFocus
            className="picker-search"
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          />
          <div className="picker-list">
            {groups.length === 0 && <div className="empty small">No models match.</div>}
            {groups.map(([provider, models]) => (
              <div key={provider}>
                <div className="picker-group">{provider}</div>
                {models.map((m) => (
                  <button
                    key={m.ref}
                    type="button"
                    role="option"
                    aria-selected={m.ref === props.value}
                    className={m.ref === props.value ? 'picker-item on' : 'picker-item'}
                    onClick={() => {
                      props.onChange(m.ref)
                      setOpen(false)
                      setQuery('')
                    }}
                  >
                    <span>{m.name}</span>
                    <span className="muted small mono">{m.id}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
