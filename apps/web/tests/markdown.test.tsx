import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/client/chat/Markdown.tsx'

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

test('bold and italics keep the inline code and links inside them', () => {
  const out = html('Edited **`calc.py`** and *see [docs](https://example.com)*')
  expect(out).toContain('<strong class="font-semibold text-fg"><code')
  expect(out).toContain('>calc.py</code></strong>')
  expect(out).not.toContain('`')
  expect(out).toMatch(/<em class="italic">see <a [^>]*href="https:\/\/example.com"/)
})

test('headings are heading elements, starting at h3', () => {
  const out = html('# Title\n## Part\n### Detail\n#### Small')
  expect(out).toMatch(/<h3 [^>]*>Title<\/h3>/)
  expect(out).toMatch(/<h4 [^>]*>Part<\/h4>/)
  expect(out).toMatch(/<h5 [^>]*>Detail<\/h5>/)
  expect(out).toMatch(/<h5 [^>]*>Small<\/h5>/)
  expect(out).not.toContain('<p')
})

test('model output never becomes HTML, even inside emphasis', () => {
  const out = html('**<img src=x onerror=alert(1)>** and `<b>`')
  expect(out).not.toContain('<img')
  expect(out).not.toContain('<b>')
  expect(out).toContain('&lt;img')
})
