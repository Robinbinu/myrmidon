/**
 * A manual smoke test of omp's desktop engine on this Mac, never run by `bun test`: it starts omp's computer worker,
 * then, in a read-only script, reads the engine's capabilities and lists which apps have windows. It never clicks,
 * types or opens anything, and prints no window titles.
 *
 *   bun packages/runtime/scripts/omp-desktop-smoke.ts
 *
 * macOS answers its grants for the app running it (the terminal): without Screen Recording the list may be short.
 */
import { DesktopEngine } from '../src/computer/desktop.ts'

const engine = new DesktopEngine({
  launch: async () => {
    throw new Error('the smoke test opens no apps')
  },
})
const code = `
  const windows = await desktop.windows()
  const apps = [...new Set(windows.map((w) => w.app))].sort()
  return { capabilities: desktop.capabilities(), windows: windows.length, apps }
`
try {
  const run = await engine.run({ colonyId: 'smoke', agent: 'smoke' }, code, {
    timeoutMs: 20_000,
    readOnly: true,
    cwd: process.cwd(),
  })
  console.log(JSON.stringify(run.returnValue, null, 2))
} finally {
  await engine.closeAll()
}
