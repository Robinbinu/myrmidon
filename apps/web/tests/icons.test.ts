import { expect, test } from 'bun:test'
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
