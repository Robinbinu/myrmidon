import { copy } from '../copy.ts'
import { THEME_IMPORT } from '../ui-config.ts'

/**
 * VS Code colour themes on Myrmidon's tokens. A theme, built in or imported, is the part of a VS Code theme file this
 * reads (THEME_KEYS and a few token colours); `themeTokens` turns it into values for the tokens in tokens.css,
 * deriving what a theme leaves out and nudging text until it reads at WCAG AA. The mapping is documented in
 * docs/research/2026-10-09-themes.md.
 */

export type ThemeKind = 'dark' | 'light'

/** The token colours a theme gives code, by what they colour. */
export type SyntaxRole = 'comment' | 'string' | 'keyword' | 'function' | 'number'

export interface ThemeData {
  id: string
  name: string
  type: ThemeKind
  /** VS Code workbench colours, by key; only THEME_KEYS are read. */
  colors: Readonly<Record<string, string>>
  syntax?: Readonly<Partial<Record<SyntaxRole, string>>>
}

const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const

/** The VS Code colour keys Myrmidon reads; an imported theme keeps only these. */
export const THEME_KEYS: readonly string[] = [
  'editor.background',
  'editor.foreground',
  'foreground',
  'sideBar.background',
  'editorWidget.background',
  'menu.background',
  'activityBarBadge.background',
  'activityBarBadge.foreground',
  'button.background',
  'button.foreground',
  'button.hoverBackground',
  'focusBorder',
  'progressBar.background',
  'textLink.foreground',
  'editorError.foreground',
  'editorWarning.foreground',
  'terminal.background',
  'terminal.foreground',
  ...ANSI.flatMap((c) => [`terminal.ansi${c}`, `terminal.ansiBright${c}`]),
]

/** TextMate scopes whose colour stands for each syntax role, most specific first. */
const SCOPES: Record<SyntaxRole, readonly string[]> = {
  comment: ['comment', 'punctuation.definition.comment'],
  string: ['string', 'string.quoted'],
  keyword: ['keyword', 'keyword.control', 'storage.type', 'storage'],
  function: ['entity.name.function', 'support.function'],
  number: ['constant.numeric', 'constant'],
}

/* ------------------------------------------------------------------ colour math */

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** VS Code theme colours are hex only (#rgb, #rgba, #rrggbb, #rrggbbaa); nothing else is a colour here. */
export const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function parseHex(hex: string): Rgba | undefined {
  if (!HEX.test(hex)) return undefined
  let h = hex.slice(1)
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
}

const toHex = (c: Rgba) =>
  `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** `fg` painted over the opaque `bg`, as an opaque colour. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
}

/** `a` moved `t` (0–1) of the way to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a) as Rgba
  const y = parseHex(b) as Rgba
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: 1 })
}

/** The colour at an alpha, for CSS. */
export function alpha(hex: string, a: number): string {
  const c = parseHex(hex) as Rgba
  return `rgb(${c.r} ${c.g} ${c.b} / ${a})`
}

const channel = (v: number) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const c = parseHex(hex) as Rgba
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

/** WCAG contrast ratio of two opaque colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** HSL saturation and lightness, 0–1. */
function saturation(hex: string): { s: number; l: number } {
  const c = parseHex(hex) as Rgba
  const vs = [c.r, c.g, c.b].map((v) => v / 255)
  const max = Math.max(...vs)
  const min = Math.min(...vs)
  const l = (max + min) / 2
  const d = max - min
  return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l }
}

/**
 * `fg` moved toward white (on a dark theme) or black (on a light one) in small steps until it reads at `min` on every
 * one of `bgs`; the other way if that never gets there; and the best it found if neither does.
 */
export function ensureContrast(fg: string, bgs: readonly string[], min: number, kind: ThemeKind): string {
  const worst = (c: string) => Math.min(...bgs.map((b) => contrast(c, b)))
  if (worst(fg) >= min) return fg
  let best = fg
  for (const end of kind === 'dark' ? ['#ffffff', '#000000'] : ['#000000', '#ffffff'])
    for (let t = 0.04; t <= 1.0001; t += 0.04) {
      const c = mix(fg, end, t)
      if (worst(c) > worst(best)) best = c
      if (worst(c) >= min) return c
    }
  return best
}

/* ------------------------------------------------------------------ the mapping */

/** How far an accent may move toward black or white so the theme's own ink reads on it, before another ink is used. */
const ACCENT_NUDGE = 0.2

/** A theme's colour as an opaque hex over `bg`, or undefined when it has none (or an unreadable one). */
function opaque(value: string | undefined, bg: string): string | undefined {
  const c = value ? parseHex(value) : undefined
  return c ? toHex(over(c, parseHex(bg) as Rgba)) : undefined
}

/** Whether a colour reads as a colour rather than a grey, so it can stand for the theme's accent. */
function chromatic(hex: string): boolean {
  const { s, l } = saturation(hex)
  return s >= 0.3 && l >= 0.2 && l <= 0.88
}

/** Light or dark from its main background, for an imported theme that does not say. */
export function kindOf(background: string): ThemeKind {
  return contrast(background, '#ffffff') > contrast(background, '#000000') ? 'dark' : 'light'
}

/** The tokens in tokens.css (without their `--`) a theme sets, with its xterm colours as `ansi-*`. */
export function themeTokens(theme: ThemeData): Record<string, string> {
  const c = theme.colors
  const kind = theme.type
  const dark = kind === 'dark'
  const base = dark ? '#1e1e1e' : '#ffffff'
  const content = opaque(c['editor.background'], base) ?? base
  const pick = (key: string) => opaque(c[key], content)
  const deeper = (hex: string, t: number) => mix(hex, '#000000', t)
  let label = pick('editor.foreground') ?? pick('foreground') ?? (dark ? '#d4d4d4' : '#333333')

  // Surfaces: the window sits a step deeper than the content in both kinds, as Myrmidon's own looks do.
  const sidebar = pick('sideBar.background')
  const window = sidebar && sidebar !== content ? sidebar : deeper(content, dark ? 0.22 : 0.035)
  const raised = dark ? mix(content, '#ffffff', 0.045) : mix(content, '#ffffff', 0.6)
  const control = dark ? mix(content, label, 0.08) : mix(content, '#ffffff', 0.75)
  const controlHover = mix(control, label, 0.04)
  const controlActive = mix(control, label, 0.08)
  const fill = mix(content, label, dark ? 0.035 : 0.04)
  const fillStrong = mix(content, label, dark ? 0.07 : 0.08)
  const surfaces = [window, content, raised, control, controlHover, controlActive, fill, fillStrong]
  label = ensureContrast(label, surfaces, 4.5, kind)
  // Secondary and tertiary text fade toward the background only as far as they still read, so they never pass the label.
  const faded = (t: number) => {
    for (let k = t; k > 0; k -= 0.02) {
      const c = mix(label, content, k)
      if (surfaces.every((b) => contrast(c, b) >= 4.5)) return c
    }
    return label
  }
  const label2 = faded(0.18)
  const label3 = faded(0.36)
  const label4 = mix(label, content, 0.6)

  // The accent: the first of the theme's own highlight colours that is a colour, not a grey.
  const s = theme.syntax ?? {}
  const accentFrom = [
    'activityBarBadge.background',
    'button.background',
    'focusBorder',
    'progressBar.background',
    'textLink.foreground',
  ].find((k) => {
    const v = pick(k)
    return v !== undefined && chromatic(v)
  })
  const picked =
    (accentFrom && pick(accentFrom)) ??
    [opaque(s.keyword, content), pick('terminal.ansiBlue')].find((v) => v !== undefined && chromatic(v)) ??
    (dark ? '#ffb31a' : '#b86e00')
  // Text on the accent: the ink the theme puts on that colour, the accent deepened (or lightened) a little if that is
  // what it takes; else white or near-black, whichever reads; else the accent moved until that one does.
  const given =
    accentFrom === 'activityBarBadge.background'
      ? pick('activityBarBadge.foreground')
      : accentFrom === 'button.background'
        ? opaque(c['button.foreground'], picked)
        : undefined
  const nudged = (ink: string, most: number) => {
    const away = luminance(ink) > 0.4 ? '#000000' : '#ffffff'
    for (let t = 0; t <= most + 1e-9; t += 0.02) {
      const v = mix(picked, away, t)
      if (contrast(v, ink) >= 4.5) return v
    }
    return undefined
  }
  const plain = contrast('#ffffff', picked) >= contrast('#111111', picked) ? '#ffffff' : '#111111'
  const own = given ? nudged(given, ACCENT_NUDGE) : undefined
  const [accent, onAccent] = own
    ? [own, given as string]
    : contrast(plain, picked) >= 4.5
      ? [picked, plain]
      : [nudged(plain, 1) ?? picked, plain]
  const textOn = [content, window, fill, fillStrong, raised, control]
  const accentText = ensureContrast(accent, textOn, 4.5, kind)
  const focus = ensureContrast(accent, [window, content], 3, kind)
  const bubble = mix(content, accent, dark ? 0.2 : 0.12)

  // Status colours from the terminal's palette; their -ink shades read at 4.5:1 on the surfaces and on their own soft fill.
  const status = (given: string | undefined, fallback: string) => {
    const hue = given ?? fallback
    const soft = mix(content, hue, 0.14)
    return { hue, soft: alpha(hue, 0.14), ink: ensureContrast(hue, [...textOn, soft], 4.5, kind) }
  }
  const ok = status(pick('terminal.ansiGreen') ?? opaque(s.string, content), dark ? '#3ddc84' : '#34c759')
  const warn = status(
    pick('editorWarning.foreground') ?? pick('terminal.ansiYellow'),
    dark ? '#ff8a4c' : '#ff9500',
  )
  const bad = status(pick('editorError.foreground') ?? pick('terminal.ansiRed'), dark ? '#ff6369' : '#ff3b30')
  const badFill = ensureContrast(bad.hue, ['#ffffff'], 4.5, 'light')

  const terminalBg = pick('terminal.background') ?? content
  const terminalText = ensureContrast(pick('terminal.foreground') ?? label, [terminalBg], 4.5, kind)
  const onTerminal = (v: string | undefined, fallback: string) =>
    ensureContrast(v ?? fallback, [terminalBg], 4.5, kind)
  const ansi: Record<string, string> = {}
  for (const name of ANSI)
    for (const bright of [false, true]) {
      const v = pick(`terminal.ansi${bright ? 'Bright' : ''}${name}`)
      if (v) ansi[`ansi-${bright ? 'bright-' : ''}${name.toLowerCase()}`] = v
    }

  return {
    window,
    content,
    raised,
    control,
    'control-hover': controlHover,
    'control-active': controlActive,
    fill,
    'fill-strong': fillStrong,
    separator: alpha(label, 0.11),
    'separator-strong': alpha(label, 0.2),
    'material-sidebar': alpha(window, 0.86),
    'material-toolbar': alpha(content, 0.82),
    'material-menu': alpha(pick('menu.background') ?? pick('editorWidget.background') ?? raised, 0.92),
    label,
    'label-2': label2,
    'label-3': label3,
    'label-4': label4,
    accent,
    'accent-hover': mix(accent, '#ffffff', 0.12),
    'accent-soft': alpha(accent, 0.16),
    'accent-text': accentText,
    'on-accent': onAccent,
    focus,
    'row-selected': alpha(label, dark ? 0.1 : 0.08),
    'row-selected-inactive': alpha(label, 0.05),
    ink: label,
    'on-ink': content,
    bubble,
    'on-bubble': ensureContrast(label, [bubble], 4.5, kind),
    signal: accent,
    ok: ok.hue,
    'ok-soft': ok.soft,
    'ok-ink': ok.ink,
    warn: warn.hue,
    'warn-soft': warn.soft,
    'warn-ink': warn.ink,
    bad: bad.hue,
    'bad-soft': bad.soft,
    'bad-ink': bad.ink,
    'bad-fill': badFill,
    work: accent,
    'work-ink': accentText,
    idle: label4,
    edge: ensureContrast(mix(label, content, 0.5), [window], 3, kind),
    'code-bg': window,
    'terminal-bg': terminalBg,
    'terminal-text': terminalText,
    'terminal-command': onTerminal(pick('terminal.ansiGreen'), ok.hue),
    // Faded from the terminal's text, not its bright black: some themes (Solarized) make that their darkest shade.
    'terminal-muted': onTerminal(mix(terminalText, terminalBg, 0.35), terminalText),
    'terminal-error': onTerminal(pick('terminal.ansiRed'), bad.hue),
    'shell-log-bg': terminalBg,
    ...ansi,
  }
}

/* ------------------------------------------------------------------ importing */

/** JSON with comments and trailing commas, as VS Code theme files often are. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
    } else if (ch === '"') {
      inString = true
      out += ch
      i++
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** What is kept of an imported theme: its name, kind and the colours Myrmidon reads, each a checked hex colour. */
export interface ImportedTheme {
  id: string
  name: string
  type: ThemeKind
  colors: Record<string, string>
  syntax: Partial<Record<SyntaxRole, string>>
}

export type ImportResult = { ok: true; theme: ImportedTheme; dropped: number } | { ok: false; error: string }

/** A short stable id from the theme's content, so importing the same file twice replaces it. */
function idFor(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return `imported-${(h >>> 0).toString(36)}`
}

const clean = (s: string) =>
  [...s]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join('')
    .trim()

/**
 * A VS Code theme file, as pasted or dropped, checked and cut down to what Myrmidon uses. Only `#hex` colours are
 * taken; any other value (a url(), an expression, a name) is dropped and counted, and keys Myrmidon does not read are
 * left behind.
 */
export function importTheme(text: string): ImportResult {
  const t = copy.settings.appearance.importErrors
  if (!text.trim()) return { ok: false, error: t.empty }
  if (text.length > THEME_IMPORT.maxBytes) return { ok: false, error: t.tooBig }
  let raw: unknown
  try {
    raw = parseJsonc(text)
  } catch {
    return { ok: false, error: t.notJson }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: t.notTheme }
  const file = raw as {
    name?: unknown
    type?: unknown
    colors?: unknown
    tokenColors?: unknown
    include?: unknown
  }
  const given =
    file.colors && typeof file.colors === 'object' ? (file.colors as Record<string, unknown>) : undefined
  if (!given) return { ok: false, error: typeof file.include === 'string' ? t.include : t.notTheme }
  const colors: Record<string, string> = {}
  let dropped = 0
  for (const key of THEME_KEYS) {
    const v = given[key]
    if (v === undefined) continue
    if (typeof v === 'string' && HEX.test(v.trim())) colors[key] = v.trim().toLowerCase()
    else dropped++
  }
  const syntax: Partial<Record<SyntaxRole, string>> = {}
  if (Array.isArray(file.tokenColors))
    for (const role of Object.keys(SCOPES) as SyntaxRole[])
      for (const scope of SCOPES[role]) {
        if (syntax[role]) break
        for (const rule of file.tokenColors as { scope?: unknown; settings?: { foreground?: unknown } }[]) {
          const scopes = Array.isArray(rule?.scope)
            ? rule.scope
            : typeof rule?.scope === 'string'
              ? rule.scope.split(',').map((x) => x.trim())
              : []
          const fg = rule?.settings?.foreground
          if (!scopes.includes(scope)) continue
          if (typeof fg === 'string' && HEX.test(fg.trim())) {
            syntax[role] = fg.trim().toLowerCase()
            break
          }
          dropped++
        }
      }
  const background = colors['editor.background']
  if (!background) return { ok: false, error: t.noBackground }
  const solid = opaque(background, '#808080') as string
  const type = file.type === 'dark' || file.type === 'light' ? file.type : kindOf(solid)
  const name = (typeof file.name === 'string' ? clean(file.name) : '').slice(0, THEME_IMPORT.maxName)
  return {
    ok: true,
    theme: {
      id: idFor(JSON.stringify([name, type, colors, syntax])),
      name: name || copy.settings.appearance.importedName,
      type,
      colors,
      syntax,
    },
    dropped,
  }
}
