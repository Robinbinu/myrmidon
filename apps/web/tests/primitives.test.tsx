import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MenuItem } from '../src/client/ui/Popover.tsx'
import {
  Banner,
  Button,
  Card,
  CountBadge,
  Dot,
  IconButton,
  Tabs,
  tabPanel,
} from '../src/client/ui/primitives.tsx'
import { dotShape } from '../src/client/ui/status.ts'

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

test('a dot follows Claude Code: only work spins, yellow fill needs you, green fill is new, grey ring is seen', () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
  expect(html(<Dot status="running" />)).toContain('animate-spin')
  // With less motion, or where it would never stop, work holds still.
  expect(html(<Dot status="running" />)).toContain('less-motion:hidden')
  expect(html(<Dot status="running" pulse={false} />)).not.toContain('animate-spin')
  expect(html(<Dot status="awaiting" />)).toContain('bg-accent')
  expect(html(<Dot status="unread" />)).toContain('bg-ok')
  expect(html(<Dot status="failed" />)).toContain('<svg')
  expect(html(<Dot tone="bad" />)).toContain('<svg')
  expect(html(<Dot tone="ok" />)).toContain('bg-ok')
  // Seen, a finished chat is a grey ring like a resting one; yellow and green fills ask for a look.
  expect(html(<Dot status="completed" />)).toContain('border-muted')
  expect(html(<Dot status="completed" />)).not.toContain('bg-')
  for (const status of ['awaiting', 'unread', 'completed', 'stopped', 'failed', 'idle', 'pending', 'on'])
    expect(html(<Dot status={status} />)).not.toContain('animate-')
  expect(
    ['running', 'awaiting', 'unread', 'on', 'completed', 'idle', 'pending', 'stopped', 'failed'].map(
      dotShape,
    ),
  ).toEqual(['spinner', 'alert', 'unread', 'live', 'done', 'idle', 'queued', 'stopped', 'failed'])
})

test('a count badge reads as its sentence when it has one, and caps long counts', () => {
  const html = renderToStaticMarkup(<CountBadge count={3} tone="accent" label="3 people waiting" />)
  expect(html).toContain('aria-label="3 people waiting"')
  expect(html).toContain('text-on-accent')
  expect(renderToStaticMarkup(<CountBadge count={140} />)).toContain('99+')
})

test('tabs are one Tab stop, and each names the panel it shows', () => {
  const html = renderToStaticMarkup(
    <Tabs
      id="t"
      value={'b' as 'a' | 'b'}
      onChange={() => {}}
      tabs={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]}
    />,
  )
  expect(html).toContain('id="t-tab-a"')
  expect(html.match(/tabindex="0"/g)?.length).toBe(1)
  expect(html).toContain('aria-controls="t-panel"')
  expect(tabPanel('t', 'b')).toEqual({ role: 'tabpanel', id: 't-panel', 'aria-labelledby': 't-tab-b' })
})

test('menu items are reached by arrow keys; a chosen radio item is the one Tab stop', () => {
  const plain = renderToStaticMarkup(<MenuItem title="Lead" onSelect={() => {}} />)
  expect(plain).toContain('role="menuitem"')
  expect(plain).toContain('tabindex="-1"')
  const chosen = renderToStaticMarkup(<MenuItem title="Auto" checked onSelect={() => {}} />)
  expect(chosen).toContain('role="menuitemradio"')
  expect(chosen).toContain('aria-checked="true"')
  expect(chosen).toContain('tabindex="0"')
})

test('a card with a title is a section named by its heading; a banner speaks only when asked', () => {
  const card = renderToStaticMarkup(<Card title="Gateway">row</Card>)
  expect(card).toStartWith('<section')
  expect(card).toContain('<h2')
  expect(renderToStaticMarkup(<Card>row</Card>)).toStartWith('<div')
  expect(renderToStaticMarkup(<Banner tone="bad">x</Banner>)).not.toContain('role=')
  expect(
    renderToStaticMarkup(
      <Banner tone="bad" role="alert">
        x
      </Banner>,
    ),
  ).toContain('role="alert"')
})

test('with nothing chosen, the item marked as the Tab stop takes it', () => {
  const html = renderToStaticMarkup(<MenuItem title="Off" checked={false} tabStop onSelect={() => {}} />)
  expect(html).toContain('tabindex="0"')
  expect(html).toContain('aria-checked="false"')
})
