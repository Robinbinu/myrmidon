import { Search } from 'lucide-react'
import { motion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { copy } from './copy.ts'
import { useDialog } from './ui/dialog.ts'
import { isMac } from './ui/platform.ts'
import { cn } from './ui/primitives.tsx'
import { comboLabel } from './ui/shortcuts.ts'
import { fade, PALETTE_LIMITS, spring } from './ui-config.ts'

export type PaletteGroup = keyof typeof copy.palette.groups

/** The order the menu lists its groups in. */
const GROUP_ORDER: readonly PaletteGroup[] = ['actions', 'chats', 'projects', 'settings']

export interface PaletteItem {
  readonly id: string
  readonly group: PaletteGroup
  readonly label: string
  /** A quieter line after the label: a Settings page's hint, a project's folder. */
  readonly detail?: string
  readonly icon: ReactNode
  /** The shortcut that does the same thing, shown at the row's end. */
  readonly combo?: string
  /** More words it answers to, besides its label. */
  readonly keywords?: string
  run(): void
}

const WORD_BREAK = /[\s/·:–(-]/

/**
 * How well `text` answers `query` (both lower case): the start of the text beats the start of a word, which beats
 * anywhere inside it, which beats its letters in order (so "nwc" finds "New chat"). Undefined when it does not match.
 */
export function matchScore(text: string, query: string): number | undefined {
  if (!query) return 0
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1))
    if (at === 0 || WORD_BREAK.test(text[at - 1] ?? '')) return at === 0 ? 4 : 3
  if (text.includes(query)) return 2
  let at = 0
  for (const ch of text) if (ch === query[at]) at++
  return at === query.length ? 1 : undefined
}

/**
 * What the menu lists for a query, group by group: with nothing typed, the actions and a few recent chats and
 * projects; once typing, everything that matches, best first, each group cut to its limit.
 */
export function rankPalette(items: readonly PaletteItem[], rawQuery: string): PaletteItem[] {
  const query = rawQuery.trim().toLowerCase()
  const limits = query ? PALETTE_LIMITS.searching : PALETTE_LIMITS.idle
  return GROUP_ORDER.flatMap((group) => {
    const scored = items
      .filter((item) => item.group === group)
      .map((item, order) => {
        const label = matchScore(item.label.toLowerCase(), query)
        const extra = item.keywords ? matchScore(item.keywords.toLowerCase(), query) : undefined
        // Words besides the label count for less than the label itself.
        const score = Math.max(label ?? -1, extra === undefined ? -1 : extra - 0.5)
        return { item, score, order }
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
    return scored.slice(0, limits[group]).map((s) => s.item)
  })
}

/**
 * The command menu, Spotlight style: a floating glass panel with one large field, and everything it can reach in
 * groups under it. The arrow keys move through the results, Enter opens one, Escape closes the menu.
 */
export function CommandPalette(props: { items: readonly PaletteItem[]; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useDialog(box, props.onClose, { covers: true })
  const id = useId()
  const [query, setQuery] = useState('')
  const results = useMemo(() => rankPalette(props.items, query), [props.items, query])
  const [active, setActive] = useState(0)
  // A new query starts again from its best result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is what resets it
  useEffect(() => {
    setActive(0)
  }, [query])
  const current = results[Math.min(active, results.length - 1)]
  const optionId = (item: PaletteItem) => `${id}-${item.id}`
  useEffect(() => {
    if (!current) return
    list.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: 'nearest' })
  })
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    props.onClose()
    item.run()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      return choose(current)
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step || !results.length) return
    e.preventDefault()
    setActive((a) => (Math.min(a, results.length - 1) + step + results.length) % results.length)
  }
  const t = copy.palette
  return (
    <motion.div
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[16vh]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fade}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <motion.div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={t.label}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.98, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={spring}
        className="material-menu flex max-h-[min(520px,70vh)] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-line outline-none"
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
          <Search aria-hidden className="size-5 shrink-0 text-muted" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the menu opens to be typed into
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current) : undefined}
            aria-label={t.label}
            placeholder={t.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-heading text-fg outline-none placeholder:text-muted"
          />
        </div>
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={t.results}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-body text-muted">{t.noMatches(query.trim())}</p>
          )}
          {GROUP_ORDER.map((group) => {
            const items = results.filter((r) => r.group === group)
            if (!items.length) return null
            return (
              // biome-ignore lint/a11y/useSemanticElements: a list box groups its options this way; fieldset is for forms
              <div key={group} role="group" aria-labelledby={`${id}-${group}`}>
                <div id={`${id}-${group}`} className="px-2.5 pb-1 pt-2 text-caption font-semibold text-muted">
                  {t.groups[group]}
                </div>
                {items.map((item) => {
                  const on = item === current
                  return (
                    // Options are reached from the field (aria-activedescendant), so they take no focus themselves.
                    <button
                      type="button"
                      key={item.id}
                      id={optionId(item)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={on}
                      onMouseMove={() => setActive(results.indexOf(item))}
                      // The field keeps focus, and with it the typing.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(item)}
                      className={cn(
                        'flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-body',
                        on ? 'bg-fill-strong text-fg' : 'text-fg-2',
                      )}
                    >
                      <span aria-hidden className="grid size-5 shrink-0 place-items-center text-fg-2">
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-fg">{item.label}</span>
                        {item.detail && <span className="ml-2 text-muted">{item.detail}</span>}
                      </span>
                      {item.combo && (
                        <span className="shrink-0 text-small tabular-nums text-muted">
                          {comboLabel(item.combo, isMac)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-footnote text-muted">
          <span>↑↓ {t.footer.move}</span>
          <span>↩ {t.footer.open}</span>
          <span>esc {t.footer.close}</span>
        </div>
      </motion.div>
    </motion.div>
  )
}
