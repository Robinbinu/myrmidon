import { type VisualKind, visualTitle } from '@myrmidon/protocol'
import { Check, Copy, Download } from 'lucide-react'
import { Component, type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { copy } from '../../copy.ts'
import { useCopy } from '../../ui/hooks.ts'
import { FEATURE_ICONS } from '../../ui/icons.ts'

import { Chart, type ChartHandle } from './Chart.tsx'
import { DataTable, toCsv } from './DataTable.tsx'
import { Diagram } from './Diagram.tsx'
import { JsonTree } from './JsonTree.tsx'
import { parseVisual, type Visual as VisualSpec } from './spec.ts'
import { svgUrl, themedSvg, useVisualTheme } from './theme.ts'
import { Widget } from './Widget.tsx'

const say = copy.visuals

/** Saves `data` (text, or an address such as a PNG's data: URL) as a file. */
export function saveFile(name: string, data: string, type: string) {
  const url =
    data.startsWith('data:') || data.startsWith('blob:')
      ? data
      : URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  if (url !== data) URL.revokeObjectURL(url)
}

const tool =
  'inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors hover:bg-fill-strong hover:text-fg less-motion:transition-none'

/**
 * The frame every visual sits in: what it is (its title when it names one), and its tools: the source it was drawn
 * from (to read or copy) and a download of what is drawn.
 */
export function VisualFrame(props: {
  kind: string
  title?: string
  source?: string
  download?: { label: string; run(): void }
  /** Drawn inside a paragraph (a picture in a line of text), where a figure may not go. */
  inline?: boolean
  children: ReactNode
}) {
  const [copied, copySource] = useCopy()
  const [showing, setShowing] = useState(false)
  const Frame = props.inline ? 'span' : 'figure'
  const Caption = props.inline ? 'span' : 'figcaption'
  return (
    <Frame
      role={props.inline ? 'figure' : undefined}
      className="my-3 block min-w-0 overflow-hidden rounded-lg border border-line bg-surface"
    >
      <Caption className="flex items-center justify-between gap-2 border-b border-line bg-fill py-1 pl-3 pr-1.5 text-footnote text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <FEATURE_ICONS.visuals className="size-3.5 shrink-0" />
          <span className="truncate">
            <span className="font-medium text-fg-2">{props.kind}</span>
            {props.title && <span> · {props.title}</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center">
          {props.source !== undefined && (
            <>
              <button
                type="button"
                onClick={() => setShowing((s) => !s)}
                aria-pressed={showing}
                className={tool}
              >
                {showing ? say.hideSource : say.showSource}
              </button>
              <button
                type="button"
                onClick={() => copySource(props.source ?? '')}
                title={say.copySource}
                aria-label={say.copySource}
                className={tool}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                <span className="sr-only">{copied ? copy.markdown.copied : say.copySource}</span>
              </button>
            </>
          )}
          {props.download && (
            <button
              type="button"
              onClick={props.download.run}
              title={props.download.label}
              aria-label={props.download.label}
              className={tool}
            >
              <Download className="size-3.5" />
            </button>
          )}
        </span>
      </Caption>
      {props.children}
      {showing && props.source !== undefined && (
        <pre className="max-h-[360px] overflow-auto border-t border-line bg-code p-3.5 font-mono text-callout leading-relaxed">
          <code>{props.source}</code>
        </pre>
      )}
    </Frame>
  )
}

/** A visual's fence as plain code, with why it was not drawn. */
function NotDrawn(props: { kind: string; why: string; children?: ReactNode }) {
  return (
    <div className="my-3">
      <p role="note" className="mb-1 text-footnote text-muted">
        {say.cantDraw(props.kind, props.why)}
      </p>
      {props.children}
    </div>
  )
}

/** Turns a renderer that throws while drawing into the fence's code, with the reason. */
class Fallback extends Component<
  { fallback(error: string): ReactNode; children: ReactNode },
  { error?: string }
> {
  override state: { error?: string } = {}
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override render() {
    return this.state.error !== undefined ? this.props.fallback(this.state.error) : this.props.children
  }
}

/** A visual still being written: a quiet placeholder until its fence closes. */
function Pending({ kind }: { kind: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line bg-surface" aria-busy="true">
      <div className="border-b border-line bg-fill px-3 py-1.5 text-footnote text-muted">
        {say.drawing(kind)}
      </div>
      <div className="h-24 animate-pulse bg-fill less-motion:animate-none" />
    </div>
  )
}

/**
 * A visual fence in a reply. Drawn once its fence closes (until then a placeholder, while the reply streams); a spec
 * that fails its check, or a renderer that fails, shows the fence as code with the reason: the text never goes.
 */
export function VisualFence(props: {
  kind: VisualKind
  lang: string
  code: string
  closed: boolean
  /** The code block to show when it is not drawn. */
  codeBlock: ReactNode
}) {
  const label = say.kinds[props.kind]
  const parsed = useMemo(
    () => (props.closed ? parseVisual(props.kind, props.code) : undefined),
    [props.closed, props.kind, props.code],
  )
  const [failed, setFailed] = useState<string>()
  if (!props.closed) return <Pending kind={label} />
  if (!parsed) return null
  if (!parsed.ok || failed !== undefined)
    return (
      <NotDrawn kind={label} why={failed ?? (parsed.ok ? '' : parsed.error)}>
        {props.codeBlock}
      </NotDrawn>
    )
  return (
    <Fallback
      fallback={(error) => (
        <NotDrawn kind={label} why={say.errors.render(error)}>
          {props.codeBlock}
        </NotDrawn>
      )}
    >
      <DrawnVisual
        visual={parsed.visual}
        source={props.code}
        title={visualTitle(props.kind, props.code)}
        onError={(m) => setFailed(say.errors.render(m))}
      />
    </Fallback>
  )
}

/** A checked visual, drawn in its frame with its tools. */
export function DrawnVisual(props: {
  visual: VisualSpec
  source?: string
  title?: string
  onError(message: string): void
}) {
  const theme = useVisualTheme()
  const { visual, onError } = props
  const label = say.kinds[visual.kind]
  const file = say.fileName(label)
  const chart = useRef<ChartHandle>(undefined)
  const diagram = useRef<string>(undefined)
  const onChart = useCallback((h: ChartHandle) => {
    chart.current = h
  }, [])
  const onDiagram = useCallback((svg: string) => {
    diagram.current = svg
  }, [])
  const frame = (download: { label: string; run(): void } | undefined, body: ReactNode) => (
    <VisualFrame kind={label} title={props.title} source={props.source} download={download}>
      {body}
    </VisualFrame>
  )
  switch (visual.kind) {
    case 'chart':
      return frame(
        {
          label: say.downloadAs('PNG'),
          run: () => void chart.current?.png().then((url) => saveFile(`${file}.png`, url, 'image/png')),
        },
        <div className="px-2 py-2">
          <Chart spec={visual.spec} theme={theme} onReady={onChart} onError={onError} />
        </div>,
      )
    case 'mermaid':
      return frame(
        {
          label: say.downloadAs('SVG'),
          run: () => diagram.current && saveFile(`${file}.svg`, diagram.current, 'image/svg+xml'),
        },
        <div className="overflow-x-auto px-3 py-3">
          <Diagram
            source={visual.source}
            theme={theme}
            label={props.title ?? label}
            onReady={onDiagram}
            onError={onError}
          />
        </div>,
      )
    case 'table':
      return frame(
        {
          label: say.downloadAs('CSV'),
          run: () => saveFile(`${file}.csv`, toCsv(visual.columns, visual.rows), 'text/csv'),
        },
        <DataTable columns={visual.columns} rows={visual.rows} caption={visual.caption} />,
      )
    case 'tree':
      return frame(
        {
          label: say.downloadAs('JSON'),
          run: () => saveFile(`${file}.json`, JSON.stringify(visual.value, null, 2), 'application/json'),
        },
        <JsonTree value={visual.value} />,
      )
    case 'svg': {
      const drawn = themedSvg(visual.svg, theme)
      return frame(
        { label: say.downloadAs('SVG'), run: () => saveFile(`${file}.svg`, drawn, 'image/svg+xml') },
        <div className="overflow-x-auto px-3 py-3">
          <img src={svgUrl(drawn)} alt={props.title ?? label} className="mx-auto block h-auto max-w-full" />
        </div>,
      )
    }
    case 'widget':
      return frame(
        { label: say.downloadAs('HTML'), run: () => saveFile(`${file}.html`, visual.html, 'text/html') },
        <Widget html={visual.html} theme={theme} title={props.title} />,
      )
  }
}

/** A picture in a reply or a cell's display, framed with its download. */
export function VisualImage(props: { src: string; alt: string; name: string; inline?: boolean }) {
  return (
    <VisualFrame
      inline={props.inline}
      kind={say.kinds.image}
      title={props.alt || undefined}
      download={{ label: say.download, run: () => saveFile(props.name, props.src, '') }}
    >
      <img src={props.src} alt={props.alt} className="mx-auto block h-auto max-w-full" />
    </VisualFrame>
  )
}
