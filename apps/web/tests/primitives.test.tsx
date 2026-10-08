import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, CountBadge, Dot, IconButton } from '../src/client/ui/primitives.tsx'

test('a loading button waits: it is busy, cannot be pressed again, and shows a spinner instead of its icon', () => {
  const html = renderToStaticMarkup(
    <Button loading icon={<svg data-icon="plus" />}>
      Add
    </Button>,
  )
  expect(html).toContain('disabled=""')
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('animate-spin')
  expect(html).not.toContain('data-icon="plus"')
  const idle = renderToStaticMarkup(<Button icon={<svg data-icon="plus" />}>Add</Button>)
  expect(idle).not.toContain('aria-busy')
  expect(idle).toContain('data-icon="plus"')
})

test('small buttons and small icon buttons stand the same height', () => {
  expect(renderToStaticMarkup(<Button size="sm">Go</Button>)).toContain('h-6')
  expect(renderToStaticMarkup(<IconButton size="sm" label="Go" />)).toContain('size-6')
})

test('a disabled icon button does not answer the pointer', () => {
  expect(renderToStaticMarkup(<IconButton label="Go" disabled />)).toContain('disabled:pointer-events-none')
})

test('a dot takes its colour from a status or a tone, and only moving work pings by default', () => {
  expect(renderToStaticMarkup(<Dot status="failed" />)).toContain('bg-bad')
  expect(renderToStaticMarkup(<Dot tone="ok" />)).toContain('bg-ok')
  expect(renderToStaticMarkup(<Dot status="running" />)).toContain('animate-ping')
  expect(renderToStaticMarkup(<Dot status="running" pulse={false} />)).not.toContain('animate-ping')
  expect(renderToStaticMarkup(<Dot tone="ok" pulse />)).toContain('animate-ping')
})

test('a count badge reads as its sentence when it has one, and caps long counts', () => {
  const html = renderToStaticMarkup(<CountBadge count={3} tone="accent" label="3 people waiting" />)
  expect(html).toContain('aria-label="3 people waiting"')
  expect(html).toContain('text-on-accent')
  expect(renderToStaticMarkup(<CountBadge count={140} />)).toContain('99+')
})
