import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Glob } from 'bun'
import * as lucide from 'lucide-react'
import { FEATURE_ICONS } from '../src/client/ui/icons.ts'

const glyphs = new Set<unknown>(Object.values(FEATURE_ICONS))

test('no glyph stands for two features', () => {
  const byGlyph = new Map<unknown, string[]>()
  for (const [feature, glyph] of Object.entries(FEATURE_ICONS))
    byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), feature])
  const shared = [...byGlyph.values()].filter((features) => features.length > 1)
  expect(shared).toEqual([])
})

test("screens take a feature's glyph from the registry, so it cannot quietly mean something else", async () => {
  // Every name lucide exports for a registered glyph, aliases included (ShieldCheck, ShieldCheckIcon, …).
  const registered = new Set(
    Object.entries(lucide)
      .filter(([, value]) => glyphs.has(value))
      .map(([name]) => name),
  )
  const root = new URL('../src/client/', import.meta.url).pathname
  const strays: string[] = []
  for await (const file of new Glob('**/*.{ts,tsx}').scan(root)) {
    if (file === 'ui/icons.ts') continue
    const source = await Bun.file(root + file).text()
    for (const block of source.matchAll(/import \{([^}]*)\} from 'lucide-react'/g))
      for (const name of (block[1] ?? '').split(',').map(
        (n) =>
          n
            .trim()
            .replace(/^type /, '')
            .split(/\s+as\s+/)[0] ?? '',
      ))
        if (registered.has(name)) strays.push(`${file}: ${name}`)
  }
  expect(strays).toEqual([])
})

// The screens pull in api.ts, which reads the page's address and storage when it loads.
const page = globalThis as unknown as Record<string, unknown>
beforeAll(() => {
  page.window = Object.assign(new EventTarget(), { innerWidth: 1440 })
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})
afterAll(() => {
  delete page.window
  delete page.location
})

test('the lists that name features (Settings sections, who-can-use-what groups, workspace views, crew modes) use the registry', async () => {
  const { SECTIONS } = await import('../src/client/settings/pages.ts')
  const { ACCESS_INFO } = await import('../src/client/permissions/describe.ts')
  const { VIEWS } = await import('../src/client/chat/Workspace.tsx')
  const { MODES } = await import('../src/client/chat/Composer.tsx')
  const entries: [string, unknown][] = [
    ...SECTIONS.map((s): [string, unknown] => [`settings section ${s.id}`, s.icon]),
    ...ACCESS_INFO.map((g): [string, unknown] => [`tool group ${g.group}`, g.icon]),
    ...VIEWS.map((v): [string, unknown] => [`workspace view ${v.value}`, v.icon]),
    ...MODES.map((m): [string, unknown] => [`crew mode ${m.id}`, m.icon]),
  ]
  const outside = entries.filter(([, icon]) => !glyphs.has(icon)).map(([name]) => name)
  expect(outside).toEqual([])
})
