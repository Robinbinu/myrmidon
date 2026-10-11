import { Check, ChevronDown, ChevronsUpDown, Search } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ModelOption } from '../api.ts'
import { copy } from '../copy.ts'
import type { PlanLevel } from '../plan-limits.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Popover } from '../ui/Popover.tsx'
import { ProviderGlyph, ProviderLogo } from '../ui/ProviderGlyph.tsx'
import { cn, POPUP } from '../ui/primitives.tsx'
import { AGENT_MIN_WINDOW, MODEL_LIST_MIN_PX } from '../ui-config.ts'
import { modelName, withoutDatedAliases } from './model-list.ts'

// One battery, the plan-limits glyph's family: how much of the subscription is left, coloured as it runs down.
const LEVEL_ICON = {
  full: FEATURE_ICONS.planFull,
  mid: FEATURE_ICONS.planLimits,
  low: FEATURE_ICONS.planLow,
  empty: FEATURE_ICONS.planEmpty,
} as const
const LEVEL_INK: Record<PlanLevel, string> = {
  full: 'text-ok-ink',
  mid: 'text-fg-2',
  low: 'text-warn-ink',
  empty: 'text-bad-ink',
}

/** The popover a picker sits in, if any: its list then opens above the popover instead of covering it. */
export const PickerHost = createContext<RefObject<HTMLElement | null> | undefined>(undefined)

/** Where a list opened from `el` can show: inside the nearest ancestor that clips (the chat's scroll area), not the window. */
export function visibleBounds(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue
    const r = p.getBoundingClientRect()
    return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) }
  }
  return { top: 0, bottom: window.innerHeight }
}

/** A context window the way people say it: 8K, 200K, 1M. */
export function windowLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`
}

function windowHint(m: ModelOption): string {
  if (!m.contextWindow) return copy.modelPicker.windowUnknown
  const size = copy.modelPicker.windowSize(m.contextWindow.toLocaleString())
  if (!m.windowSource) return copy.modelPicker.windowGuess(size)
  if (m.contextWindow < AGENT_MIN_WINDOW) return copy.modelPicker.windowTooSmall(size)
  return size
}

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
  /** Models with a smaller known window can't be chosen here; `minReason` says why. */
  minWindow?: number
  minReason?: string
  /** The chosen model's provider is near or at its plan's limit (see plan-limits.tsx): the chip says so. */
  limitNotice?: string
  /** How much of the chosen model's subscription is left, as a battery on the chip (see plan-limits.tsx planLevel). */
  plan?: { level: PlanLevel; text: string }
}) {
  const variant = props.variant ?? 'field'
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const visible = useMemo(
    () =>
      withoutDatedAliases(
        props.models.filter((m) => !m.hidden || m.ref === props.value),
        props.value,
      ),
    [props.models, props.value],
  )
  const host = useContext(PickerHost)
  const current = props.models.find((m) => m.ref === props.value)

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return visible
      .filter((m) => !q || `${m.ref} ${m.name} ${modelName(m.name)}`.toLowerCase().includes(q))
      .slice(0, 400)
  }, [visible, query])

  const groups = useMemo(() => {
    const byProvider = new Map<string, { m: ModelOption; i: number }[]>()
    for (const [i, m] of hits.entries())
      byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), { m, i }])
    return [...byProvider]
  }, [hits])

  const tooSmall = (m: ModelOption) =>
    props.minWindow !== undefined && m.contextWindow !== undefined && m.contextWindow < props.minWindow
  const choose = (ref: string) => {
    const m = props.models.find((x) => x.ref === ref)
    if (m && tooSmall(m)) return
    props.onChange(ref)
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  // The list opens the preferred way when it fits, otherwise toward the larger space, and never past the window.
  // Inside a popover it opens above the whole popover (`lift` past it), so the row being changed stays in view.
  const [fit, setFit] = useState<{ up: boolean; max: number; lift?: number }>({
    up: (props.placement ?? 'up') === 'up',
    max: 400,
  })
  const up = fit.up
  return (
    // A chip never shrinks past its logo and chevron, so neighbouring chips can't slide over it.
    <div className={cn('relative', variant === 'chip' ? 'min-w-[52px]' : 'min-w-0')} ref={box}>
      <button
        type="button"
        onClick={() => {
          const rect = box.current?.getBoundingClientRect()
          const bounds = box.current ? visibleBounds(box.current) : { top: 0, bottom: window.innerHeight }
          const outer = host?.current?.getBoundingClientRect()
          if (rect && outer && outer.top - bounds.top - 12 >= MODEL_LIST_MIN_PX) {
            setFit({
              up: true,
              max: Math.min(400, outer.top - bounds.top - 12),
              lift: rect.top - outer.top + 8,
            })
          } else if (rect) {
            const above = rect.top - bounds.top - 12
            const below = bounds.bottom - rect.bottom - 12
            const preferUp = (props.placement ?? 'up') === 'up'
            const goUp = preferUp ? above >= Math.min(400, below) : below < Math.min(400, above)
            setFit({ up: goUp, max: Math.max(MODEL_LIST_MIN_PX, Math.min(400, goUp ? above : below)) })
          }
          setOpen(!open)
          setActive(
            Math.max(
              0,
              hits.findIndex((m) => m.ref === props.value),
            ),
          )
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The button reads as the model it shows, so what is seen is what is heard and what voice control matches;
        // which model it is (lead, reviewer, a helper) is its tooltip and description.
        title={variant === 'field' ? undefined : props.label}
        className={
          variant === 'chip'
            ? cn(
                'group inline-flex h-7 w-full min-w-[52px] max-w-[220px] items-center gap-1.5 pl-1.5 pr-2',
                POPUP,
                open && 'bg-control-active',
              )
            : variant === 'compact'
              ? 'group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line-strong/70 bg-control pl-2.5 pr-1.5 text-body shadow-control transition-colors hover:bg-control-hover'
              : 'group flex w-full flex-col items-start gap-0.5 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-all duration-150 hover:border-line-strong hover:shadow-soft'
        }
      >
        {variant === 'chip' ? (
          <>
            <ProviderGlyph model={`${props.value} ${current?.name ?? ''}`} />
            <span className="truncate">
              {current ? modelName(current.name) : props.value || copy.modelPicker.choose}
            </span>
            {(props.plan || props.limitNotice) && (
              <span
                title={props.limitNotice ?? props.plan?.text}
                className={cn('shrink-0', props.plan ? LEVEL_INK[props.plan.level] : 'text-warn-ink')}
              >
                {(() => {
                  const Icon = props.plan ? LEVEL_ICON[props.plan.level] : FEATURE_ICONS.planLimits
                  return <Icon aria-hidden className="size-3.5" />
                })()}
                <span className="sr-only">{props.limitNotice ?? props.plan?.text}</span>
              </span>
            )}
            <ChevronDown className="size-3.5 shrink-0 text-muted" />
          </>
        ) : variant === 'compact' ? (
          <>
            <span className="truncate">
              {current ? modelName(current.name) : props.value || copy.modelPicker.choose}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted" />
          </>
        ) : (
          <>
            <span className="flex items-center gap-1 section-label text-muted">
              {props.icon}
              {props.label}
            </span>
            <span className="flex w-full items-center justify-between gap-2 text-body font-medium">
              <span className="truncate">
                {current ? modelName(current.name) : props.value || copy.modelPicker.choose}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted transition-colors group-hover:text-fg" />
            </span>
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <Popover
            role="dialog"
            label={copy.modelPicker.buttonLabel(props.label)}
            onClose={() => setOpen(false)}
            within={box}
            up={up}
            style={{ maxHeight: fit.max, ...(fit.lift ? { bottom: `calc(100% + ${fit.lift}px)` } : {}) }}
            className={cn(
              'absolute z-50 flex w-[min(420px,90vw)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop',
              variant === 'compact' ? 'right-0' : 'left-0',
              variant === 'chip' && 'material-menu border-line',
              up ? 'bottom-[calc(100%+6px)] origin-bottom-left' : 'top-[calc(100%+6px)] origin-top-left',
            )}
          >
            <div className="relative border-b border-line p-2">
              <Search className="pointer-events-none absolute left-4.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                type="search"
                // The popover exists to search; it focuses this once it has noted the button to return to.
                data-autofocus
                placeholder={copy.modelPicker.search(visible.length)}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
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
                aria-label={copy.modelPicker.searchLabel(props.label)}
                className="w-full rounded-xl bg-fill py-2 pl-8 pr-3 text-body outline-none placeholder:text-muted focus:ring-2 focus:ring-accent-soft"
              />
            </div>
            <div
              className="overflow-auto p-1.5"
              role="listbox"
              ref={list}
              aria-label={copy.modelPicker.buttonLabel(props.label)}
            >
              {groups.length === 0 && (
                <div className="px-3 py-6 text-center text-body text-muted">
                  {copy.modelPicker.noMatch(query)}
                </div>
              )}
              {groups.map(([provider, items]) => (
                <div key={provider}>
                  <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface px-2.5 pb-1 pt-2 section-label text-muted">
                    <ProviderLogo provider={provider} size={12} />
                    {provider}
                  </div>
                  {items.map(({ m, i }) => {
                    const blocked = tooSmall(m)
                    const small = m.contextWindow !== undefined && m.contextWindow < AGENT_MIN_WINDOW
                    return (
                      <button
                        key={m.ref}
                        type="button"
                        role="option"
                        aria-selected={m.ref === props.value}
                        aria-disabled={blocked}
                        title={blocked ? props.minReason : undefined}
                        data-active={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(m.ref)}
                        className={cn(
                          // The margin keeps a row scrolled into view clear of the sticky provider heading.
                          'flex w-full scroll-mt-9 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors',
                          i === active && !blocked && 'bg-fill',
                          m.ref === props.value && 'text-accent-fg',
                          (small || blocked) && 'opacity-60',
                          blocked && 'cursor-not-allowed',
                        )}
                      >
                        <ProviderGlyph model={`${m.ref} ${m.name}`} size={18} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body font-medium">{modelName(m.name)}</span>
                          <span className="truncate font-mono text-caption text-muted">
                            {blocked ? props.minReason : small ? copy.modelPicker.tooSmall : m.id}
                          </span>
                        </span>
                        {m.contextWindow !== undefined && (
                          <span
                            title={windowHint(m)}
                            className={cn(
                              'shrink-0 font-mono text-caption tabular-nums',
                              small ? 'text-warn-ink' : 'text-muted',
                            )}
                          >
                            {windowLabel(m.contextWindow)}
                            {!m.windowSource && '?'}
                          </span>
                        )}
                        {m.reasoning && (
                          <span title={copy.modelPicker.thinking} className="text-muted">
                            <FEATURE_ICONS.thinking className="size-3.5" />
                          </span>
                        )}
                        {m.source && m.source !== 'omp' && (
                          <span className="rounded-sm bg-accent-soft px-1.5 text-caption font-semibold uppercase tracking-wide text-accent-fg">
                            {m.source === 'custom' ? copy.modelPicker.custom : copy.modelPicker.key}
                          </span>
                        )}
                        {m.ref === props.value && <Check className="size-4 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}
