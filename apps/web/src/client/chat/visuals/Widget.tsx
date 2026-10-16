import { RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { copy } from '../../copy.ts'
import { WIDGET_MAX_PX, WIDGET_MIN_PX } from '../../ui-config.ts'
import { reducedMotion, type VisualTheme } from './theme.ts'

/**
 * What a widget's frame allows, after MCP Apps' default policy for a view (SEP-1865) with its network closed: its own
 * inline script and style, pictures and fonts given inline, nothing fetched, framed, submitted or opened.
 */
export const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * The frame's sandbox: scripts only. Without allow-same-origin the page has an opaque origin of its own (no cookies,
 * storage or token of the app, no reach into the app's page); without allow-popups, allow-forms and
 * allow-top-navigation it can open, submit or lead nothing out of the chat.
 */
export const WIDGET_SANDBOX = 'allow-scripts'

/** The message a widget's own script sends with its height, so the frame fits its content. */
const SIZE = 'myr-widget-size'

/** A page that refreshes itself somewhere else would leave the sandbox's page for one off the network. */
const stripRefresh = (html: string) => html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')

/**
 * The widget's whole page: the policy first, before anything of the agent's is read; the theme's colours as CSS
 * variables (the names omp's figures use); less motion when the person asked for it; then the agent's HTML.
 */
export function widgetDocument(html: string, theme: VisualTheme, id: string, still: boolean): string {
  const vars = [
    `--fg:${theme.fg}`,
    `--fg-2:${theme.fg2}`,
    `--muted:${theme.muted}`,
    `--border:${theme.line}`,
    `--surface:${theme.surface}`,
    `--fill:${theme.fill}`,
    `--accent:${theme.accent}`,
    `--success:${theme.ok}`,
    `--warning:${theme.warn}`,
    `--error:${theme.bad}`,
    ...theme.series.map((c, i) => `--c${i + 1}:${c}`),
    `--font:${theme.font}`,
    `--mono:${theme.mono}`,
  ].join(';')
  const motion = still
    ? '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}'
    : ''
  const size = `(()=>{const send=()=>parent.postMessage({type:${JSON.stringify(SIZE)},id:${JSON.stringify(id)},height:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*');new ResizeObserver(send).observe(document.documentElement);addEventListener('load',send);send()})()`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${vars};color-scheme:${theme.dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.5 var(--font)}body{padding:8px 12px}${motion}</style><script>${size}</script></head><body>${stripRefresh(html)}</body></html>`
}

let made = 0

/**
 * An agent's interactive HTML, in a sandboxed frame of its own (see WIDGET_SANDBOX and WIDGET_CSP). The app sends it
 * nothing and reads only its height from it, from its own frame. A widget that leads its frame to another page is
 * stopped there, and can be run again.
 */
export function Widget(props: { html: string; theme: VisualTheme; title?: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const id = useMemo(() => `w${++made}`, [])
  const [height, setHeight] = useState(WIDGET_MIN_PX)
  const [left, setLeft] = useState(false)
  const [run, setRun] = useState(0)
  const loads = useRef(0)
  const doc = useMemo(
    () => widgetDocument(props.html, props.theme, id, reducedMotion()),
    [props.html, props.theme, id],
  )
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data as { type?: unknown; id?: unknown; height?: unknown }
      if (d?.type !== SIZE || d.id !== id || typeof d.height !== 'number' || !Number.isFinite(d.height))
        return
      setHeight(Math.min(WIDGET_MAX_PX, Math.max(WIDGET_MIN_PX, d.height)))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new document or a reload starts the count again
  useEffect(() => {
    loads.current = 0
    setLeft(false)
  }, [doc, run])
  if (left)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-callout text-muted">
        <span>{copy.visuals.widget.left}</span>
        <button
          type="button"
          onClick={() => setRun((n) => n + 1)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-fg-2 hover:bg-fill-strong hover:text-fg"
        >
          <RotateCcw className="size-3.5" /> {copy.visuals.widget.reload}
        </button>
      </div>
    )
  return (
    <iframe
      key={run}
      ref={frame}
      title={copy.visuals.widget.label(props.title)}
      sandbox={WIDGET_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={doc}
      onLoad={() => {
        loads.current += 1
        // The first load is the widget's own page; any after it is a page the widget went to.
        if (loads.current > 1) setLeft(true)
      }}
      style={{ height }}
      className="block w-full border-0 bg-transparent"
    />
  )
}
