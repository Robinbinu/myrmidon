import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PLUGIN_UI_KIT } from '@myrmidon/protocol'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// plugins.tsx pulls in api.ts, which reads the page's address and storage when it loads.
const page = globalThis as unknown as Record<string, unknown>
beforeAll(() => {
  page.window = new EventTarget()
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})
afterAll(() => {
  delete page.window
  delete page.location
})

async function kit() {
  await import('../src/client/plugins.tsx')
  const ui = (
    globalThis as unknown as { __myrmidon: { ui: Record<string, ComponentType<Record<string, unknown>>> } }
  ).__myrmidon.ui
  const html = (name: string, props: Record<string, unknown>) => {
    const C = ui[name]
    if (!C) throw new Error(`the kit has no ${name}`)
    return renderToStaticMarkup(<C {...props} />)
  }
  return { ui, html }
}

test('the kit offers every name the plugin contract lists, Pill included', async () => {
  const { ui } = await kit()
  for (const name of PLUGIN_UI_KIT) expect(ui[name]).toBeDefined()
  expect(ui.Pill).toBe(ui.Badge)
})

test("plugins using the kit's older button names still get a styled button", async () => {
  const { html } = await kit()
  const look = (variant?: string) => html('Button', { variant, children: 'Go' })
  expect(look('ghost')).toBe(look('borderless'))
  expect(look('toolbar')).toBe(look('borderless'))
  expect(look('secondary')).toBe(look('push'))
  // Soft was a quiet tinted button; it maps to a quiet one, never the solid primary.
  expect(look('soft')).toBe(look('push'))
  expect(look('soft')).not.toBe(look('primary'))
  expect(html('Pill', { tone: 'ok', children: 'done' })).toBe(html('Badge', { tone: 'ok', children: 'done' }))
})
