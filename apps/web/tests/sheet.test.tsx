import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { closesDialog } from '../src/client/ui/dialog.ts'
import { Sheet } from '../src/client/ui/Sheet.tsx'

const key = (k: string, code: string, meta = false) => ({
  key: k,
  code,
  metaKey: meta,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
})

test('Escape and ⌘. close the topmost sheet; a plain full stop does not', () => {
  expect(closesDialog(key('Escape', 'Escape'))).toBe(true)
  expect(closesDialog(key('.', 'Period', true))).toBe(true)
  expect(closesDialog(key('.', 'Period'))).toBe(false)
})

test('a sheet is a modal dialog named by its title, with a way to close it', () => {
  const html = renderToStaticMarkup(
    <Sheet title="Delete chat" onClose={() => {}}>
      <p>Body</p>
    </Sheet>,
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1]
  expect(labelledBy).toBeTruthy()
  expect(html).toContain(`id="${labelledBy}"`)
  expect(html).toContain('aria-label="Close"')
  // It comes out from under the title bar rather than floating in the middle of the window.
  expect(html).toContain('items-start')
})
