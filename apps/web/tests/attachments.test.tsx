import { afterAll, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// Attachments reaches api.ts, which reads the page's address and storage when it loads.
const page = globalThis as unknown as Record<string, unknown>
let ui: typeof import('../src/client/chat/Attachments.tsx')
beforeAll(async () => {
  page.window = new EventTarget()
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
  ui = await import('../src/client/chat/Attachments.tsx')
})
afterAll(() => {
  delete page.window
  delete page.location
})

test('files are told apart by kind, from their type or their name', () => {
  const { fileKind } = ui
  expect(fileKind('photo-6.jpg', 'image/jpeg')).toBe('image')
  expect(fileKind('sticker.webp')).toBe('image')
  expect(fileKind('report.pdf')).toBe('pdf')
  expect(fileKind('voice-3.ogg', 'audio/ogg')).toBe('audio')
  expect(fileKind('data.csv')).toBe('sheet')
  expect(fileKind('main.ts')).toBe('code')
  expect(fileKind('notes.md')).toBe('text')
  expect(fileKind('blob.bin')).toBe('file')
})

test('a file card names the file and says what it is and how big', () => {
  const { FileCard } = ui
  const html = renderToStaticMarkup(<FileCard name="report.pdf" size={2_400_000} />)
  expect(html).toContain('report.pdf')
  expect(html).toContain('PDF · 2.3 MB')
})

test('before sending, pictures are thumbnails and other files cards, each removable', () => {
  const { PendingFiles } = ui
  const photo = new File([new Uint8Array([0xff, 0xd8])], 'cat.jpg', { type: 'image/jpeg' })
  const pdf = new File([new Uint8Array(10)], 'plan.pdf', { type: 'application/pdf' })
  const html = renderToStaticMarkup(<PendingFiles files={[photo, pdf]} onRemove={() => {}} />)
  // The picture's tile (its image appears once the page makes it an address) and the PDF's card.
  expect(html).toContain('Remove cat.jpg')
  expect(html).toContain('width:64px')
  expect(html).toContain('plan.pdf')
  expect(html).toContain('PDF · 10 B')
  expect(html).toContain('Remove plan.pdf')
})
