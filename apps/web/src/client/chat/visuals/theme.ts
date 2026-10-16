import { useEffect, useState } from 'react'

/**
 * The app's theme as plain colours, for what draws outside its CSS: Vega and Mermaid take colours as values, and a
 * figure drawn as an image or a widget in its own frame cannot see the page's variables. Read again when the theme
 * changes (the person's choice, an imported theme, or the system going dark).
 */
export interface VisualTheme {
  readonly dark: boolean
  readonly fg: string
  readonly fg2: string
  readonly muted: string
  readonly line: string
  readonly surface: string
  readonly fill: string
  readonly accent: string
  readonly ok: string
  readonly warn: string
  readonly bad: string
  /** Chart series, in order. */
  readonly series: readonly string[]
  readonly font: string
  readonly mono: string
}

const FALLBACK: VisualTheme = {
  dark: false,
  fg: '#1d1d1f',
  fg2: '#424245',
  muted: '#616166',
  line: '#d2d2d7',
  surface: '#ffffff',
  fill: '#f2f2f7',
  accent: '#ffb31a',
  ok: '#34c759',
  warn: '#ff9500',
  bad: '#ff3b30',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
  font: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: 'ui-monospace, Menlo, monospace',
}

/** A colour as the browser resolves it (`rgb(…)`), so libraries that parse colours read it whatever the token says. */
function resolved(probe: HTMLElement, value: string, fallback: string): string {
  if (!value) return fallback
  probe.style.color = ''
  probe.style.color = value
  const out = getComputedStyle(probe).color
  return out || value
}

/** Whether a resolved colour is dark (its luminance under one half). */
function isDark(color: string): boolean {
  const m =
    /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(color) ??
    /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(color)
  if (!m) return false
  const [r, g, b] = m
    .slice(1, 4)
    .map((n) => (n.length === 2 && /[a-f]/i.test(n) ? Number.parseInt(n, 16) : Number(n)))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) < 128
}

export function readVisualTheme(): VisualTheme {
  if (typeof document === 'undefined' || !document.body) return FALLBACK
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => css.getPropertyValue(name).trim()
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  try {
    const color = (name: string, fallback: string) => resolved(probe, token(name), fallback)
    const surface = color('--content', FALLBACK.surface)
    const series = [1, 2, 3, 4, 5, 6].map((n, i) => color(`--series-${n}`, FALLBACK.series[i] as string))
    return {
      dark: isDark(surface),
      fg: color('--label', FALLBACK.fg),
      fg2: color('--label-2', FALLBACK.fg2),
      muted: color('--label-3', FALLBACK.muted),
      line: color('--separator-strong', FALLBACK.line),
      surface,
      fill: color('--fill', FALLBACK.fill),
      accent: color('--accent', FALLBACK.accent),
      ok: color('--ok', FALLBACK.ok),
      warn: color('--warn', FALLBACK.warn),
      bad: color('--bad', FALLBACK.bad),
      series,
      font: token('--font') || FALLBACK.font,
      mono: token('--mono') || FALLBACK.mono,
    }
  } finally {
    probe.remove()
  }
}

/** Whether the person asked for less motion (in the system, or in Settings → General). */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return false
  return (
    document.documentElement.hasAttribute('data-reduce-motion') ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  )
}

/** The theme's colours, read again whenever the theme changes. */
export function useVisualTheme(): VisualTheme {
  const [theme, setTheme] = useState(readVisualTheme)
  useEffect(() => {
    const again = () => setTheme(readVisualTheme())
    const watched = new MutationObserver(again)
    watched.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette', 'style', 'class'],
    })
    // An imported theme sets its tokens in a style element of its own.
    watched.observe(document.head, { childList: true, subtree: true, characterData: true })
    const system = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    system?.addEventListener('change', again)
    return () => {
      watched.disconnect()
      system?.removeEventListener('change', again)
    }
  }, [])
  return theme
}

/**
 * An SVG with theme references made concrete, for drawing as an image: `var(--fg)` and the like (the names omp's
 * figures use, and the app's own tokens) and `currentColor` become the theme's colours.
 */
export function themedSvg(svg: string, theme: VisualTheme): string {
  const named: Record<string, string> = {
    fg: theme.fg,
    text: theme.fg,
    label: theme.fg,
    'label-2': theme.fg2,
    muted: theme.muted,
    'label-3': theme.muted,
    border: theme.line,
    line: theme.line,
    separator: theme.line,
    surface: theme.surface,
    content: theme.surface,
    bg: theme.surface,
    fill: theme.fill,
    accent: theme.accent,
    success: theme.ok,
    ok: theme.ok,
    warning: theme.warn,
    warn: theme.warn,
    error: theme.bad,
    bad: theme.bad,
    ...Object.fromEntries(
      theme.series.flatMap((c, i) => [
        [`c${i + 1}`, c],
        [`series-${i + 1}`, c],
      ]),
    ),
  }
  return svg
    .replace(
      /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
      (all, name: string, fallback?: string) => named[name] ?? fallback?.trim() ?? all,
    )
    .replace(/currentColor/g, theme.fg)
}

/** An SVG as an address an <img> can show. */
export const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
