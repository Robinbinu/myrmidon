import { expect, test } from 'bun:test'
import { buildVisualLibs, visualLibs } from '../src/visual-libs.ts'

test('the drawing libraries bundle on their own for the browser, once, with what the renderers use', async () => {
  const code = await buildVisualLibs()
  for (const name of ['mermaid', 'vegaParse', 'VegaView', 'expressionInterpreter', 'vegaLiteCompile'])
    expect(code).toMatch(new RegExp(`\\b${name}\\b`))
  // The browser build of Vega's canvas, never its Node one that looks for a native canvas package.
  expect(code).not.toContain('createCanvas')
  expect(await visualLibs()).toBe(await visualLibs())
}, 60_000)
