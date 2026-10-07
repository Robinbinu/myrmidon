import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStore } from '@myrmidon/runtime'
import { buildPluginUI, uiStamp } from '../src/plugin-ui.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-plugin-ui-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("a plugin's UI is bundled against the page's React and UI kit, not copies of them", async () => {
  const at = join(dir, 'plugins', 'board')
  mkdirSync(join(at, 'ui'), { recursive: true })
  writeFileSync(
    join(at, 'ui', 'index.tsx'),
    `import { useState } from 'react'
import { Button } from '@myrmidon/ui'
function Board(props: { colonyId: string }) {
  const [n, setN] = useState(0)
  return <Button onClick={() => setN(n + 1)}>{props.colonyId}: {n}</Button>
}
export const slots = { 'workspace.tab': { title: 'Board', component: Board } }
`,
  )
  const plugin = new PluginStore(dir).list()[0]
  expect(plugin?.ui).toBe('ui/index.tsx')
  if (!plugin) throw new Error('no plugin')
  const code = await buildPluginUI(plugin)
  expect(code).toContain('globalThis.__myrmidon.React')
  expect(code).toContain('globalThis.__myrmidon.ui')
  expect(code).toContain('globalThis.__myrmidon.jsxRuntime')
  // React's own source never rides along.
  expect(code).not.toContain('react.production')
  expect(code.length).toBeLessThan(5_000)

  // The stamp moves when a UI file changes, so the page reloads it.
  const before = uiStamp(plugin)
  await Bun.sleep(20)
  writeFileSync(join(at, 'ui', 'index.tsx'), 'export const slots = {}\n')
  expect(uiStamp(plugin)).not.toBe(before)
})
