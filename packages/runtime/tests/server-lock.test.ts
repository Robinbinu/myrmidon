import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimServerHome } from '../src/server-lock.ts'

const MODULE = join(import.meta.dir, '..', 'src', 'server-lock.ts')

test('one server per home: a second process cannot claim it until the first has gone, however it went', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-lock-'))
  try {
    // The first server: claims the home, says so, and holds it until killed.
    const first = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { claimServerHome } = await import(${JSON.stringify(MODULE)}); console.log(claimServerHome(${JSON.stringify(home)})); setInterval(() => {}, 1000)`,
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    )
    const said = await first.stdout.getReader().read()
    expect(new TextDecoder().decode(said.value).trim()).toBe('true')
    expect(claimServerHome(home)).toBe(false)
    // Killed, with no chance to let go itself: the OS does.
    first.kill('SIGKILL')
    await first.exited
    expect(claimServerHome(home)).toBe(true)
    // Claiming again from the process that holds it is not a second server.
    expect(claimServerHome(home)).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
