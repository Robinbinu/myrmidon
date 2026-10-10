import { ChevronRight, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { isMac } from '../ui/platform.ts'
import { Button, cn, Kbd } from '../ui/primitives.tsx'
import { comboLabel } from '../ui/shortcuts.ts'
import { SETTINGS_SEARCH, SETTINGS_SEARCH_COMBO } from '../ui-config.ts'
import { sectionInfo } from './pages.ts'
import { DYNAMIC, SETTINGS } from './registry.ts'
import { type SearchEntry, type SearchResult, searchSettings } from './search.ts'

const t = copy.settings.search

/** The search's state, shared by its field (over the section list) and its results (in place of the page). */
export function useSettingsSearch(index: readonly SearchEntry[]) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const results = useMemo(() => searchSettings(index, query), [index, query])
  // A new query starts again from its best result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is what resets it
  useEffect(() => {
    setActive(0)
  }, [query])
  const current = results[Math.min(active, results.length - 1)]
  return {
    id,
    input,
    query,
    setQuery,
    focused,
    setFocused,
    results,
    current,
    setActive,
    /** The results show in place of the page while there is a query, or the empty field is focused. */
    open: focused || !!query.trim(),
    optionId: (r: SearchResult) => `${id}-${r.entry.id}-${r.entry.key ?? ''}`.replace(/[^\w-]/g, '_'),
  }
}

export type SettingsSearchState = ReturnType<typeof useSettingsSearch>

/** The field at the top of Settings' section list: arrows move through the results, Enter opens one, Esc clears. */
export function SettingsSearchField(props: {
  search: SettingsSearchState
  onChoose(entry: SearchEntry): void
  className?: string
}) {
  const { search } = props
  const choose = (r: SearchResult | undefined) => {
    if (!r) return
    search.setQuery('')
    search.input.current?.blur()
    props.onChoose(r.entry)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      return choose(search.current)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (search.query) search.setQuery('')
      else search.input.current?.blur()
      return
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    const n = search.results.length
    if (!step || !n) return
    e.preventDefault()
    search.setActive((a) => (Math.min(a, n - 1) + step + n) % n)
  }
  return (
    <div className={cn('relative', props.className)}>
      <FEATURE_ICONS.settingsSearch
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted"
      />
      <input
        ref={search.input}
        type="text"
        role="combobox"
        aria-expanded={search.open}
        aria-controls={`${search.id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={search.query && search.current ? search.optionId(search.current) : undefined}
        aria-label={t.label}
        placeholder={t.placeholder}
        value={search.query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => search.setQuery(e.target.value)}
        onFocus={() => search.setFocused(true)}
        onBlur={() => search.setFocused(false)}
        onKeyDown={onKeyDown}
        className="h-7 w-full rounded-md border border-line-strong/50 bg-fill/60 pl-7 pr-12 text-body text-fg outline-none transition-[border,box-shadow] duration-100 placeholder:text-muted focus:border-focus focus:bg-control focus:ring-3 focus:ring-focus/30"
      />
      <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
        {search.query ? (
          <button
            type="button"
            aria-label={t.clear}
            title={t.clear}
            // The field keeps focus, and with it the typing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => search.setQuery('')}
            className="grid size-5 place-items-center rounded-full text-muted hover:bg-fill-strong hover:text-fg"
          >
            <X className="size-3" />
          </button>
        ) : (
          !search.focused && <Kbd>{comboLabel(SETTINGS_SEARCH_COMBO, isMac)}</Kbd>
        )}
      </span>
    </div>
  )
}

/** The query's words in a label, picked out the way Spotlight marks them. */
function marked(label: string, query: string): ReactNode {
  const q = query.trim().toLowerCase()
  const at = q ? label.toLowerCase().indexOf(q) : -1
  if (at < 0) return label
  return (
    <>
      {label.slice(0, at)}
      <mark className="rounded-[2px] bg-accent-soft text-fg">{label.slice(at, at + q.length)}</mark>
      {label.slice(at + q.length)}
    </>
  )
}

/** Suggested queries, as chips that fill the field. */
function Suggestions(props: { search: SettingsSearchState }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
      <span className="text-callout text-muted">{t.try}</span>
      {t.suggestions.map((s) => (
        <Button
          key={s}
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            props.search.setQuery(s)
            props.search.input.current?.focus()
          }}
        >
          {s}
        </Button>
      ))}
    </div>
  )
}

/**
 * The results, in place of the page: each setting with where it is (Page › Section) and its hint, best match first.
 * With nothing typed yet, or nothing matching, it says so and suggests what to try.
 */
export function SettingsSearchResults(props: {
  search: SettingsSearchState
  onChoose(entry: SearchEntry): void
}) {
  const { search } = props
  const list = useRef<HTMLDivElement>(null)
  const query = search.query.trim()
  // The active result stays in view as the arrows move through a long list.
  useEffect(() => {
    if (!search.current) return
    list.current
      ?.querySelector(`#${CSS.escape(search.optionId(search.current))}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  })
  if (!query)
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <div className="grid size-10 place-items-center rounded-lg bg-fill text-muted">
          <FEATURE_ICONS.settingsSearch className="size-5" />
        </div>
        <p className="mt-3 text-body font-semibold text-fg">{t.empty.title}</p>
        <p className="mt-1 max-w-sm text-callout text-muted">{t.empty.body}</p>
        <Suggestions search={search} />
      </div>
    )
  if (!search.results.length)
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center" role="status">
        <p className="text-body font-semibold text-fg">{t.noResults(query)}</p>
        <p className="mt-1 max-w-sm text-callout text-muted">{t.noResultsHint}</p>
        <Suggestions search={search} />
      </div>
    )
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h3 className="text-body font-semibold">{t.results}</h3>
        <span className="text-small text-muted" role="status">
          {t.count(search.results.length)}
        </span>
      </div>
      <div
        ref={list}
        id={`${search.id}-results`}
        role="listbox"
        aria-label={t.results}
        className="divide-y divide-line overflow-hidden rounded-base border border-line bg-surface"
      >
        {search.results.map((r) => {
          const on = r === search.current
          const page = sectionInfo(r.entry.page)
          return (
            // Options are reached from the field (aria-activedescendant), so they take no focus themselves.
            <button
              type="button"
              key={search.optionId(r)}
              id={search.optionId(r)}
              role="option"
              tabIndex={-1}
              aria-selected={on}
              onMouseMove={() => search.setActive(search.results.indexOf(r))}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                search.setQuery('')
                search.input.current?.blur()
                props.onChoose(r.entry)
              }}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                on ? 'bg-row-selected' : 'hover:bg-fill/60',
              )}
            >
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-[6px]',
                  on ? 'bg-accent text-on-accent' : 'bg-fill-strong text-fg-2',
                )}
              >
                <page.icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-fg">
                  {marked(r.entry.label, query)}
                </span>
                <span className="block truncate text-small text-muted">{r.entry.trail.join(' › ')}</span>
                {r.entry.help && (
                  <span className="block truncate text-small text-fg-2/80">{r.entry.help}</span>
                )}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex gap-4 px-1 text-footnote text-muted">
        <span>↑↓ {t.footer.move}</span>
        <span>↩ {t.footer.open}</span>
        <span>esc {t.footer.clear}</span>
      </div>
    </div>
  )
}

/** The rows a setting is under (`dependsOn`, then what that depends on), nearest first. */
export function rowsAbove(id: string): string[] {
  const entry = (id: string) =>
    (SETTINGS as Record<string, { dependsOn?: string }>)[id] ??
    (DYNAMIC as Record<string, { dependsOn?: string }>)[id]
  const chain: string[] = []
  for (let up = entry(id)?.dependsOn; up && !chain.includes(up); up = entry(up)?.dependsOn) chain.push(up)
  return chain
}

/**
 * Finds a setting's row once its page has drawn it (pages load their data first), scrolls it to the middle and
 * highlights it briefly. A row the page does not show just now (its switch is off, it is in a sheet) falls back to
 * the nearest row it is under that is on screen, and `onMissing` says which, or that there is none. Returns a cleanup
 * that stops looking.
 */
export function revealSetting(
  root: RefObject<HTMLElement | null>,
  target: { id: string; key?: string; under: readonly string[] },
  reduceMotion: boolean,
  onMissing: (fallback: string | undefined) => void,
): () => void {
  const selector = (id: string, key?: string) =>
    `[data-setting-id="${CSS.escape(id)}"]${key ? `[data-setting-key="${CSS.escape(key)}"]` : ''}`
  const started = Date.now()
  let clear: ReturnType<typeof setTimeout> | undefined
  let shown: HTMLElement | undefined
  const show = (el: HTMLElement) => {
    shown = el
    el.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
    el.setAttribute('data-setting-highlight', '')
    // The row takes focus, so Tab goes on to its controls.
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1')
      el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true })
    }
    el.focus({ preventScroll: true })
    clear = setTimeout(() => el.removeAttribute('data-setting-highlight'), SETTINGS_SEARCH.highlightMs)
  }
  // A row in a page the results are still covering is not on screen yet.
  const find = (sel: string) =>
    [...(root.current?.querySelectorAll<HTMLElement>(sel) ?? [])].find((el) => !el.closest('[hidden]'))
  const timer = setInterval(() => {
    const el = find(selector(target.id, target.key))
    if (el) {
      clearInterval(timer)
      return show(el)
    }
    const waited = Date.now() - started
    const above = target.under.find((id) => find(selector(id)))
    // A page that already shows the row above has drawn what it will: no need to wait out a slow load.
    if (waited < (above ? SETTINGS_SEARCH.fallbackMs : SETTINGS_SEARCH.findMs)) return
    clearInterval(timer)
    const under = above ? find(selector(above)) : undefined
    if (under) show(under)
    onMissing(above)
  }, SETTINGS_SEARCH.findEveryMs)
  return () => {
    clearInterval(timer)
    clearTimeout(clear)
    shown?.removeAttribute('data-setting-highlight')
  }
}
