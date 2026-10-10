/**
 * Keeps a command from outliving the process that started it, however that process ends (SIGKILL and crashes
 * included, which no exit handler sees). Run as `bun leash.ts --grace=MS <command…>` with stdin a pipe from the
 * parent that the parent never writes to: when the parent dies the pipe reaches EOF, and the leash stops the
 * command's whole process tree (SIGTERM, then SIGKILL to what is left after the grace).
 *
 * The command gets the leash's stdout, stderr, working directory and environment as they are, and the leash exits as
 * the command did (its code, or the signal that ended it). SIGTERM, SIGINT and SIGHUP sent to the leash go on to the
 * command. Whatever the command leaves running when it ends is stopped too.
 *
 * `bun leash.ts --grace=MS --pid=N` leashes a process already running instead (one a library started, such as
 * puppeteer's Chrome): the same, for N's tree and process group, and the leash exits once N has.
 *
 * Windows has no process groups or signals: the tree is found by parent ids alone (which Windows keeps after a parent
 * exits, so orphans are still found), and stopping a process ends it at once, so there is no grace there.
 *
 * Self-contained (node builtins only): a compiled Myrmidon has no file to run, so it runs this source with `-e`
 * (see leashed.ts). Imported, it only lends its process table.
 */
import { appendFileSync } from 'node:fs'
import { constants } from 'node:os'

/** A running process: its parent, its process group (not on Windows) and its command line. */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid?: number
  readonly command: string
}

/** Runs a program to completion and returns its stdout, or undefined when it could not run or failed. */
export type Runner = (argv: readonly string[]) => string | undefined

/** How long one listing of the processes may take. */
const LIST_MS = 15_000

const runSync: Runner = (argv) => {
  try {
    // Bounded: a listing that hangs (PowerShell can) must not keep a sweep from ever ending.
    const out = Bun.spawnSync([...argv], {
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
      timeout: LIST_MS,
    })
    return out.exitCode === 0 ? new TextDecoder().decode(out.stdout) : undefined
  } catch {
    return undefined
  }
}

/**
 * What lists every process: `ps` on macOS and Linux; on Windows, where `wmic` is gone from current releases,
 * PowerShell's CIM query as JSON (UTF-8, so command lines with non-ASCII paths survive).
 */
export function processTableArgv(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['ps', '-Ao', 'pid=,ppid=,pgid=,stat=,command=']
  return [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  ]
}

/** The running processes in `processTableArgv`'s output (zombies are as good as gone; Windows has none). */
export function parseProcessTable(platform: NodeJS.Platform, text: string): ProcessRow[] {
  if (platform !== 'win32')
    return text.split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
      if (!m || m[4]?.startsWith('Z')) return []
      return [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[5] ?? '' }]
    })
  let parsed: unknown
  try {
    // Windows PowerShell may start UTF-8 output with a byte order mark.
    parsed = JSON.parse(text.replace(/^\uFEFF/, '').trim() || '[]')
  } catch {
    return []
  }
  // ConvertTo-Json writes a lone object, not an array, when there is one row.
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => {
    const {
      ProcessId: pid,
      ParentProcessId: ppid,
      CommandLine: command,
    } = (r ?? {}) as Record<string, unknown>
    // Pid 0 is the System Idle Process, not a process to stop.
    return typeof pid === 'number' && pid > 0 && typeof ppid === 'number'
      ? [{ pid, ppid, command: typeof command === 'string' ? command : '' }]
      : []
  })
}

/** Every running process, or undefined when they cannot be listed. */
export function processTable(
  platform: NodeJS.Platform = process.platform,
  run: Runner = runSync,
): ProcessRow[] | undefined {
  const out = run(processTableArgv(platform))
  return out === undefined ? undefined : parseProcessTable(platform, out)
}

/**
 * The running processes of `top`'s tree: it, what is below it, and what is in its process group. From `top` even
 * once it has gone, since Windows keeps a gone parent's id on its children.
 */
export function treeOf(rows: readonly ProcessRow[], top: number): Set<number> {
  const tree = new Set([top, ...rows.filter((r) => r.pgid === top).map((r) => r.pid)])
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows)
      if (tree.has(r.ppid) && !tree.has(r.pid)) {
        tree.add(r.pid)
        grew = true
      }
  }
  const running = new Set(rows.map((r) => r.pid))
  return new Set([...tree].filter((pid) => running.has(pid)))
}

/** Whether a process is running (a zombie still counts): one this user may not signal is running too. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Signals a process; the error when it could not be (most often: gone between the listing and the signal). */
function signal(pid: number, sig: NodeJS.Signals): string | undefined {
  try {
    process.kill(pid, sig)
    return undefined
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? String(err)
  }
}

/**
 * MYR_LEASH_LOG names a file each sweep is written to, a JSON line per look at the tree: what was in it and how
 * signalling each went. For finding why a tree was not stopped on a given system.
 */
let logTo: string | undefined

function sweepLog(entry: object) {
  const file = process.env.MYR_LEASH_LOG ?? logTo
  if (file) appendFileSync(file, `${JSON.stringify({ leash: process.pid, at: Date.now(), ...entry })}\n`)
}

async function main() {
  const at = process.argv.findIndex((a) => a.startsWith('--grace='))
  const graceMs = Number(process.argv[at]?.slice('--grace='.length))
  const rest = process.argv.slice(at + 1)
  const adopted = rest[0]?.startsWith('--pid=') ? Number(rest[0].slice('--pid='.length)) : undefined
  if (at < 0 || !Number.isFinite(graceMs) || (adopted === undefined ? !rest.length : !(adopted > 0))) {
    console.error('usage: leash.ts --grace=MS <command…> | --grace=MS --pid=N')
    process.exit(2)
  }
  const windows = process.platform === 'win32'

  // Listening before the command starts, so a stop that comes at once still reaches it.
  let target = adopted
  let pending: NodeJS.Signals | undefined
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(sig, () => {
      if (target) signal(target, sig)
      else pending = sig
    })

  // The command's own environment, when it was given one, is Myrmidon's (the leash's) with the changes in
  // MYR_LEASH_ENV (see leashed.ts): the leash keeps Myrmidon's, as a confined command's (a trimmed PATH, a private
  // home) can keep PowerShell from listing processes.
  const env: Record<string, string | undefined> = { ...process.env }
  const given = process.env.MYR_LEASH_ENV
  if (given) {
    const { set, unset } = JSON.parse(given) as { set: Record<string, string>; unset: string[] }
    for (const name of unset) delete env[name]
    Object.assign(env, set)
  }
  // A compiled Myrmidon runs this as Bun only with BUN_BE_BUN set; the command (maybe that same binary) must not see it.
  delete env.BUN_BE_BUN
  delete env.MYR_LEASH_ENV
  logTo = env.MYR_LEASH_LOG
  // Its own session and process group, so what it starts is still found once orphaned out of the tree. Not on
  // Windows, which has no groups to gain and where a detached child gets no console, so its own children open
  // console windows.
  const child =
    adopted === undefined
      ? Bun.spawn(rest, {
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
          env,
          detached: !windows,
          windowsHide: true,
        })
      : undefined
  const top = adopted ?? child?.pid ?? 0
  target = top
  if (pending) signal(top, pending)

  let sweeping: Promise<void> | undefined
  /**
   * Stops the tree: SIGTERM to all of it, then SIGKILL to whatever is left after the grace. A process seen once is
   * followed even after it leaves the tree, since a parent that exits first orphans its children.
   */
  const sweep = (): Promise<void> => {
    sweeping ??= (async () => {
      const seen = new Set<number>()
      const deadline = Date.now() + graceMs
      for (;;) {
        // From the command down, not from the leash, whose other child is the listing itself.
        const rows = processTable()
        sweepLog({ top, listed: rows?.length })
        if (!rows) {
          // No listing (PowerShell blocked by policy, say): Windows can still end the tree below the command as it
          // stands, though not what it orphaned.
          if (windows) Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(top)], { windowsHide: true })
          return
        }
        const running = new Set(rows.map((r) => r.pid))
        const tree = treeOf(rows, top)
        const signalled: [number, string, string | undefined][] = []
        for (const pid of tree)
          if (!seen.has(pid)) {
            seen.add(pid)
            signalled.push([pid, rows.find((r) => r.pid === pid)?.command ?? '', signal(pid, 'SIGTERM')])
          }
        sweepLog({
          signalled,
          below: rows.filter((r) => tree.has(r.ppid) || r.ppid === top).map((r) => r.pid),
        })
        const left = [...seen].filter((pid) => running.has(pid))
        if (!left.length) return
        if (Date.now() >= deadline) {
          sweepLog({ killed: left.map((pid) => [pid, signal(pid, 'SIGKILL')]) })
          return
        }
        await Bun.sleep(100)
      }
    })()
    return sweeping
  }

  void (async () => {
    for await (const _ of Bun.stdin.stream()) {
      // The parent never writes: this only waits for EOF.
    }
    await sweep()
  })()

  /**
   * Resolves once an adopted process has gone. It is not the leash's child, so it cannot be waited on, and it may
   * stay a zombie for long (a parent restarted in place by `bun --watch` never reaps it), which counts as gone. On
   * Windows, which has no zombies, asking the process is far cheaper than listing every process each second.
   */
  const gone = async (pid: number): Promise<void> => {
    const running = () => (windows ? alive(pid) : (processTable() ?? []).some((r) => r.pid === pid))
    while (running()) await Bun.sleep(1000)
  }

  const code = child ? await child.exited : await gone(top).then(() => 0)
  await sweep()
  if (child?.signalCode && !windows) {
    // Ended the way the command did, so whoever waits on the leash sees the same exit.
    process.removeAllListeners(child.signalCode)
    process.kill(process.pid, child.signalCode)
  }
  process.exit(code ?? 128 + (constants.signals[child?.signalCode as NodeJS.Signals] ?? 0))
}

if (import.meta.main) await main()
