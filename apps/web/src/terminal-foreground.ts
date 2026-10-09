/** The longest command line a terminal's tab is given; the tab cuts it shorter still. */
const MAX_LABEL = 120
/** How long one `ps` may take before the look-up gives up until the next one. */
const PS_TIMEOUT_MS = 2_000

async function ps(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(['ps', ...args], { stdout: 'pipe', stderr: 'ignore', timeout: PS_TIMEOUT_MS })
    return (await new Response(proc.stdout).text()).trim()
  } catch {
    // No `ps` here (Windows): the tab keeps showing the folder.
    return ''
  }
}

/** A command line as a tab shows it: the program's file name rather than its whole path, then its arguments. */
export function commandLabel(args: string): string {
  const [program = '', ...rest] = args.trim().split(/\s+/)
  return [program.split('/').pop(), ...rest].join(' ').slice(0, MAX_LABEL)
}

/**
 * What runs in the foreground of the terminal whose shell is `shellPid`: the command line of the terminal's
 * foreground process group, or null while the shell waits at its prompt; undefined when it cannot be told. `ps`
 * reports the group as TPGID (what tcgetpgrp answers for the shell's terminal) on macOS and Linux alike, so this
 * needs no native module.
 */
export async function foregroundCommand(shellPid: number): Promise<string | null | undefined> {
  const group = Number(await ps(['-o', 'tpgid=', '-p', String(shellPid)]))
  if (!Number.isInteger(group) || group <= 0) return undefined
  if (group === shellPid) return null
  // The group's leader is the command typed (in a pipeline, its first program).
  const args = await ps(['-o', 'args=', '-p', String(group)])
  return args ? commandLabel(args) : undefined
}
