import { expect, test } from 'bun:test'
import { parseProcessTable, processTable, processTableArgv, treeOf } from '../src/leash.ts'
import { spawnLeashed, stopsByStdin } from '../src/leashed.ts'
import { commandWords, phononServers } from '../src/voice/stt.ts'

// Each OS's process listing, parsed from output captured on that OS; the leash's tree walk over it.

const MAC_PS = `    1     0     1 Ss   /sbin/launchd
  346     1   346 Ss   /usr/libexec/logd
  349     1   349 Ss   /usr/libexec/UserEventAgent (System)
 5120  4980  5120 S+   /bin/sh -c npm run dev
 5121  5120  5120 S+   node /Users/ana/app/node_modules/.bin/vite --port 5173
 5130  5121  5120 Z+   (node)
 5200     1  5120 S    sleep 600
`

/** `Get-CimInstance Win32_Process | Select-Object … | ConvertTo-Json -Compress` on Windows 11, abridged. */
const WINDOWS_JSON = `\uFEFF[{"ProcessId":0,"ParentProcessId":0,"CommandLine":null},{"ProcessId":4,"ParentProcessId":0,"CommandLine":null},{"ProcessId":7012,"ParentProcessId":6644,"CommandLine":"\\"C:\\\\Users\\\\Ana Lima\\\\.bun\\\\bin\\\\bun.exe\\" -e \\"/**\\" -- --grace=2000 \\"C:\\\\Program Files\\\\Git\\\\bin\\\\sh.exe\\" -c \\"npm run dev\\""},{"ProcessId":7040,"ParentProcessId":7012,"CommandLine":"\\"C:\\\\Program Files\\\\Git\\\\bin\\\\sh.exe\\" -c \\"npm run dev\\""},{"ProcessId":7088,"ParentProcessId":7040,"CommandLine":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" \\"C:\\\\Users\\\\Ana Lima\\\\app\\\\node_modules\\\\vite\\\\bin\\\\vite.js\\""},{"ProcessId":7300,"ParentProcessId":7099,"CommandLine":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" worker.js"},{"ProcessId":9100,"ParentProcessId":880,"CommandLine":"C:\\\\WINDOWS\\\\system32\\\\svchost.exe -k netsvcs -p"}]`

test('ps on macOS and Linux: pid, parent, group and command line; zombies are left out', () => {
  expect(processTableArgv('darwin')).toEqual(['ps', '-Ao', 'pid=,ppid=,pgid=,stat=,command='])
  const rows = parseProcessTable('linux', MAC_PS)
  expect(rows.map((r) => r.pid)).toEqual([1, 346, 349, 5120, 5121, 5200])
  expect(rows.find((r) => r.pid === 349)).toEqual({
    pid: 349,
    ppid: 1,
    pgid: 349,
    command: '/usr/libexec/UserEventAgent (System)',
  })
})

test('Windows: PowerShell lists processes as JSON, with their command lines; pid 0 is left out', () => {
  const argv = processTableArgv('win32')
  expect(argv[0]).toBe('powershell.exe')
  expect(argv.at(-1)).toContain('Get-CimInstance Win32_Process')
  const rows = parseProcessTable('win32', WINDOWS_JSON)
  expect(rows.map((r) => [r.pid, r.ppid])).toEqual([
    [4, 0],
    [7012, 6644],
    [7040, 7012],
    [7088, 7040],
    [7300, 7099],
    [9100, 880],
  ])
  expect(rows.find((r) => r.pid === 7040)?.command).toBe(
    '"C:\\Program Files\\Git\\bin\\sh.exe" -c "npm run dev"',
  )
  expect(rows.every((r) => r.pgid === undefined)).toBe(true)
  // One process is written as an object, not an array; output that is not JSON lists nothing.
  expect(parseProcessTable('win32', '{"ProcessId":12,"ParentProcessId":4,"CommandLine":"x"}')).toEqual([
    { pid: 12, ppid: 4, command: 'x' },
  ])
  expect(parseProcessTable('win32', 'Get-CimInstance : Access denied')).toEqual([])
})

test('a listing that cannot run is undefined, not an empty machine', () => {
  expect(processTable('win32', () => undefined)).toBeUndefined()
  expect(
    processTable('win32', (argv) => (argv[0] === 'powershell.exe' ? WINDOWS_JSON : undefined)),
  ).toHaveLength(6)
})

test("the leash's tree: below the command, its process group, and orphans it left in the group", () => {
  const rows = parseProcessTable('darwin', MAC_PS)
  // 5200 was orphaned to launchd but stays in the group; the zombie is gone already.
  expect([...treeOf(rows, 5120)].sort()).toEqual([5120, 5121, 5200])
})

test("on Windows the tree is found by parent ids, which outlive the parent: a gone command's children too", () => {
  const rows = parseProcessTable('win32', WINDOWS_JSON)
  expect([...treeOf(rows, 7012)].sort()).toEqual([7012, 7040, 7088])
  // The leash's command (7040) has exited: what it started still names it as parent.
  const orphaned = rows.filter((r) => r.pid !== 7040)
  expect([...treeOf(orphaned, 7040)]).toEqual([7088])
  // An unrelated process whose parent id is free is not taken.
  expect(treeOf(rows, 4242).size).toBe(0)
})

test('Windows command lines are split as the C runtime quotes them', () => {
  expect(
    commandWords(
      'win32',
      '"C:\\Program Files\\fermion.exe" serve phonon-2 --unix-socket "C:\\Users\\Ana Lima\\.myrmidon\\voice\\phonon.sock"',
    ),
  ).toEqual([
    'C:\\Program Files\\fermion.exe',
    'serve',
    'phonon-2',
    '--unix-socket',
    'C:\\Users\\Ana Lima\\.myrmidon\\voice\\phonon.sock',
  ])
  expect(commandWords('win32', 'x.exe "a \\"b\\"" c\\\\d "e\\\\" ""')).toEqual([
    'x.exe',
    'a "b"',
    'c\\\\d',
    'e\\',
    '',
  ])
  expect(commandWords('darwin', '  /opt/fermion serve  phonon-2 ')).toEqual([
    '/opt/fermion',
    'serve',
    'phonon-2',
  ])
})

test("a leftover Phonon server is found on Windows by its socket, a path with spaces, and no other's", () => {
  const socket = 'C:\\Users\\Ana Lima\\.myrmidon\\voice\\phonon.sock'
  const rows = [
    { pid: 31, ppid: 1, command: `"C:\\Tools\\fermion.exe" serve phonon-2 --unix-socket "${socket}"` },
    {
      pid: 32,
      ppid: 1,
      command: `C:\\Tools\\fermion.exe serve phonon-2 --unix-socket C:\\other\\phonon.sock`,
    },
    { pid: 33, ppid: 1, command: `notepad.exe "${socket}"` },
  ]
  expect(phononServers(rows, socket, 'win32')).toEqual([31])
})

// POSIX commands and signals stand in for Windows here.
test.skipIf(process.platform === 'win32')(
  "on Windows killing a leash ends its stdin instead, so the leash still stops the command's tree",
  async () => {
    // The macOS leash stands in: what is checked is that kill() reaches it as the end of stdin, not as a signal.
    const proc = stopsByStdin(
      spawnLeashed(['sh', '-c', 'trap "" TERM; sleep 600'], { stdout: 'ignore' }),
      'win32',
    )
    await Bun.sleep(300)
    proc.kill()
    await proc.exited
    // Ended by the sweep after the grace (the command ignores SIGTERM), not by the signal kill() would have sent.
    expect(proc.signalCode).toBe('SIGKILL')
    // Elsewhere kill() is Bun's own.
    const other = spawnLeashed(['sleep', '600'], { stdout: 'ignore' })
    other.kill('SIGTERM')
    await other.exited
    expect(other.signalCode).toBe('SIGTERM')
  },
)
