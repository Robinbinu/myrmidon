import { useEffect, useState } from 'react'
import { loadVisualLibs } from './load-libs.ts'
import { svgUrl, type VisualTheme } from './theme.ts'

/**
 * Mermaid sizes its SVG to its container (`width="100%"`, a max-width style), which an image has none of: the
 * drawing gets its own size from its viewBox, and the image shrinks it to fit a narrow chat.
 */
export function sized(svg: string): string {
  const box = /viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(svg)
  if (!box) return svg
  return svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\s(width|height)="[^"]*"/g, '')
      .replace(/\sstyle="[^"]*"/, '')
      .replace(/^<svg/, `<svg width="${box[1]}" height="${box[2]}"`),
  )
}

let made = 0
/** Mermaid draws one diagram at a time (its settings are global); diagrams wait their turn. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Mermaid's SVG for `source` in the app's theme. Strict security (labels are text, no click handlers) and labels
 * drawn as SVG text, not HTML, so the drawing stands on its own as an image.
 */
export function drawMermaid(source: string, theme: VisualTheme): Promise<string> {
  const run = queue.then(async () => {
    const { mermaid } = await loadVisualLibs()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: theme.font,
      themeVariables: {
        darkMode: theme.dark,
        background: theme.surface,
        fontFamily: theme.font,
        fontSize: '14px',
        primaryColor: theme.fill,
        primaryTextColor: theme.fg,
        primaryBorderColor: theme.muted,
        secondaryColor: theme.surface,
        secondaryTextColor: theme.fg,
        secondaryBorderColor: theme.line,
        tertiaryColor: theme.surface,
        tertiaryTextColor: theme.fg,
        tertiaryBorderColor: theme.line,
        lineColor: theme.muted,
        textColor: theme.fg,
        mainBkg: theme.fill,
        nodeBorder: theme.muted,
        clusterBkg: theme.surface,
        clusterBorder: theme.line,
        titleColor: theme.fg,
        edgeLabelBackground: theme.surface,
        noteBkgColor: theme.fill,
        noteTextColor: theme.fg,
        noteBorderColor: theme.line,
        actorBkg: theme.fill,
        actorBorder: theme.muted,
        actorTextColor: theme.fg,
        signalColor: theme.fg,
        signalTextColor: theme.fg,
        labelBoxBkgColor: theme.fill,
        labelTextColor: theme.fg,
        pie1: theme.series[0],
        pie2: theme.series[1],
        pie3: theme.series[2],
        pie4: theme.series[3],
        pie5: theme.series[4],
        pie6: theme.series[5],
        pieStrokeColor: theme.surface,
        pieTitleTextColor: theme.fg,
        pieSectionTextColor: theme.surface,
        pieLegendTextColor: theme.fg,
      },
    })
    made += 1
    const { svg } = await mermaid.render(`myr-mermaid-${made}`, source)
    return sized(svg)
  })
  queue = run.catch(() => {})
  return run
}

/** A Mermaid diagram, drawn as an image: whatever its source says, nothing in it can run in the app. */
export function Diagram(props: {
  source: string
  theme: VisualTheme
  label: string
  onReady(svg: string): void
  onError(message: string): void
}) {
  const [svg, setSvg] = useState<string>()
  const { source, theme, onReady, onError } = props
  useEffect(() => {
    let stopped = false
    drawMermaid(source, theme)
      .then((out) => {
        if (stopped) return
        setSvg(out)
        onReady(out)
      })
      .catch((err) => !stopped && onError(err instanceof Error ? err.message : String(err)))
    return () => {
      stopped = true
    }
  }, [source, theme, onReady, onError])
  if (!svg) return <div className="h-32 animate-pulse rounded-md bg-fill less-motion:animate-none" />
  return <img src={svgUrl(svg)} alt={props.label} className="mx-auto block h-auto max-w-full" />
}
