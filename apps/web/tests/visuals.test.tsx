import { afterEach, expect, mock, test } from 'bun:test'
import { visualFallback } from '@myrmidon/protocol'
import { act } from 'react'
import { CHART_MAX_ROWS, TABLE_FILTER_FROM, VISUAL_MAX_CHARS } from '../src/client/ui-config.ts'
import { mount, withDom } from './dom.ts'

withDom()

// Vega's Node build looks for the optional `canvas` package as it loads; the app's bundle takes the browser build.
mock.module('canvas', () => ({}))
// The page loads the drawing libraries from the server's own bundle of them; here they load as modules.
mock.module('../src/client/chat/visuals/load-libs.ts', () => ({
  VISUAL_LIBS_PATH: '/visual-libs.js',
  loadVisualLibs: () => import('../src/client/chat/visuals/libs.ts'),
}))

// Modules that touch the page load inside the tests, once the page is up.
const load = async () => ({
  ...(await import('../src/client/chat/visuals/spec.ts')),
  ...(await import('../src/client/chat/Markdown.tsx')),
  ...(await import('../src/client/chat/visuals/Widget.tsx')),
  ...(await import('../src/client/chat/visuals/Diagram.tsx')),
})

const fence = (lang: string, body: string) => `Before.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\nAfter.`
const bar = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  title: 'Visitors',
  data: {
    values: [
      { park: 'Yosemite', visitors: 4 },
      { park: 'Zion', visitors: 5 },
    ],
  },
  mark: 'bar',
  encoding: { x: { field: 'park', type: 'nominal' }, y: { field: 'visitors', type: 'quantitative' } },
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  document.body.innerHTML = ''
})

test('a chart spec is Vega-Lite with its data inline, and nothing in it may name an address', async () => {
  const { parseVisual } = await load()
  expect(parseVisual('chart', JSON.stringify(bar))).toMatchObject({ ok: true, visual: { kind: 'chart' } })
  const refused = (spec: unknown) => parseVisual('chart', JSON.stringify(spec))
  expect(refused({ ...bar, data: { url: 'https://evil.example/data.csv' } })).toMatchObject({ ok: false })
  expect(refused({ ...bar, encoding: { ...bar.encoding, href: { field: 'park' } } })).toMatchObject({
    ok: false,
  })
  expect(refused({ ...bar, layer: [{ mark: { type: 'image', url: 'https://x.y/a.png' } }] })).toMatchObject({
    ok: false,
  })
  expect(refused({ ...bar, $schema: 'https://vega.github.io/schema/vega/v6.json' })).toMatchObject({
    ok: false,
  })
  expect(refused({ data: bar.data })).toMatchObject({ ok: false })
  expect(refused([1, 2])).toMatchObject({ ok: false })
  const many = Array.from({ length: CHART_MAX_ROWS + 1 }, (_, i) => ({ i }))
  expect(refused({ ...bar, data: { values: many } })).toMatchObject({ ok: false })
  expect(parseVisual('chart', '{not json')).toMatchObject({ ok: false })
  expect(parseVisual('chart', 'x'.repeat(VISUAL_MAX_CHARS.chart + 1))).toMatchObject({ ok: false })
})

test('a table is records, rows under a header, or columns and rows; a tree is any JSON', async () => {
  const { parseVisual } = await load()
  expect(parseVisual('table', '[{"a":1,"b":"x"},{"a":2,"c":true}]')).toEqual({
    ok: true,
    visual: {
      kind: 'table',
      columns: ['a', 'b', 'c'],
      rows: [
        [1, 'x', null],
        [2, null, true],
      ],
    },
  })
  expect(parseVisual('table', '[["name","n"],["a",1],["b",2,"extra"]]')).toMatchObject({
    ok: true,
    visual: {
      columns: ['name', 'n', ''],
      rows: [
        ['a', 1, null],
        ['b', 2, 'extra'],
      ],
    },
  })
  expect(parseVisual('table', '{"caption":"Two","columns":["x"],"rows":[[{"deep":1}]]}')).toMatchObject({
    ok: true,
    visual: { caption: 'Two', columns: ['x'], rows: [['{"deep":1}']] },
  })
  // Columns described as table libraries write them (what DeepSeek wrote in the real run).
  expect(
    parseVisual(
      'table',
      '{"columns":[{"key":"park","label":"Park"},{"field":"n","title":"Visitors"}],"rows":[{"park":"Zion","n":4.6}]}',
    ),
  ).toMatchObject({ ok: true, visual: { columns: ['Park', 'Visitors'], rows: [['Zion', 4.6]] } })
  expect(parseVisual('table', '[]')).toMatchObject({ ok: false })
  expect(parseVisual('table', '"text"')).toMatchObject({ ok: false })
  expect(parseVisual('table', '[1, {"a":1}]')).toMatchObject({ ok: false })
  expect(parseVisual('tree', '{"a":[1,2]}')).toEqual({
    ok: true,
    visual: { kind: 'tree', value: { a: [1, 2] } },
  })
  expect(parseVisual('tree', 'src/\n├── a.ts')).toMatchObject({ ok: false })
})

test("mermaid keeps the app's theme, and an SVG figure loses whatever could run or reach out", async () => {
  const { parseVisual, sanitizeSvg } = await load()
  expect(parseVisual('mermaid', "%%{init: {'theme':'forest'}}%%\ngraph TD\n  A-->B")).toEqual({
    ok: true,
    visual: { kind: 'mermaid', source: 'graph TD\n  A-->B' },
  })
  const svg = sanitizeSvg(
    '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject>' +
      '<image href="https://evil.example/p.png"/><use href="#a"/><rect fill="url(https://e.x/a)" onclick="x()"/>' +
      '<animate attributeName="x"/><circle id="a" r="2" fill="var(--c1)"/></svg>',
  )
  expect(svg).toBeString()
  for (const gone of [
    'onload',
    'script',
    'alert',
    'foreignObject',
    'evil.example',
    'e.x/a',
    'onclick',
    'animate',
  ])
    expect(svg).not.toContain(gone)
  expect(svg).toContain('href="#a"')
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(sanitizeSvg('<div>not svg</div>')).toBeUndefined()
  expect(parseVisual('svg', 'not svg at all')).toMatchObject({ ok: false })
})

test('a channel, a voice reply or a copy gets a line naming each visual; mermaid and plain code stay', async () => {
  const { plainText, withoutVisuals } = await load()
  const reply = [
    'Visitors rose.',
    '```chart',
    JSON.stringify(bar),
    '```',
    '```widget',
    '<title>Loan calculator</title><input>',
    '```',
    '```mermaid',
    'graph TD',
    '  A-->B',
    '```',
    '```ts',
    'const chart = 1',
    '```',
    'Done.',
  ].join('\n')
  const flat = withoutVisuals(reply)
  expect(flat).toContain('[Chart: Visitors]')
  expect(flat).toContain('[Widget: Loan calculator]')
  expect(flat).toContain('A-->B')
  expect(flat).toContain('const chart = 1')
  expect(flat).not.toContain('"mark"')
  expect(plainText(reply)).toStartWith('Visitors rose.\n[Chart: Visitors]')
  // An unclosed fence (a reply still streaming) and a fence inside code are left alone.
  expect(visualFallback('```chart\n{"mark":"bar"', () => 'X')).toBe('```chart\n{"mark":"bar"')
  expect(visualFallback('````md\n```chart\n{}\n```\n````', () => 'X')).toBe('````md\n```chart\n{}\n```\n````')
})

test('each block kind draws in its frame, with the text around it kept', async () => {
  const { Markdown } = await load()
  const table = JSON.stringify([
    { city: 'Oslo', temp: 4 },
    { city: 'Lima', temp: 19 },
    { city: 'Cairo', temp: 30 },
  ])
  const md = [
    fence('table', table),
    fence('json-tree', '{"plan":{"steps":[1,2,3]},"ok":true}'),
    fence('svg', '<svg viewBox="0 0 20 10"><text fill="var(--fg)">Hi</text></svg>'),
    fence('widget', '<title>Counter</title><button onclick="n.textContent=++c">+</button><b id=n>0</b>'),
  ].join('\n\n')
  const view = await mount(<Markdown text={md} />)
  const figures = [...view.host.querySelectorAll('figure')]
  expect(
    figures.map((f) =>
      f
        .querySelector('figcaption')
        ?.textContent?.split('·')[0]
        ?.trim()
        .replace(/Source.*/, ''),
    ),
  ).toEqual(['Table', 'JSON', 'Figure', 'Widget'])
  expect(view.host.textContent).toContain('Before.')
  expect(view.host.textContent).toContain('After.')
  // The table sorts by a header, numbers by value.
  const cities = () =>
    [...view.host.querySelectorAll('figure:first-of-type tbody tr td:first-child')].map(
      (td) => td.textContent,
    )
  expect(cities()).toEqual(['Oslo', 'Lima', 'Cairo'])
  const tempHeader = [...view.host.querySelectorAll('figure:first-of-type th button')][1] as HTMLButtonElement
  await act(async () => tempHeader.click())
  await act(async () => tempHeader.click())
  expect(cities()).toEqual(['Cairo', 'Lima', 'Oslo'])
  // The tree opens and folds.
  expect(view.host.textContent).toContain('"steps"'.replace(/"/g, ''))
  // The figure is an image, its theme references made concrete.
  const img = figures[2]?.querySelector('img')
  expect(img?.getAttribute('src')).toStartWith('data:image/svg+xml')
  expect(decodeURIComponent(img?.getAttribute('src') ?? '')).not.toContain('var(--fg)')
  await view.unmount()
})

test("a widget runs sandboxed: scripts only, no network, and the app reads nothing but its frame's height", async () => {
  const { Markdown, WIDGET_CSP, WIDGET_SANDBOX, widgetDocument } = await load()
  const view = await mount(
    <Markdown
      text={fence('widget', '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>hi</p>')}
    />,
  )
  const frame = view.host.querySelector('iframe') as HTMLIFrameElement
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(WIDGET_SANDBOX).not.toContain('same-origin')
  const doc = frame.getAttribute('srcdoc') ?? ''
  // The policy comes first, before anything the agent wrote.
  expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<p>hi</p>'))
  for (const rule of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'"])
    expect(WIDGET_CSP).toContain(rule)
  expect(doc).not.toContain('evil.example')
  // A height from anywhere but the frame's own window is ignored.
  const before = frame.style.height
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'myr-widget-size', id: 'w1', height: 400 } }),
    )
  })
  expect(frame.style.height).toBe(before)
  expect(
    widgetDocument(
      '<p>x</p>',
      { ...(await import('../src/client/chat/visuals/theme.ts')).readVisualTheme(), dark: true },
      'w9',
      true,
    ),
  ).toContain('animation:none')
  await view.unmount()
})

test('a bad spec shows as code with the reason, and a fence still streaming shows a placeholder', async () => {
  const { Markdown } = await load()
  const bad = await mount(
    <Markdown text={fence('chart', JSON.stringify({ ...bar, data: { url: 'https://x.y/d.csv' } }))} />,
  )
  expect(bad.host.textContent).toContain('Couldn’t draw this chart: its data must be inline values')
  expect(bad.host.querySelector('pre code')?.textContent).toContain('"url"')
  await bad.unmount()
  const streaming = await mount(<Markdown text={'Here:\n\n```chart\n{"mark":'} />)
  expect(streaming.host.querySelector('[aria-busy="true"]')?.textContent).toContain('Drawing the chart')
  await streaming.unmount()
})

test('Markdown tables sort and, when long, filter; pictures come only from inline data', async () => {
  const { Markdown } = await load()
  const rows = Array.from({ length: TABLE_FILTER_FROM }, (_, i) => `| item ${i} | ${i * 3} |`).join('\n')
  const view = await mount(
    <Markdown
      text={`| Name | **Score** |\n|---|---|\n${rows}\n\n![dot](data:image/png;base64,iVBORw0KGgo=) and ![far](https://x.y/a.png)`}
    />,
  )
  expect(view.host.querySelector('th strong')?.textContent).toBe('Score')
  const filter = view.host.querySelector('input[type="search"]') as HTMLInputElement
  expect(filter).not.toBeNull()
  await act(async () => {
    filter.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, 'item 7')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    filter.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '7' }))
  })
  expect(view.host.querySelectorAll('tbody tr')).toHaveLength(1)
  const imgs = [...view.host.querySelectorAll('img')].map((i) => i.getAttribute('src'))
  expect(imgs).toEqual(['data:image/png;base64,iVBORw0KGgo='])
  await view.unmount()
})

test('a chart draws with Vega in the app theme, through a loader that loads nothing', async () => {
  const { Markdown } = await load()
  const view = await mount(<Markdown text={fence('chart', JSON.stringify(bar))} />)
  const drawn = () => view.host.querySelector('figure > div svg')
  for (let i = 0; i < 50 && !drawn(); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
  const svg = drawn()
  expect(svg).not.toBeNull()
  expect(view.host.textContent).toContain('Visitors')
  expect(view.host.textContent).toContain('Yosemite')
  await view.unmount()
})

test("mermaid's drawing gets its own size from its viewBox, so an image can fit it to the chat", async () => {
  const { sized } = await load()
  expect(sized('<svg id="m" width="100%" style="max-width: 500px;" viewBox="0 0 500 120"><g/></svg>')).toBe(
    '<svg width="500" height="120" id="m" viewBox="0 0 500 120"><g/></svg>',
  )
})

test("a code cell's displays draw as a table, a tree, a chart and a picture", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png' },
    })) as unknown as typeof fetch
  URL.createObjectURL ??= () => 'blob:x'
  const { CellDisplays } = await import('../src/client/chat/visuals/CellDisplays.tsx')
  const view = await mount(
    <CellDisplays
      colony="c1"
      displays={[
        { kind: 'json', json: '[{"n":1,"sq":1},{"n":2,"sq":4}]' },
        { kind: 'json', json: '{"a":{"b":1}}' },
        { kind: 'json', json: '{"cut":' },
        { kind: 'chart', json: JSON.stringify(bar) },
        { kind: 'image', blob: 'abc', mimeType: 'image/png' },
      ]}
    />,
  )
  for (let i = 0; i < 50 && view.host.querySelectorAll('figure img').length === 0; i++)
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  const kinds = [...view.host.querySelectorAll('figcaption')].map(
    (c) => c.textContent?.match(/^(Table|JSON|Chart|Picture)/)?.[0],
  )
  expect(kinds).toEqual(['Table', 'JSON', 'Chart', 'Picture'])
  expect(view.host.querySelector('tbody')?.textContent).toContain('4')
  // A cut value is shown as its text.
  expect(view.host.querySelector('pre')?.textContent).toBe('{"cut":')
  await view.unmount()
})
