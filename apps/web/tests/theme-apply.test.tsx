import { afterEach, expect, test } from 'bun:test'
import { act, useEffect } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

const root = () => document.documentElement
const paletteCss = () => document.getElementById('myr-palette')?.textContent ?? ''

afterEach(async () => {
  localStorage.clear()
  const { applyTheme } = await import('../src/client/themes/apply.ts')
  applyTheme('system')
})

test("a theme's tokens go on :root with its kind as data-theme; Myrmidon's own looks take them off", async () => {
  const { applyTheme } = await import('../src/client/themes/apply.ts')
  applyTheme('palette:dracula')
  expect(root().dataset.theme).toBe('dark')
  expect(root().dataset.palette).toBe('dracula')
  expect(paletteCss()).toContain('--window:#21222c;')
  expect(paletteCss()).toContain('--content:#282a36;')
  // The logo is the brand's, whatever the theme.
  expect(paletteCss()).not.toContain('--logo')
  applyTheme('palette:github-light')
  expect(root().dataset.theme).toBe('light')
  expect(paletteCss()).toContain('--content:#ffffff;')
  applyTheme('dark')
  expect(root().dataset.theme).toBe('dark')
  expect(root().dataset.palette).toBeUndefined()
  expect(document.getElementById('myr-palette')).toBeNull()
  applyTheme('system')
  expect(root().dataset.theme).toBeUndefined()
})

test('an unknown theme shows the System look rather than a broken one', async () => {
  const { applyTheme } = await import('../src/client/themes/apply.ts')
  applyTheme('palette:no-such-theme')
  expect(root().dataset.palette).toBeUndefined()
  expect(root().dataset.theme).toBeUndefined()
})

test('the choice persists in this browser and is shown again on the next load', async () => {
  const { useTheme } = await import('../src/client/ui/hooks.ts')
  let set: ((t: 'palette:nord') => void) | undefined
  function Probe() {
    const [, setTheme] = useTheme([])
    useEffect(() => {
      set = setTheme
    })
    return null
  }
  const first = await mount(<Probe />)
  await act(async () => set?.('palette:nord'))
  expect(localStorage.getItem('myr-theme')).toBe('palette:nord')
  expect(root().dataset.palette).toBe('nord')
  await first.unmount()
  const { applyTheme } = await import('../src/client/themes/apply.ts')
  applyTheme('system')
  const again = await mount(<Probe />)
  expect(root().dataset.palette).toBe('nord')
  await again.unmount()
})

test('an imported theme opens from the cache before the settings arrive, and one that is gone falls back to System', async () => {
  const { applyTheme, forgetCachedTheme } = await import('../src/client/themes/apply.ts')
  const { useTheme } = await import('../src/client/ui/hooks.ts')
  const mine = {
    id: 'imported-abc',
    name: 'Mine',
    type: 'dark' as const,
    colors: { 'editor.background': '#102030', 'editor.foreground': '#e0e0e0' },
    syntax: {},
  }
  applyTheme('palette:imported-abc', [mine])
  applyTheme('system')
  // Without the list (the settings not loaded yet), the cached tokens show it.
  applyTheme('palette:imported-abc')
  expect(root().dataset.palette).toBe('imported-abc')
  expect(paletteCss()).toContain('--content:#102030;')

  forgetCachedTheme('imported-abc')
  localStorage.setItem('myr-theme', 'palette:imported-abc')
  let shown = ''
  function Probe() {
    const [theme] = useTheme([])
    shown = theme
    return null
  }
  const view = await mount(<Probe />)
  expect(shown).toBe('system')
  expect(localStorage.getItem('myr-theme')).toBe('system')
  await view.unmount()
})

test('a cached theme is checked: anything but a colour value is left out', async () => {
  localStorage.setItem(
    'myr-theme-tokens',
    JSON.stringify({
      id: 'imported-x',
      name: 'x',
      type: 'dark',
      tokens: {
        content: '#101010',
        label: 'red;}body{background:url(https://evil.example)',
        'bad key': '#000000',
      },
    }),
  )
  const { applyTheme } = await import('../src/client/themes/apply.ts')
  applyTheme('palette:imported-x')
  expect(paletteCss()).toContain('--content:#101010;')
  expect(paletteCss()).not.toContain('url(')
  expect(paletteCss()).not.toContain('bad key')
})

test('the gallery tries a theme on focus, Esc puts the chosen one back without closing Settings, a click keeps it', async () => {
  const { AppearanceSection } = await import('../src/client/themes/AppearanceSection.tsx')
  const picked: string[] = []
  let closed = 0
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closed++
  }
  window.addEventListener('keydown', onWindowKey)
  const view = await mount(
    <AppearanceSection
      theme="system"
      onTheme={(t) => picked.push(t)}
      imported={[]}
      onSaveImported={async () => true}
    />,
  )
  const card = (choice: string) => view.host.querySelector<HTMLButtonElement>(`[data-theme-card="${choice}"]`)
  expect(card('palette:dracula')).not.toBeNull()
  expect(view.host.querySelectorAll('[data-theme-card]').length).toBe(3 + 14)
  await act(async () => card('palette:dracula')?.focus())
  expect(root().dataset.palette).toBe('dracula')
  // The arrow keys move between cards, trying each.
  await press('ArrowRight')
  expect(root().dataset.palette).toBe('tokyo-night')
  await press('Escape')
  expect(root().dataset.palette).toBeUndefined()
  expect(closed).toBe(0)
  await act(async () => card('palette:nord')?.click())
  expect(picked).toEqual(['palette:nord'])
  window.removeEventListener('keydown', onWindowKey)
  await view.unmount()
})

test('importing: a broken file says why under the field; a theme with non-colours is previewed with them left out', async () => {
  const { AppearanceSection } = await import('../src/client/themes/AppearanceSection.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const saved: unknown[] = []
  const view = await mount(
    <AppearanceSection
      theme="system"
      onTheme={() => {}}
      imported={[]}
      onSaveImported={async (list) => {
        saved.push(list)
        return true
      }}
    />,
  )
  const area = view.host.querySelector('textarea') as HTMLTextAreaElement
  const button = (label: string) =>
    [...view.host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
  // As explorer.test.tsx types: through the field's own change handler.
  const type = async (value: string) =>
    act(async () => {
      const props = Object.entries(area).find(([k]) => k.startsWith('__reactProps'))?.[1] as {
        onChange(e: { target: { value: string } }): void
      }
      props.onChange({ target: { value } })
    })
  await type('{ not json')
  await act(async () => button(copy.settings.appearance.check).click())
  expect(view.host.textContent).toContain(copy.settings.appearance.importErrors.notJson)
  expect(area.getAttribute('aria-invalid')).toBe('true')

  await type(
    JSON.stringify({
      name: 'Evil',
      colors: { 'editor.background': '#111111', 'editor.foreground': 'url(javascript:alert(1))' },
    }),
  )
  await act(async () => button(copy.settings.appearance.check).click())
  expect(view.host.textContent).toContain(copy.settings.appearance.ready('Evil'))
  expect(view.host.textContent).toContain(copy.settings.appearance.dropped(1))
  await act(async () => button(copy.settings.appearance.add).click())
  expect(saved).toHaveLength(1)
  const [theme] = saved[0] as { colors: Record<string, string> }[]
  expect(theme?.colors).toEqual({ 'editor.background': '#111111' })
  await view.unmount()
})
