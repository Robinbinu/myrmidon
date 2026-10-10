import { existsSync } from 'node:fs'
import { Process, PtySession } from './omp/natives.ts'
import { hostProbe, type ShellProbe, terminalShell } from './shell.ts'

/**
 * The person's own shell behind the terminal view (not an agent's). Bun's terminal option is POSIX-only, so on
 * Windows it runs in pi-natives' PtySession, which is ConPTY there (portable-pty, as in omp).
 */
export interface PersonTerminal {
  readonly pid: number
  /** Settles once the shell has ended. */
  readonly exited: Promise<unknown>
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Ends the shell and its terminal. */
  close(): void
}

export interface PersonTerminalOptions {
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string | undefined>
  readonly onData: (chunk: Uint8Array) => void
}

/** The folder to open the shell in is gone (moved or deleted). */
export class TerminalFolderMissing extends Error {}

/** This machine cannot give a shell a terminal (on Windows, ConPTY needs Windows 10 1809 or later). */
export class TerminalUnavailable extends Error {}

export async function openPersonTerminal(
  options: PersonTerminalOptions,
  probe: ShellProbe = hostProbe(),
): Promise<PersonTerminal> {
  if (!existsSync(options.cwd)) throw new TerminalFolderMissing(options.cwd)
  const [program = '', ...args] = terminalShell(probe)
  if (probe.platform !== 'win32') {
    const proc = Bun.spawn([program, ...args], {
      cwd: options.cwd,
      env: options.env,
      terminal: { cols: options.cols, rows: options.rows, data: (_t, chunk) => options.onData(chunk) },
    })
    return {
      pid: proc.pid,
      exited: proc.exited,
      write: (data) => proc.terminal?.write(data),
      resize: (cols, rows) => proc.terminal?.resize(cols, rows),
      close: () => {
        proc.terminal?.close()
        proc.kill()
      },
    }
  }
  const session = new PtySession()
  const encoder = new TextEncoder()
  const env = Object.fromEntries(
    Object.entries(options.env).filter((e): e is [string, string] => e[1] !== undefined),
  )
  const started = Promise.withResolvers<number>()
  const exited = session
    .startArgv(
      { application: program, args, cwd: options.cwd, env, cols: options.cols, rows: options.rows },
      (err, chunk) => {
        if (!err && chunk) options.onData(encoder.encode(chunk))
      },
      (err, pid) => (err ? started.reject(err) : started.resolve(pid)),
    )
    .catch((err: unknown) => {
      started.reject(err)
    })
  const pid = await started.promise.catch((err: unknown) => {
    throw new TerminalUnavailable(err instanceof Error ? err.message : String(err))
  })
  return {
    pid,
    exited,
    // Each throws once the shell has ended, when there is nothing left to do.
    write: (data) => ignoreEnded(() => session.write(data)),
    resize: (cols, rows) => ignoreEnded(() => session.resize(cols, rows)),
    close: () => ignoreEnded(() => session.kill()),
  }
}

function ignoreEnded(act: () => void) {
  try {
    act()
  } catch {
    // The PTY is closed.
  }
}

/** The command lines of a process's children, in the order the OS lists them; none once it has gone. */
export function childCommands(pid: number): string[][] {
  return (Process.fromPid(pid)?.children() ?? []).map((child) => child.args())
}
