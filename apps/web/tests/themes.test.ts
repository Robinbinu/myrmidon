import { describe, expect, test } from 'bun:test'
import { copy } from '../src/client/copy.ts'
import { BUILTIN_THEMES } from '../src/client/themes/palettes.ts'
import { contrast, importTheme, parseHex, type ThemeData, themeTokens } from '../src/client/themes/vscode.ts'

/** An `rgb(r g b / a)` token painted over an opaque hex background, as a hex colour. */
function flatten(value: string, bg: string): string {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([0-9.]+)\)$/.exec(value)
  if (!m) return value
  const b = parseHex(bg) as { r: number; g: number; b: number }
  const a = Number(m[4])
  const ch = (v: string, under: number) =>
    Math.round(Number(v) * a + under * (1 - a))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(m[1] as string, b.r)}${ch(m[2] as string, b.g)}${ch(m[3] as string, b.b)}`
}

const SURFACES = [
  'window',
  'content',
  'raised',
  'control',
  'control-hover',
  'control-active',
  'fill',
  'fill-strong',
]

describe('every built-in theme reads at WCAG AA once mapped onto Myrmidon', () => {
  for (const theme of BUILTIN_THEMES) {
    const t = themeTokens(theme)
    test(`${theme.name}: labels on every surface`, () => {
      for (const label of ['label', 'label-2', 'label-3'])
        for (const surface of SURFACES)
          expect(contrast(t[label] as string, t[surface] as string)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme.name}: accent text, text on the accent, status ink, the terminal`, () => {
      const content = t.content as string
      for (const surface of ['content', 'window', 'fill'])
        expect(contrast(t['accent-text'] as string, t[surface] as string)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['on-accent'] as string, t.accent as string)).toBeGreaterThanOrEqual(4.5)
      for (const hue of ['ok', 'warn', 'bad']) {
        expect(contrast(t[`${hue}-ink`] as string, content)).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(t[`${hue}-ink`] as string, flatten(t[`${hue}-soft`] as string, content)),
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast('#ffffff', t['bad-fill'] as string)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['on-bubble'] as string, t.bubble as string)).toBeGreaterThanOrEqual(4.5)
      for (const ink of ['terminal-text', 'terminal-command', 'terminal-muted', 'terminal-error'])
        expect(contrast(t[ink] as string, t['terminal-bg'] as string)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.edge as string, t.window as string)).toBeGreaterThanOrEqual(3)
      expect(contrast(t.focus as string, t.window as string)).toBeGreaterThanOrEqual(3)
    })
  }

  test('the brand logo and the mascot screen are never themed', () => {
    for (const theme of BUILTIN_THEMES)
      for (const name of Object.keys(themeTokens(theme))) expect(name).not.toMatch(/^(logo|screen|mood)-?/)
  })
})

describe('a VS Code theme maps onto the tokens', () => {
  const base: ThemeData = {
    id: 'x',
    name: 'X',
    type: 'dark',
    colors: {
      'editor.background': '#1e1e2e',
      'editor.foreground': '#cdd6f4',
      'sideBar.background': '#181825',
      'activityBarBadge.background': '#cba6f7',
      'activityBarBadge.foreground': '#11111b',
      'terminal.ansiGreen': '#a6e3a1',
      'terminal.ansiRed': '#f38ba8',
      'terminal.ansiBrightBlue': '#74a8fc',
    },
  }

  test('content is the editor, the window the side bar, text the editor text, the accent its badge', () => {
    const t = themeTokens(base)
    expect(t.content).toBe('#1e1e2e')
    expect(t.window).toBe('#181825')
    expect(t.label).toBe('#cdd6f4')
    expect(t.accent).toBe('#cba6f7')
    expect(t['on-accent']).toBe('#11111b')
    expect(t.ok).toBe('#a6e3a1')
    expect(t.bad).toBe('#f38ba8')
    expect(t['code-bg']).toBe(t.window)
    // xterm takes the terminal's palette as it is.
    expect(t['ansi-bright-blue']).toBe('#74a8fc')
  })

  test('a theme without a side bar colour gets a window a step deeper than its content', () => {
    const { 'sideBar.background': _, ...colors } = base.colors
    const t = themeTokens({ ...base, colors })
    expect(t.window).not.toBe(t.content)
    expect(contrast(t.window as string, '#000000')).toBeLessThan(contrast(t.content as string, '#000000'))
  })

  test('a grey badge is passed over for the first highlight that is a colour, alpha painted over the editor', () => {
    const t = themeTokens({
      ...base,
      colors: { ...base.colors, 'activityBarBadge.background': '#44596b', 'button.background': '#7e57c2cc' },
    })
    expect(t.accent).not.toBe('#44596b')
    // #7e57c2 at 80% over #1e1e2e.
    expect(t.accent).toBe('#6b4ca4')
  })

  test('with no colourful highlight at all, the keyword colour stands in', () => {
    const { 'activityBarBadge.background': _, ...colors } = base.colors
    expect(themeTokens({ ...base, colors, syntax: { keyword: '#f92672' } }).accent).toBe('#f92672')
  })

  test('text that would not read is lifted until it does, and kept as it is when it already reads', () => {
    const dim = themeTokens({ ...base, colors: { ...base.colors, 'editor.foreground': '#45475a' } })
    expect(dim.label).not.toBe('#45475a')
    expect(contrast(dim.label as string, dim['fill-strong'] as string)).toBeGreaterThanOrEqual(4.5)
    const light = themeTokens({
      ...base,
      type: 'light',
      colors: { 'editor.background': '#fdf6e3', 'editor.foreground': '#93a1a1' },
    })
    // Solarized's base1 is too pale on its own background: darkened, not lightened.
    expect(contrast(light.label as string, '#000000')).toBeLessThan(contrast('#93a1a1', '#000000'))
    expect(contrast(light.label as string, light.window as string)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('importing a theme file', () => {
  const file = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: 'Mine',
      type: 'dark',
      colors: { 'editor.background': '#101014', 'editor.foreground': '#e0e0e0' },
      ...over,
    })

  test('keeps the colours Myrmidon reads, and leaves out keys it does not', () => {
    const r = importTheme(
      file({
        colors: {
          'editor.background': '#101014',
          'editor.foreground': '#E0E0E0',
          'statusBar.background': '#000000',
        },
        tokenColors: [
          { scope: ['comment'], settings: { foreground: '#6272A4', fontStyle: 'italic' } },
          { scope: 'string, string.quoted', settings: { foreground: '#f1fa8c' } },
        ],
      }),
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.theme.colors).toEqual({ 'editor.background': '#101014', 'editor.foreground': '#e0e0e0' })
    expect(r.theme.syntax).toEqual({ comment: '#6272a4', string: '#f1fa8c' })
    expect(r.theme.type).toBe('dark')
    expect(r.theme.id).toMatch(/^imported-[a-z0-9]+$/)
    expect(r.dropped).toBe(0)
  })

  test('only hex colours get through: url(), expressions, names and rgb() are dropped and counted', () => {
    const r = importTheme(
      file({
        colors: {
          'editor.background': '#101014',
          'editor.foreground': 'url(https://evil.example/x.png)',
          'sideBar.background': 'expression(alert(1))',
          'button.background': 'red',
          focusBorder: 'rgb(255 0 0)',
          'textLink.foreground': '#12345',
          'terminal.ansiRed': '#ff0000; background: url(x)',
          'terminal.ansiGreen': { nested: '#00ff00' },
        },
        tokenColors: [{ scope: 'comment', settings: { foreground: 'var(--x)' } }],
      }),
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.theme.colors).toEqual({ 'editor.background': '#101014' })
    expect(r.theme.syntax).toEqual({})
    expect(r.dropped).toBe(8)
    expect(JSON.stringify(r.theme)).not.toMatch(/url|expression|var\(|;/)
  })

  test('reads JSON with comments and trailing commas, as theme files often are', () => {
    const r = importTheme(`{
      // A theme
      "name": "Commented", /* inline */
      "colors": { "editor.background": "#fafafa", "editor.foreground": "#383a42", },
    }`)
    if (!r.ok) throw new Error(r.error)
    // No type given: a pale background makes it light.
    expect(r.theme.type).toBe('light')
    expect(r.theme.name).toBe('Commented')
  })

  test('says what is wrong with a file that is not a usable theme', () => {
    const e = copy.settings.appearance.importErrors
    const error = (text: string) => {
      const r = importTheme(text)
      return r.ok ? undefined : r.error
    }
    expect(error('   ')).toBe(e.empty)
    expect(error('{ "colors": ')).toBe(e.notJson)
    expect(error('[1, 2]')).toBe(e.notTheme)
    expect(error('{ "name": "x" }')).toBe(e.notTheme)
    expect(error('{ "include": "./base.json" }')).toBe(e.include)
    expect(error(file({ colors: { 'editor.foreground': '#ffffff' } }))).toBe(e.noBackground)
    expect(error(`{"colors":{"editor.background":"#000000"},"pad":"${'x'.repeat(600_000)}"}`)).toBe(e.tooBig)
  })

  test('a name is cleaned of control characters and cut to length, and a nameless theme is named', () => {
    const r = importTheme(file({ name: `\u0007Night\u0000 ${'x'.repeat(100)}` }))
    if (!r.ok) throw new Error(r.error)
    expect(r.theme.name.startsWith('Night ')).toBe(true)
    expect(r.theme.name).toHaveLength(60)
    const unnamed = importTheme(file({ name: 42 }))
    expect(unnamed.ok && unnamed.theme.name).toBe(copy.settings.appearance.importedName)
  })

  test('the same file imports to the same id, so adding it again replaces it', () => {
    const a = importTheme(file())
    const b = importTheme(file())
    expect(a.ok && b.ok && a.theme.id === b.theme.id).toBe(true)
  })
})
