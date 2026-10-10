/**
 * The bash Myrmidon carries for Windows without Git Bash (see shell.ts): omp's brush shell, whose coreutils (ls, cat,
 * grep, sed, find…) run inside it, so commands need nothing installed. Started as `bun embedded-shell.ts <command>`,
 * in a process of its own rather than in Myrmidon: a fault in the native shell ends only this command, and the leash,
 * the timeouts and the output cap stop and trim it as they do any other shell. It exits with the command's code;
 * SIGTERM or SIGINT cancels the command first.
 *
 * brush takes no stdin from its host and streams stdout and stderr as one, so the command runs with its stdin and
 * stderr redirected to files: what this process is given on stdin (a hook's JSON) is read to its end first, and what
 * the command wrote to stderr is passed on once it ends. Every caller gives a stdin that ends (a hook's input, or none).
 *
 * In process means outside any OS sandbox: only where commands run unconfined anyway (Windows has no sandbox yet).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeShell } from './omp/natives.ts'

const command = process.argv[2]
if (command === undefined) {
  console.error('usage: embedded-shell.ts <command>')
  process.exit(2)
}

const stop = new AbortController()
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stop.abort())

const dir = mkdtempSync(join(tmpdir(), 'myr-sh-'))
const stdin = join(dir, 'stdin')
const stderr = join(dir, 'stderr')
writeFileSync(stdin, new Uint8Array(await Bun.stdin.arrayBuffer()))
// Single quotes keep a path's backslashes (Windows') as they are; a temp path has no single quote in it.
const wrapped = `{\n${command}\n} <'${stdin}' 2>'${stderr}'`

/** Resolves once what was written to `stream` so far has gone out (a file or a pipe alike). */
const flushed = (stream: NodeJS.WriteStream) => new Promise<void>((done) => stream.write('', () => done()))

let code: number
try {
  const result = await executeShell(
    { command: wrapped, cwd: process.cwd(), signal: stop.signal },
    (err, chunk) => {
      if (!err) process.stdout.write(chunk)
    },
  )
  // 130 is what a shell exits with when interrupted.
  code = result.exitCode ?? (result.cancelled ? 130 : 1)
  // Absent when the command did not parse: brush reports that on stdout.
  if (existsSync(stderr)) process.stderr.write(readFileSync(stderr))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
await Promise.all([flushed(process.stdout), flushed(process.stderr)])
process.exit(code)
