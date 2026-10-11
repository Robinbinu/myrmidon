/**
 * `bun test --parallel` with a wall clock. A test that spins without yielding never reaches its own timeout and holds
 * the whole run (a parallel run takes about 2 minutes); past TEST_WALL_S this stops it, workers included, instead of
 * leaving it to spin. Arguments go through to `bun test` (`--changed`, paths, `-t` …).
 */
const WALL_S = Number(process.env.TEST_WALL_S ?? 600)

const run = Bun.spawn(
  [
    process.execPath,
    'test',
    '--parallel',
    '--timeout',
    '30000',
    // Workers die with this run, so a stopped run leaves nothing spinning (Linux and macOS only).
    ...(process.platform === 'win32' ? [] : ['--no-orphans']),
    ...process.argv.slice(2),
  ],
  { cwd: `${import.meta.dir}/..`, stdout: 'inherit', stderr: 'inherit' },
)
const wall = setTimeout(() => {
  console.error(
    `\ntests: still running after ${WALL_S}s (a run takes about 2 minutes), so stopped: a test is stuck. ` +
      'Narrow it down with `bun run test:serial <folder>`.',
  )
  // TERM lets the runner take its workers down with it; KILL if it will not go.
  run.kill('SIGTERM')
  setTimeout(() => run.kill('SIGKILL'), 5_000).unref()
}, WALL_S * 1000)
const code = await run.exited
clearTimeout(wall)
process.exit(code)
