import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Process } from '@oh-my-pi/pi-natives'
import {
  childCommands,
  openPersonTerminal,
  type PersonTerminal,
  TerminalFolderMissing,
} from '../src/person-terminal.ts'
import { hostProbe, type ShellProbe } from '../src/shell.ts'

/** Opens a terminal, types `line`, and returns what it printed once `until` shows up. */
async function typeInto(probe: ShellProbe, line: string, until: string) {
  const dir = mkdtempSync(join(tmpdir(), 'myr-term-'))
  let out = ''
  let term: PersonTerminal | undefined
  try {
    term = await openPersonTerminal(
      {
        cwd: dir,
        cols: 80,
        rows: 24,
        env: { ...process.env, TERM: 'xterm-256color' },
        onData: (c) => {
          out += new TextDecoder().decode(c)
        },
      },
      probe,
    )
    term.write(`${line}\r`)
    for (let i = 0; i < 100 && !out.includes(until); i++) await Bun.sleep(50)
    return { out, pid: term.pid }
  } finally {
    term?.close()
    await term?.exited
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the person's terminal runs their shell in a PTY here", async () => {
  // PowerShell on Windows; the echoed input itself never shows the answer.
  const sum = process.platform === 'win32' ? '40 + 2' : 'echo $((40 + 2))'
  const { out } = await typeInto(hostProbe(), sum, '42')
  expect(out).toContain('42')
})

test.skipIf(process.platform === 'win32')(
  "Windows' terminal runs in pi-natives' PTY session (ConPTY there), checked here with sh as its shell",
  async () => {
    // No PowerShell on this probe, so the terminal falls back to ComSpec, which is sh here.
    const windowsLike: ShellProbe = {
      ...hostProbe(),
      platform: 'win32',
      which: () => null,
      exists: () => false,
      env: { ComSpec: '/bin/sh' },
    }
    const { out, pid } = await typeInto(windowsLike, 'echo $((40 + 2))', '42')
    expect(out).toContain('42')
    expect(pid).toBeGreaterThan(0)
  },
)

test('a folder that is gone is said so, before any shell starts', async () => {
  await expect(
    openPersonTerminal({
      cwd: join(tmpdir(), 'myr-gone-folder'),
      cols: 80,
      rows: 24,
      env: {},
      onData: () => {},
    }),
  ).rejects.toBeInstanceOf(TerminalFolderMissing)
})

test("a process's children are listed with their command lines, and none once it has gone", async () => {
  const windows = process.platform === 'win32'
  const proc = Bun.spawn(windows ? ['cmd.exe', '/c', 'ping -n 30 127.0.0.1'] : ['sh', '-c', 'sleep 30; true'])
  try {
    let children: string[][] = []
    for (let i = 0; i < 50 && !children.length; i++) {
      await Bun.sleep(50)
      children = childCommands(proc.pid)
    }
    expect(children.map((args) => args.at(-1))).toEqual([windows ? '127.0.0.1' : '30'])
  } finally {
    Process.fromPid(proc.pid)?.killTree(9)
  }
  await proc.exited
  expect(childCommands(proc.pid)).toEqual([])
})
