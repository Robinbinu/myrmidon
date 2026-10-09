import { copy } from '../copy.ts'
import { BUILTIN_THEMES } from './palettes.ts'
import { type ImportedTheme, type ThemeData, type ThemeKind, themeTokens } from './vscode.ts'

/** A theme from the gallery, built in or imported, by its id. */
export type PaletteChoice = `palette:${string}`
/** Myrmidon's own look (light, dark, or as the system has it), or a theme from the gallery. */
export type ThemeChoice = 'system' | 'light' | 'dark' | PaletteChoice

export const paletteChoice = (id: string): PaletteChoice => `palette:${id}`
export const isPalette = (choice: string): choice is PaletteChoice => choice.startsWith('palette:')
const paletteId = (choice: PaletteChoice) => choice.slice('palette:'.length)

/** The active imported theme's tokens, kept in this browser so the page opens in it before the settings arrive. */
const CACHE_KEY = 'myr-theme-tokens'
const STYLE_ID = 'myr-palette'
/** Only what themeTokens makes: a hex colour or `rgb(r g b / a)`. */
const SAFE_VALUE = /^(?:#[0-9a-f]{6}|rgb\(\d{1,3} \d{1,3} \d{1,3} \/ [0-9.]+\))$/i
const SAFE_NAME = /^[a-z0-9-]{1,40}$/

interface Resolved {
  id: string
  name: string
  type: ThemeKind
  tokens: Record<string, string>
}

function readCache(): Resolved | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Resolved | null
    if (!raw || typeof raw.id !== 'string' || (raw.type !== 'dark' && raw.type !== 'light')) return undefined
    const tokens = Object.fromEntries(
      Object.entries(raw.tokens ?? {}).filter(
        ([k, v]) => SAFE_NAME.test(k) && typeof v === 'string' && SAFE_VALUE.test(v),
      ),
    )
    return { id: raw.id, name: String(raw.name ?? ''), type: raw.type, tokens }
  } catch {
    return undefined
  }
}

function writeCache(r: Resolved | undefined) {
  try {
    if (r) localStorage.setItem(CACHE_KEY, JSON.stringify(r))
    else localStorage.removeItem(CACHE_KEY)
  } catch {
    // The cache only saves a flash of the default look on the next load.
  }
}

/** The theme a choice names: built in, or among the imported ones. */
export function findTheme(choice: string, imported: readonly ImportedTheme[] = []): ThemeData | undefined {
  if (!isPalette(choice)) return undefined
  const id = paletteId(choice)
  return BUILTIN_THEMES.find((t) => t.id === id) ?? imported.find((t) => t.id === id)
}

/** What a choice is called, for the theme switch's label. */
export function themeLabel(choice: ThemeChoice, imported?: readonly ImportedTheme[]): string {
  const t = copy.settings.general
  if (choice === 'system') return t.themeSystem
  if (choice === 'light') return t.themeLight
  if (choice === 'dark') return t.themeDark
  const cached = readCache()
  return findTheme(choice, imported)?.name ?? (cached?.id === paletteId(choice) ? cached.name : t.themeSystem)
}

function resolve(choice: ThemeChoice, imported?: readonly ImportedTheme[]): Resolved | undefined {
  if (!isPalette(choice)) return undefined
  const theme = findTheme(choice, imported)
  if (theme) return { id: theme.id, name: theme.name, type: theme.type, tokens: themeTokens(theme) }
  const cached = readCache()
  return cached?.id === paletteId(choice) ? cached : undefined
}

/** Whether the choice can be shown: Myrmidon's own look always, a theme when it is built in, imported or cached. */
export function resolvable(choice: ThemeChoice, imported?: readonly ImportedTheme[]): boolean {
  return !isPalette(choice) || resolve(choice, imported) !== undefined
}

let defaultThemeColor: string | null | undefined

/**
 * Shows a choice on the page: Myrmidon's own look as `data-theme` (none for System), a theme as its tokens on :root
 * with `data-theme` set to its kind, so what it leaves out comes from the matching look. The tokens go in a style
 * element rather than inline styles, so rules such as the inactive window's selection can still override them.
 */
export function applyTheme(choice: ThemeChoice, imported?: readonly ImportedTheme[]): void {
  const root = document.documentElement
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta && defaultThemeColor === undefined) defaultThemeColor = meta.getAttribute('content')
  const shown = resolve(choice, imported)
  if (!shown) {
    document.getElementById(STYLE_ID)?.remove()
    root.removeAttribute('data-palette')
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice)
    else root.removeAttribute('data-theme')
    if (meta && defaultThemeColor) meta.setAttribute('content', defaultThemeColor)
    return
  }
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  const decls = Object.entries(shown.tokens)
    .map(([k, v]) => `--${k}:${v};`)
    .join('')
  // Two attributes outrank both the dark-tokens block and the inactive-window rule; the second rule restores the latter.
  style.textContent = `:root[data-palette]{${decls}}:root[data-palette][data-window-active="false"]{--row-selected:var(--row-selected-inactive);}`
  // The style first, so whatever watches these attributes reads the new colours.
  root.setAttribute('data-theme', shown.type)
  root.setAttribute('data-palette', shown.id)
  if (meta && shown.tokens.window) meta.setAttribute('content', shown.tokens.window)
  if (imported?.some((t) => t.id === shown.id)) writeCache(shown)
}

/** Forgets the cached imported theme, once it is deleted. */
export function forgetCachedTheme(id: string) {
  if (readCache()?.id === id) writeCache(undefined)
}
