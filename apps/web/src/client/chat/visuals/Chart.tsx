import { useEffect, useRef } from 'react'
import { CHART_HEIGHT_PX } from '../../ui-config.ts'
import { loadVisualLibs } from './load-libs.ts'
import type { VisualTheme } from './theme.ts'

/** What a drawn chart can hand back for its toolbar's download. */
export interface ChartHandle {
  png(): Promise<string>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** `over` laid on `base`, objects merged key by key: the app's theme wins over a spec's own colours. */
function merged(base: unknown, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) out[k] = isRecord(v) && isRecord(out[k]) ? merged(out[k], v) : v
  return out
}

/** Vega-Lite config from the app's theme: its text and line colours, the series palette, recessive axes. */
export function chartConfig(theme: VisualTheme): Record<string, unknown> {
  const label = {
    labelColor: theme.muted,
    titleColor: theme.fg2,
    labelFont: theme.font,
    titleFont: theme.font,
  }
  return {
    background: null,
    font: theme.font,
    padding: 4,
    view: { stroke: null },
    axis: {
      ...label,
      domainColor: theme.line,
      tickColor: theme.line,
      gridColor: theme.line,
      gridOpacity: 0.6,
    },
    legend: { ...label, labelFontSize: 12, titleFontSize: 12 },
    header: { ...label },
    title: { color: theme.fg, subtitleColor: theme.muted, anchor: 'start', fontSize: 14, fontWeight: 600 },
    range: { category: [...theme.series] },
    mark: { color: theme.series[0] },
    bar: { cornerRadiusEnd: 4 },
    line: { strokeWidth: 2 },
    point: { size: 64, filled: true },
    arc: { stroke: theme.surface, strokeWidth: 2 },
    rect: { stroke: theme.surface },
    text: { color: theme.fg },
    rule: { color: theme.muted },
  }
}

/** A loader that loads nothing: data comes inline, and no link, image or file is ever fetched. */
const noLoads = {
  options: {},
  sanitize: () => Promise.reject(new Error('loading by address is turned off')),
  load: () => Promise.reject(new Error('loading by address is turned off')),
  http: () => Promise.reject(new Error('loading by address is turned off')),
  file: () => Promise.reject(new Error('loading by address is turned off')),
}

/**
 * A Vega-Lite chart, compiled and drawn as SVG. Expressions run in Vega's interpreter, not compiled to functions, so
 * a spec's expressions can never become code in the app; the loader refuses every load.
 */
export function Chart(props: {
  spec: Record<string, unknown>
  theme: VisualTheme
  onReady(handle: ChartHandle): void
  onError(message: string): void
}) {
  const el = useRef<HTMLDivElement>(null)
  const { spec, theme, onReady, onError } = props
  useEffect(() => {
    let stopped = false
    let finalize: (() => void) | undefined
    void (async () => {
      try {
        const libs = await loadVisualLibs()
        if (stopped || !el.current) return
        const sized = {
          width: 'container',
          height: CHART_HEIGHT_PX,
          autosize: { type: 'fit-x', contains: 'padding' },
          ...spec,
          // A title wider than a narrow chat ends in an ellipsis instead of running off the chart (the frame's
          // caption names it in full).
          config: merged(merged(spec.config, chartConfig(theme)), {
            title: { limit: Math.max(120, el.current.clientWidth - 24) },
          }),
        }
        // Containers fill the width; a chart that asks for a fixed size keeps it (and scrolls on a narrow screen).
        const compiled = libs.vegaLiteCompile(sized as never).spec
        const view = new libs.VegaView(libs.vegaParse(compiled, undefined, { ast: true }), {
          renderer: 'svg',
          container: el.current,
          hover: true,
          expr: libs.expressionInterpreter,
          loader: noLoads as never,
        })
        finalize = () => view.finalize()
        await view.runAsync()
        if (stopped) return view.finalize()
        onReady({ png: () => view.toImageURL('png', 2) })
      } catch (err) {
        if (!stopped) onError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      stopped = true
      finalize?.()
    }
  }, [spec, theme, onReady, onError])
  return <div ref={el} className="w-full min-w-0 overflow-x-auto [&_svg]:max-w-none" />
}
