import { describe, expect, test } from 'bun:test'

/** The hex colour tokens of the light block and of the dark block (dark falls back to light, as in the cascade). */
async function themes() {
  const css = await Bun.file(new URL('../src/client/tokens.css', import.meta.url)).text()
  const dark = css.indexOf('@variant dark-tokens')
  const read = (block: string) =>
    Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]))
  const light = read(css.slice(0, dark))
  return { light, dark: { ...light, ...read(css.slice(dark)) } }
}

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

// Every opaque surface text sits on, from the window to a pressed control and the strong fill under badges.
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
const LABELS = ['label', 'label-2', 'label-3']

describe('text tokens keep WCAG AA contrast', async () => {
  const all = await themes()
  for (const [theme, tokens] of Object.entries(all))
    for (const label of LABELS)
      for (const surface of SURFACES)
        test(`${theme}: ${label} on ${surface}`, () => {
          const fg = tokens[label]
          const bg = tokens[surface]
          expect(fg && bg).toBeTruthy()
          expect(contrast(fg as string, bg as string)).toBeGreaterThanOrEqual(4.5)
        })
})

describe('crew map links stand out from the window at 3:1, as lines that carry meaning must', async () => {
  const all = await themes()
  for (const [theme, tokens] of Object.entries(all))
    for (const line of ['edge', 'accent-text'])
      test(`${theme}: ${line} on window`, () => {
        expect(contrast(tokens[line] as string, tokens.window as string)).toBeGreaterThanOrEqual(3)
      })
})

test('initials on any agent or author colour read at 4.5:1', async () => {
  const { inkOn } = await import('../src/client/ui/pixel.tsx')
  const { JUDGE_COLOR, LEAD_COLOR, USER_COLOR, WORKER_PALETTE } = await import('@myrmidon/protocol')
  const { light } = await themes()
  // Both inks are the same in either theme.
  const inks: Record<string, string | undefined> = {
    'var(--on-bright)': light['on-bright'],
    'var(--on-deep)': light['on-deep'],
  }
  for (const fill of [...WORKER_PALETTE, LEAD_COLOR, JUDGE_COLOR, USER_COLOR])
    expect(contrast(inks[inkOn(fill)] as string, fill)).toBeGreaterThanOrEqual(4.5)
})

test('text on an agent colour takes whichever ink has more contrast', async () => {
  const { inkOn } = await import('../src/client/ui/pixel.tsx')
  // A mid blue: white reads at only 3.7:1 on it, near-black at 5.3:1.
  expect(inkOn('#4d7cff')).toBe('var(--on-bright)')
  expect(inkOn('#1d4ed8')).toBe('var(--on-deep)')
  expect(inkOn('#ffb31a')).toBe('var(--on-bright)')
})
