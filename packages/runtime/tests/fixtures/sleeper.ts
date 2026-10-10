// A long sleep for children.test.ts, the same on every OS (Windows has no sh, sleep or trap to build one from):
//   bun sleeper.ts [--ignore-term] [--children=N] [--orphan]
// --ignore-term: SIGTERM does not stop it, only SIGKILL does (Windows has no SIGTERM to ignore).
// --children=N: starts N plain sleepers and sleeps with them.
// --orphan: starts one plain sleeper, prints its pid and exits, leaving it running.

/** The program and arguments that run a sleeper. */
export function sleeper(...flags: string[]): string[] {
  return [process.execPath, import.meta.path, ...flags]
}

/**
 * What a dev server runs in these tests: two sleeps in the background of the shell. macOS's and Linux's sandboxes
 * hide this repository from the command, so there they are the shell's own `sleep`; Windows confines only the
 * environment, so there Bun runs the sleeper by its full path, in forward slashes for Git Bash.
 */
export function twoSleeps(): string {
  if (process.platform !== 'win32') return 'sleep 600 & sleep 600'
  const one = sleeper()
    .map((a) => `'${a.replaceAll('\\', '/')}'`)
    .join(' ')
  return `${one} & ${one}`
}

if (import.meta.main) {
  const flags = process.argv.slice(2)
  if (flags.includes('--ignore-term')) process.on('SIGTERM', () => {})
  // Not detached: on macOS and Linux it stays in this one's process group, where the leash finds it once orphaned.
  const start = () => Bun.spawn(sleeper(), { stdio: ['ignore', 'ignore', 'ignore'] })
  if (flags.includes('--orphan')) {
    const child = start()
    child.unref()
    console.log(child.pid)
  } else {
    const n = Number(flags.find((f) => f.startsWith('--children='))?.slice('--children='.length) ?? 0)
    for (let i = 0; i < n; i++) start()
    setInterval(() => {}, 1 << 30)
  }
}
