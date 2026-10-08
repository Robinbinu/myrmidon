import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, plainText } from '../src/client/chat/Markdown.tsx'

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

test('plain text keeps the words and drops the markup, for reading out', () => {
  expect(
    plainText(
      "I'll fix **`calc.py`** first.\n\n## Plan\n\n- Fix `add`\n- Run *the tests*\n\nSee [docs](https://x.y)",
    ),
  ).toBe("I'll fix calc.py first.\n\nPlan\n\nFix add\nRun the tests\n\nSee docs")
  expect(plainText('snake_case_name stays')).toBe('snake_case_name stays')
})

test('a long line of unclosed brackets renders in linear time', () => {
  for (const line of ['[a'.repeat(25_000), '[a](x'.repeat(10_000)]) {
    const start = performance.now()
    html(line)
    plainText(line)
    // Quadratic matching took seconds on these 50k-character lines; linear takes a few milliseconds.
    expect(performance.now() - start).toBeLessThan(1000)
  }
})

test('a link inside an unclosed bracket still links', () => {
  const out = html('see [a [docs](https://example.com) here')
  expect(out).toContain('see [a <a ')
  expect(out).toMatch(/href="https:\/\/example.com"[^>]*>docs<\/a> here/)
  expect(plainText('see [a [docs](https://example.com) here')).toBe('see [a docs here')
})
