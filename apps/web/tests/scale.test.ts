import { expect, test } from 'bun:test'

const css = await Bun.file(new URL('../src/client/styles.css', import.meta.url)).text()
const steps = (prefix: string) =>
  [...css.matchAll(new RegExp(`--${prefix}-([\\w-]+):\\s*([\\d.]+)px;`, 'g'))].map((m) => ({
    name: m[1],
    px: Number(m[2]),
  }))

test('corner radii grow with their names, so rounded-lg is never rounder than rounded-xl', () => {
  const order = ['xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']
  const radii = steps('radius')
  expect(radii.map((r) => r.name)).toEqual(order)
  for (let i = 1; i < radii.length; i++) expect(radii[i]?.px ?? 0).toBeGreaterThan(radii[i - 1]?.px ?? 0)
})

test('type steps grow in the order they are declared, from caption to page title', () => {
  const sizes = steps('text')
  expect(sizes.at(0)?.name).toBe('caption')
  expect(sizes.at(-1)?.name).toBe('page-title')
  for (let i = 1; i < sizes.length; i++) expect(sizes[i]?.px ?? 0).toBeGreaterThan(sizes[i - 1]?.px ?? 0)
})

test('written answers keep three heading sizes above the 13.5px reading text', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { Markdown } = await import('../src/client/chat/Markdown.tsx')
  const html = renderToStaticMarkup(createElement(Markdown, { text: '# One\n\n## Two\n\n### Three' }))
  const px = (cls: string) => steps('text').find((s) => s.name === cls)?.px ?? 0
  const used = [...html.matchAll(/class="[^"]*text-([\w-]+) font-semibold/g)].map((m) => px(m[1] ?? ''))
  expect(used).toHaveLength(3)
  expect(used[0]).toBeGreaterThan(used[1] ?? 0)
  expect(used[1]).toBeGreaterThan(used[2] ?? 0)
  expect(used[2]).toBeGreaterThan(13.5)
})
