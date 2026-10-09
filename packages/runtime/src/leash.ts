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
 * Self-contained (node builtins only): a compiled Myrmidon has no file to run, so it runs this source with `-e`
 * (see leashed.ts).
 */
import { constants } from 'node:os'

const at = process.argv.findIndex((a) => a.startsWith('--grace='))
const graceMs = Number(process.argv[at]?.slice('--grace='.length))
const rest = process.argv.slice(at + 1)
const adopted = rest[0]?.startsWith('--pid=') ? Number(rest[0].slice('--pid='.length)) : undefined
if (at < 0 || !Number.isFinite(graceMs) || (adopted === undefined ? !rest.length : !(adopted > 0))) {
  console.error('usage: leash.ts --grace=MS <command…> | --grace=MS --pid=N')
  process.exit(2)
}

// Listening before the command starts, so a stop that comes at once still reaches it.
let target = adopted
let pending: NodeJS.Signals | undefined
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(sig, () => {
    if (target) signal(target, sig)
    else pending = sig
  })

// A compiled Myrmidon runs this as Bun only with BUN_BE_BUN set; the command (maybe that same binary) must not see it.
const env = { ...process.env }
delete env.BUN_BE_BUN
// Its own session and process group, so what it starts is still found once orphaned out of the tree.
const child =
  adopted === undefined
    ? Bun.spawn(rest, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env, detached: true })
    : undefined
const top = adopted ?? child?.pid ?? 0
target = top
if (pending) signal(top, pending)

/**
 * The running processes (zombies are as good as gone), and of those the command's: it, what is below it, and what is
 * in its process group.
 */
function processes(): { running: Set<number>; tree: Set<number> } {
  const ps = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid=,pgid=,stat='], { stdout: 'pipe', stderr: 'ignore' })
  const rows = new TextDecoder()
    .decode(ps.stdout)
    .split('\n')
    .flatMap((line) => {
      const [pid, ppid, pgid, stat] = line.trim().split(/\s+/)
      return pid && ppid && pgid && !stat?.startsWith('Z')
        ? [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) }]
        : []
    })
  // From the command down, not from the leash, whose other child is this very `ps`.
  const tree = new Set(rows.filter((r) => r.pid === top || r.pgid === top).map((r) => r.pid))
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows)
      if (tree.has(r.ppid) && !tree.has(r.pid)) {
        tree.add(r.pid)
        grew = true
      }
  }
  return { running: new Set(rows.map((r) => r.pid)), tree }
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig)
  } catch {
    // Gone between the listing and the signal.
  }
}

let sweeping: Promise<void> | undefined
/**
 * Stops the tree: SIGTERM to all of it, then SIGKILL to whatever is left after the grace. A process seen once is
 * followed even after it leaves the tree, since a parent that exits first orphans its children.
 */
function sweep(): Promise<void> {
  sweeping ??= (async () => {
    const seen = new Set<number>()
    const deadline = Date.now() + graceMs
    for (;;) {
      const { running, tree } = processes()
      for (const pid of tree)
        if (!seen.has(pid)) {
          seen.add(pid)
          signal(pid, 'SIGTERM')
        }
      const left = [...seen].filter((pid) => running.has(pid))
      if (!left.length) return
      if (Date.now() >= deadline) {
        for (const pid of left) signal(pid, 'SIGKILL')
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
 * Resolves once an adopted process has gone. It is not the leash's child, so it cannot be waited on, and it may stay a
 * zombie for long (a parent restarted in place by `bun --watch` never reaps it), which counts as gone.
 */
async function gone(pid: number): Promise<void> {
  while (processes().running.has(pid)) await Bun.sleep(1000)
}

const code = child ? await child.exited : await gone(top).then(() => 0)
await sweep()
if (child?.signalCode) {
  // Ended the way the command did, so whoever waits on the leash sees the same exit.
  process.removeAllListeners(child.signalCode)
  process.kill(process.pid, child.signalCode)
}
process.exit(code ?? 128 + (constants.signals[child?.signalCode as NodeJS.Signals] ?? 0))
