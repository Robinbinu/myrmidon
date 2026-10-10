import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'myr-home-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

test("the embedded omp writes its logs and request dumps inside Myrmidon's home, not ~/.omp", () => {
  // omp fixes its folders when first imported, so this runs as the CLI starts: home.ts first, then omp.
  const omp = join(import.meta.dir, '..', '..', '..', 'packages', 'runtime', 'src', 'omp', 'utils.ts')
  const script = `
    import ${JSON.stringify(join(import.meta.dir, '..', 'src', 'home.ts'))}
    const { getLogsDir } = await import(${JSON.stringify(omp)})
    console.log(getLogsDir())
  `
  const run = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, MYRMIDON_HOME: home } })
  expect(run.stderr.toString()).toBe('')
  expect(run.stdout.toString().trim()).toBe(join(home, 'omp', 'logs'))
})
