import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Cookie,
  Copy,
  Ellipsis,
  EthernetPort,
  ExternalLink,
  FileUp,
  Link,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  RotateCw,
  Scaling,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ApiError, api, personBrowserSocket, post, postForBlob, send } from '../api.ts'
import { copy } from '../copy.ts'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'
import { usePersistentFlag } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { MenuItem, MenuList, MenuSeparator, Popover } from '../ui/Popover.tsx'
import { isMac } from '../ui/platform.ts'
import { Button, cn, Empty, IconButton, TextInput } from '../ui/primitives.tsx'
import { comboLabel, matchCombo } from '../ui/shortcuts.ts'
import { useToast } from '../ui/Toast.tsx'
import { BROWSER_RESIZE_MS } from '../ui-config.ts'
import { BROWSER_LINKS_KEY } from './browser-links.ts'
import { KEYS, LEAVE_PAGE } from './Computer.tsx'

export interface BrowserTab {
  id: string
  url: string
  title: string
  favicon?: string
  file?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type CookieMode = 'quit' | 'always' | 'never'
type Viewport = 'responsive' | 'phone' | 'tablet' | 'desktop'

interface BrowserSettings {
  cookies: CookieMode
  allowedSites: string[]
  viewport: Viewport
}

interface BrowserState {
  available: boolean
  tabs: BrowserTab[]
  settings: BrowserSettings
  maxTabs: number
  maxHtmlBytes: number
}

type LiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'tabs'; tabs: BrowserTab[] }
  | { type: 'blocked'; site: string }
  | { type: 'error'; message: string }

/** Something the browser would not do, said in the view; a blocked port comes with Allow. */
interface Problem {
  text: string
  site?: string
  retry?: () => void
}

const VIEWPORTS: { value: Viewport; icon: ReactNode }[] = [
  { value: 'responsive', icon: <Scaling className="size-4 text-muted" /> },
  { value: 'phone', icon: <Smartphone className="size-4 text-muted" /> },
  { value: 'tablet', icon: <Tablet className="size-4 text-muted" /> },
  { value: 'desktop', icon: <Monitor className="size-4 text-muted" /> },
]
const COOKIE_MODES: CookieMode[] = ['quit', 'always', 'never']

/** The tab last shown, so coming back to the view (or to another chat) shows it again. The tabs live on the server. */
let shownTab: string | undefined
/** The link click last opened, so the view opening again later does not open it a second time. */
let openedLink = 0

/** What a refused request means for the person, by the server's reason. */
function problemOf(err: unknown, retry?: () => void): Problem {
  if (!(err instanceof ApiError)) return { text: err instanceof Error ? err.message : String(err) }
  const code = err.body?.code
  const site = typeof err.body?.site === 'string' ? err.body.site : undefined
  if (code === 'blocked' && site)
    return { text: copy.browser.blocked(site), site, ...(retry ? { retry } : {}) }
  if (typeof code === 'string' && code in copy.browser.refused)
    return { text: copy.browser.refused[code as keyof typeof copy.browser.refused] }
  return { text: err.message }
}

/** What the address bar shows for a tab: its address, a file's name, or nothing for a blank page. */
function shownAddress(tab: BrowserTab | undefined): string {
  if (!tab || tab.url === 'about:blank') return ''
  return tab.file ?? tab.url
}

function tabTitle(tab: BrowserTab): string {
  if (tab.file) return copy.browser.fileTab(tab.file)
  if (tab.title) return tab.title
  if (tab.url === 'about:blank') return copy.browser.untitled
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}

/**
 * The person's own browser, like Claude Code's browser pane: tabs, an address bar and the page itself, streamed from
 * the Chrome Myrmidon runs, in a browser context agents never see. Only full-access devices have this view.
 */
export function BrowserView(props: {
  /** A link to open in a new tab (Open links in built-in browser); `at` tells two clicks on one link apart. */
  open?: { url: string; at: number }
}) {
  const [state, setState] = useState<BrowserState>()
  const [unavailable, setUnavailable] = useState(false)
  const [active, setActiveState] = useState(shownTab)
  const [problem, setProblem] = useState<Problem>()
  const [maximised, setMaximised] = useState(false)
  const setActive = (id: string | undefined) => {
    shownTab = id
    setActiveState(id)
  }
  const current = state?.tabs.find((t) => t.id === active) ?? state?.tabs.at(-1)
  const known = useRef(new Set<string>())

  const run = async (work: () => Promise<void>, retry?: () => void) => {
    setProblem(undefined)
    try {
      await work()
    } catch (err) {
      setProblem(problemOf(err, retry))
    }
  }
  const putTab = (tab: BrowserTab) => {
    known.current.add(tab.id)
    setState(
      (s) =>
        s && {
          ...s,
          tabs: s.tabs.some((t) => t.id === tab.id)
            ? s.tabs.map((t) => (t.id === tab.id ? tab : t))
            : [...s.tabs, tab],
        },
    )
  }
  const openTab = (url?: string) =>
    run(
      async () => {
        const { tab } = await post<{ tab: BrowserTab }>('/api/browser/tabs', url ? { url } : {})
        putTab(tab)
        setActive(tab.id)
      },
      () => void openTab(url),
    )

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once; a link to open is handled below
  useEffect(() => {
    let stop = false
    api<BrowserState>('/api/browser')
      .then(async (s) => {
        if (stop) return
        if (!s.available) return setUnavailable(true)
        for (const t of s.tabs) known.current.add(t.id)
        setState(s)
        // A browser with no tab opens on a blank one, as a new window does.
        if (s.tabs.length === 0 && !props.open) await openTab()
      })
      .catch((err) => {
        if (stop) return
        if (err instanceof ApiError && err.body?.error === 'no browser on this server') setUnavailable(true)
        else setProblem(problemOf(err))
      })
    return () => {
      stop = true
    }
  }, [])

  const loaded = state !== undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: each link click opens its tab once
  useEffect(() => {
    if (!props.open || !loaded || props.open.at === openedLink) return
    openedLink = props.open.at
    void openTab(props.open.url)
  }, [props.open?.at, loaded])

  const go = (to: { url: string } | { action: 'back' | 'forward' | 'reload' }) => {
    if (!current) return
    const id = current.id
    return run(
      async () => {
        const { tab } = await post<{ tab: BrowserTab }>(`/api/browser/tabs/${id}/go`, to)
        putTab(tab)
      },
      () => void go(to),
    )
  }
  const closeTab = (id: string) =>
    run(async () => {
      const at = state?.tabs.findIndex((t) => t.id === id) ?? -1
      const next = await send<BrowserState>('DELETE', `/api/browser/tabs/${id}`)
      setState((s) => s && { ...s, tabs: next.tabs })
      if (id === current?.id) setActive(next.tabs[Math.min(at, next.tabs.length - 1)]?.id)
    })
  const changeSettings = async (patch: Partial<BrowserSettings>) => {
    let saved: BrowserSettings | undefined
    await run(async () => {
      saved = (await send<BrowserState>('PUT', '/api/browser/settings', patch)).settings
      setState((s) => s && saved && { ...s, settings: saved })
    })
    return saved
  }
  const allow = (site: string, then?: () => void) =>
    run(async () => {
      const next = await send<BrowserState>('PUT', '/api/browser/settings', {
        allowedSites: [...(state?.settings.allowedSites ?? []), site],
      })
      setState((s) => s && { ...s, settings: next.settings })
      then?.()
    })

  // The tabs as the server has them: a page that opened a new window adds one, and it is shown, as browsers do.
  const onTabs = (tabs: BrowserTab[]) => {
    const opened = tabs.find((t) => !known.current.has(t.id))
    for (const t of tabs) known.current.add(t.id)
    setState((s) => s && { ...s, tabs })
    if (opened) setActive(opened.id)
  }

  useEffect(() => {
    if (!maximised) return
    const esc = (e: globalThis.KeyboardEvent) =>
      e.key === 'Escape' && !(e.target as HTMLElement).closest?.('[data-page]') && setMaximised(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [maximised])

  if (unavailable)
    return (
      <Empty icon={<FEATURE_ICONS.browser className="size-5" />} title={copy.browser.unavailable}>
        {copy.browser.unavailableBody}
      </Empty>
    )
  if (!state)
    return (
      <div className="grid h-full place-items-center p-6 text-callout text-muted">
        {problem?.text ?? copy.browser.connecting}
      </div>
    )

  const full = state.tabs.length >= state.maxTabs
  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col bg-surface',
        maximised && 'fixed inset-0 z-[60] pt-[env(safe-area-inset-top)]',
      )}
    >
      <div className="flex items-center gap-1 border-b border-line px-2 py-1">
        <TabStrip
          tabs={state.tabs}
          active={current?.id}
          onPick={setActive}
          onClose={(id) => void closeTab(id)}
        />
        <IconButton
          label={full ? copy.browser.newTabFull(state.maxTabs) : copy.browser.newTab}
          size="sm"
          disabled={full}
          onClick={() => void openTab()}
        >
          <Plus className="size-3.5" />
        </IconButton>
        <BrowserMenu
          tab={current}
          state={state}
          onSettings={changeSettings}
          onOpenFile={(html, name) =>
            void run(async () => {
              const { tab } = await post<{ tab: BrowserTab }>('/api/browser/tabs', { html, name })
              putTab(tab)
              setActive(tab.id)
            })
          }
          onClear={() =>
            void run(async () => {
              await post('/api/browser/clear', {})
            })
          }
          onProblem={setProblem}
        />
        <IconButton
          label={maximised ? copy.browser.restore : copy.browser.maximise}
          size="sm"
          onClick={() => setMaximised(!maximised)}
        >
          {maximised ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconButton>
      </div>
      {current ? (
        <>
          <AddressBar
            key={`address-${current.id}`}
            tab={current}
            onGo={(url) => void go({ url })}
            onAction={(action) => void go({ action })}
          />
          {problem && (
            <div
              role="alert"
              className="flex items-center gap-2 border-b border-line bg-warn-soft px-3 py-1.5 text-small text-warn-ink"
            >
              <span className="min-w-0 flex-1">{problem.text}</span>
              {problem.site && (
                <Button size="sm" onClick={() => void allow(problem.site ?? '', problem.retry)}>
                  {problem.retry ? copy.browser.allowAndOpen : copy.browser.allow}
                </Button>
              )}
              <IconButton label={copy.common.dismiss} size="sm" onClick={() => setProblem(undefined)}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          )}
          <PageScreen
            key={`page-${current.id}`}
            tab={current}
            onTabs={onTabs}
            onBlocked={(site) =>
              setProblem({
                text: copy.browser.blocked(site),
                site,
                retry: () => void go({ action: 'reload' }),
              })
            }
            onError={(text) => setProblem({ text })}
          />
        </>
      ) : (
        <Empty icon={<FEATURE_ICONS.browser className="size-5" />} title={copy.browser.untitled}>
          <Button icon={<Plus className="size-3.5" />} onClick={() => void openTab()}>
            {copy.browser.newTab}
          </Button>
        </Empty>
      )}
    </div>
  )
}

/**
 * The tabs along the top: each a favicon and title, with its own close button; arrow keys move between them. A list,
 * not an ARIA tablist: a tablist may hold only tabs, and each of these carries a close button beside it.
 */
export function TabStrip(props: {
  tabs: readonly BrowserTab[]
  active?: string
  onPick(id: string): void
  onClose(id: string): void
}) {
  const list = useRef<HTMLUListElement>(null)
  const move = (e: KeyboardEvent) => {
    const at = props.tabs.findIndex((t) => t.id === props.active)
    const next =
      e.key === 'ArrowRight'
        ? at + 1
        : e.key === 'ArrowLeft'
          ? at - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? props.tabs.length - 1
              : undefined
    if (next === undefined) return
    e.preventDefault()
    const tab = props.tabs[(next + props.tabs.length) % props.tabs.length]
    if (!tab) return
    props.onPick(tab.id)
    list.current?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus()
  }
  return (
    <ul
      ref={list}
      aria-label={copy.browser.tabsLabel}
      onKeyDown={move}
      className="m-0 flex min-w-0 flex-1 list-none items-center gap-0.5 overflow-x-auto p-0"
    >
      {props.tabs.map((t) => {
        const on = t.id === props.active
        const title = tabTitle(t)
        return (
          <li
            key={t.id}
            className={cn(
              'group flex h-7 min-w-0 max-w-44 shrink items-center rounded-md pl-2 pr-0.5',
              on ? 'bg-fill text-fg' : 'text-fg-2 hover:bg-fill/60',
            )}
          >
            <button
              type="button"
              data-tab={t.id}
              aria-current={on}
              tabIndex={on ? 0 : -1}
              title={title}
              onClick={() => props.onPick(t.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-small outline-none focus-visible:underline"
            >
              {t.loading ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted" />
              ) : t.favicon ? (
                <img src={t.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
              ) : (
                <FEATURE_ICONS.web className="size-3.5 shrink-0 text-muted" />
              )}
              <span className="truncate">{title}</span>
            </button>
            <IconButton
              label={copy.browser.closeTab(title)}
              size="sm"
              tabIndex={on ? 0 : -1}
              className="size-5"
              onClick={() => props.onClose(t.id)}
            >
              <X className="size-3" />
            </IconButton>
          </li>
        )
      })}
    </ul>
  )
}

function AddressBar(props: {
  tab: BrowserTab
  onGo(url: string): void
  onAction(action: 'back' | 'forward' | 'reload'): void
}) {
  const [typed, setTyped] = useState(shownAddress(props.tab))
  const [editing, setEditing] = useState(false)
  // The page moves on by itself (a link, a redirect): the bar follows unless the person is typing in it.
  const address = shownAddress(props.tab)
  useEffect(() => {
    if (!editing) setTyped(address)
  }, [address, editing])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
    props.onGo(typed)
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-1 border-b border-line px-2 py-1">
      <IconButton
        label={copy.browser.back}
        size="sm"
        disabled={!props.tab.canGoBack}
        onClick={() => props.onAction('back')}
      >
        <ArrowLeft className="size-3.5" />
      </IconButton>
      <IconButton
        label={copy.browser.forward}
        size="sm"
        disabled={!props.tab.canGoForward}
        onClick={() => props.onAction('forward')}
      >
        <ArrowRight className="size-3.5" />
      </IconButton>
      <IconButton label={copy.browser.reload} size="sm" onClick={() => props.onAction('reload')}>
        <RotateCw className={cn('size-3.5', props.tab.loading && 'animate-spin')} />
      </IconButton>
      <TextInput
        aria-label={copy.browser.address}
        placeholder={copy.browser.addressPlaceholder}
        value={typed}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.select()
        }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          // Escape puts back what the page is on, as a browser's address bar does.
          e.stopPropagation()
          setTyped(shownAddress(props.tab))
          e.currentTarget.blur()
        }}
        className="h-7 min-w-0 flex-1 font-mono text-footnote"
      />
    </form>
  )
}

/**
 * The page itself: frames from the tab's screencast, scaled to fit, and the person's mouse, wheel and keyboard sent
 * to it in the page's own pixels. In Responsive the page is laid out at the panel's size.
 */
function PageScreen(props: {
  tab: BrowserTab
  onTabs(tabs: BrowserTab[]): void
  onBlocked(site: string): void
  onError(text: string): void
}) {
  const [frame, setFrame] = useState<{ data: string; width: number; height: number }>()
  const [area, setArea] = useState({ width: 0, height: 0 })
  const [focused, setFocused] = useState(false)
  const socket = useRef<WebSocket>(undefined)
  const box = useRef<HTMLDivElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const handlers = useRef(props)
  handlers.current = props

  const send = (msg: object) => socket.current?.readyState === 1 && socket.current.send(JSON.stringify(msg))
  const sendSize = () => {
    const el = box.current
    if (!el?.clientWidth || !el.clientHeight) return
    send({
      type: 'resize',
      width: el.clientWidth,
      height: el.clientHeight,
      scale: window.devicePixelRatio || 1,
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: one socket per tab
  useEffect(() => {
    const ws = personBrowserSocket(props.tab.id)
    socket.current = ws
    ws.onopen = sendSize
    ws.onmessage = (msg) => {
      const e = JSON.parse(String(msg.data)) as LiveEvent
      if (e.type === 'frame') setFrame(e)
      else if (e.type === 'tabs') handlers.current.onTabs(e.tabs)
      else if (e.type === 'blocked') handlers.current.onBlocked(e.site)
      else if (e.type === 'error') handlers.current.onError(e.message)
    }
    return () => ws.close()
  }, [props.tab.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendSize reads the socket and box from refs
  useEffect(() => {
    const el = box.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      setArea({ width: el.clientWidth, height: el.clientHeight })
      clearTimeout(timer)
      timer = setTimeout(sendSize, BROWSER_RESIZE_MS)
    })
    ro.observe(el)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [])

  // A fixed viewport larger than the panel is shown smaller; one that fits is shown at its own size.
  const fit = frame && area.width ? Math.min(1, area.width / frame.width, area.height / frame.height) : 1
  const point = (e: MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / fit, y: (e.clientY - r.top) / fit }
  }
  const button = (e: MouseEvent) => (e.button === 2 ? 'right' : 'left')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={box} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-fill">
        <div
          ref={screen}
          data-page
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the page is a remote surface (role application) that takes the keyboard
          tabIndex={0}
          role="application"
          aria-label={copy.browser.pageLabel(tabTitle(props.tab))}
          className="relative overflow-hidden bg-white outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={
            frame
              ? { width: frame.width * fit, height: frame.height * fit }
              : { width: '100%', height: '100%' }
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onMouseMove={(e) => send({ type: 'mouse', action: 'move', ...point(e) })}
          onMouseDown={(e) => {
            e.currentTarget.focus()
            send({ type: 'mouse', action: 'down', ...point(e), button: button(e) })
          }}
          onMouseUp={(e) => send({ type: 'mouse', action: 'up', ...point(e), button: button(e) })}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => send({ type: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          onKeyDown={(e) => {
            if (matchCombo(LEAVE_PAGE, e)) {
              e.preventDefault()
              screen.current?.blur()
              return
            }
            // ⌘ and Ctrl shortcuts stay this app's (paste, below); AltGr types a character, which goes to the page.
            if ((e.metaKey || e.ctrlKey) && !e.getModifierState('AltGraph')) return
            e.preventDefault()
            if (KEYS.has(e.key)) send({ type: 'key', key: e.key })
            else if (e.key.length === 1) send({ type: 'text', text: e.key })
          }}
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            if (text) send({ type: 'paste', text })
          }}
        >
          {frame ? (
            <img
              alt=""
              draggable={false}
              src={`data:image/jpeg;base64,${frame.data}`}
              className="pointer-events-none absolute inset-0 size-full select-none"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-callout text-muted">
              {copy.browser.connecting}
            </div>
          )}
        </div>
      </div>
      {focused && (
        <p className="border-t border-line px-3 py-1 text-footnote text-muted">
          {copy.browser.keyboardHint(comboLabel('mod+v', isMac), comboLabel(LEAVE_PAGE, isMac))}
        </p>
      )}
    </div>
  )
}

/** The ⋯ menu, as in Claude Code's browser pane; Manage allowed sites… turns it into the list of sites. */
export function BrowserMenu(props: {
  tab?: BrowserTab
  state: BrowserState
  onSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings | undefined>
  onOpenFile(html: string, name: string): void
  onClear(): void
  onProblem(problem: Problem): void
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<'options' | 'sites'>('options')
  const [linksHere, setLinksHere] = usePersistentFlag(BROWSER_LINKS_KEY, false)
  const within = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const m = copy.browser.menu
  const url = props.tab?.url ?? ''
  const web = /^https?:/.test(url)
  const close = () => {
    setOpen(false)
    setPage('options')
  }
  const act = (fn: () => void) => () => {
    close()
    fn()
  }
  const screenshot = async () => {
    if (!props.tab) return
    try {
      const blob = await postForBlob(`/api/browser/tabs/${props.tab.id}/screenshot`, {})
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = m.screenshotName
      a.click()
      URL.revokeObjectURL(href)
    } catch (err) {
      props.onProblem(problemOf(err))
    }
  }
  return (
    <div ref={within} className="relative">
      <IconButton
        label={copy.browser.options}
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Ellipsis className="size-3.5" />
      </IconButton>
      <input
        ref={picker}
        type="file"
        accept=".html,.htm,text/html"
        aria-label={m.openFileLabel}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          if (file.size > props.state.maxHtmlBytes)
            return props.onProblem({ text: copy.browser.refused.size })
          props.onOpenFile(await file.text(), file.name)
        }}
      />
      <AnimatePresence>
        {open && (
          <Popover
            role="dialog"
            label={page === 'sites' ? copy.browser.sites.title : copy.browser.options}
            onClose={close}
            within={within}
            className="material-menu absolute right-0 top-[calc(100%+4px)] z-50 max-h-[min(80vh,640px)] w-72 overflow-y-auto rounded-lg border border-line p-1.5 shadow-pop"
          >
            {page === 'sites' ? (
              <AllowedSites
                sites={props.state.settings.allowedSites}
                onChange={async (allowedSites) => (await props.onSettings({ allowedSites }))?.allowedSites}
                onBack={() => setPage('options')}
              />
            ) : (
              <>
                <MenuList label={copy.browser.options}>
                  <MenuItem
                    icon={<ExternalLink className="size-4 text-muted" />}
                    title={m.openOutside}
                    tabStop
                    onSelect={act(() => web && window.open(url, '_blank', 'noopener,noreferrer'))}
                  />
                  <MenuItem
                    icon={<Copy className="size-4 text-muted" />}
                    title={m.copyUrl}
                    onSelect={act(() => {
                      void navigator.clipboard.writeText(url).then(() => toast(m.copied, 'success'))
                    })}
                  />
                  <MenuItem
                    icon={<Camera className="size-4 text-muted" />}
                    title={m.screenshot}
                    onSelect={act(() => void screenshot())}
                  />
                  <MenuItem
                    icon={<FileUp className="size-4 text-muted" />}
                    title={m.openFile}
                    onSelect={act(() => picker.current?.click())}
                  />
                </MenuList>
                <MenuSeparator />
                <GroupLabel>{m.viewport}</GroupLabel>
                <MenuList label={m.viewport}>
                  {VIEWPORTS.map((v) => (
                    <MenuItem
                      key={v.value}
                      icon={v.icon}
                      title={m.viewports[v.value]}
                      detail={m.viewportDetail[v.value]}
                      checked={props.state.settings.viewport === v.value}
                      onSelect={() => void props.onSettings({ viewport: v.value })}
                    />
                  ))}
                </MenuList>
                <MenuSeparator />
                <MenuList label={copy.browser.options}>
                  <MenuItem
                    icon={<Link className="size-4 text-muted" />}
                    title={m.linksHere}
                    detail={m.linksHereDetail}
                    checked={linksHere}
                    toggle
                    tabStop
                    onSelect={() => setLinksHere(!linksHere)}
                  />
                  <MenuItem
                    icon={<EthernetPort className="size-4 text-muted" />}
                    title={m.allowedSites}
                    onSelect={() => setPage('sites')}
                  />
                </MenuList>
                <MenuSeparator />
                <GroupLabel>{m.cookies}</GroupLabel>
                <MenuList label={m.cookies}>
                  {COOKIE_MODES.map((mode) => (
                    <MenuItem
                      key={mode}
                      icon={<Cookie className="size-4 text-muted" />}
                      title={m.cookieModes[mode]}
                      detail={m.cookieDetail[mode]}
                      checked={props.state.settings.cookies === mode}
                      onSelect={() => void props.onSettings({ cookies: mode })}
                    />
                  ))}
                </MenuList>
                <MenuSeparator />
                <div className="flex justify-end px-1 py-1">
                  <ConfirmButton
                    label={m.clear}
                    confirm={m.clearConfirm}
                    warning={m.clearWarning}
                    onConfirm={() => {
                      close()
                      props.onClear()
                      toast(m.cleared, 'success')
                    }}
                  />
                </div>
              </>
            )}
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}

function GroupLabel(props: { children: ReactNode }) {
  return (
    <div aria-hidden="true" className="section-label px-2 pt-1 pb-0.5 text-muted">
      {props.children}
    </div>
  )
}

/** The ports on this computer the person's browser may open, besides Myrmidon's own. */
function AllowedSites(props: {
  sites: readonly string[]
  /** Saves the list; the server keeps only ports on this computer, so what it gives back says what was kept. */
  onChange(sites: string[]): Promise<readonly string[] | undefined>
  onBack(): void
}) {
  const [typed, setTyped] = useState('')
  const [invalid, setInvalid] = useState(false)
  const s = copy.browser.sites
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const kept = await props.onChange([...props.sites, typed])
    const added = kept !== undefined && kept.length > props.sites.length
    setInvalid(kept !== undefined && !added)
    if (added) setTyped('')
  }
  return (
    <div className="flex flex-col gap-2 p-1.5">
      <div className="flex items-center gap-1">
        <IconButton label={s.back} size="sm" onClick={props.onBack}>
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <h3 className="text-body font-semibold">{s.title}</h3>
      </div>
      <p className="text-footnote leading-snug text-muted">{s.body}</p>
      {props.sites.length === 0 ? (
        <p className="text-small text-muted">{s.empty}</p>
      ) : (
        <ul className="flex flex-col">
          {props.sites.map((site) => (
            <li key={site} className="flex items-center justify-between gap-2 py-0.5 font-mono text-small">
              {site}
              <IconButton
                label={s.remove(site)}
                size="sm"
                onClick={() => void props.onChange(props.sites.filter((x) => x !== site))}
              >
                <X className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void add(e)} className="flex items-center gap-1.5">
        <TextInput
          data-autofocus
          aria-label={s.addLabel}
          aria-invalid={invalid || undefined}
          placeholder={s.addPlaceholder}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="h-7 min-w-0 flex-1 font-mono text-small"
        />
        <Button size="sm" type="submit" disabled={!typed.trim()}>
          {s.add}
        </Button>
      </form>
      {invalid && (
        <p role="alert" className="text-small text-bad-ink">
          {s.invalid}
        </p>
      )}
    </div>
  )
}
