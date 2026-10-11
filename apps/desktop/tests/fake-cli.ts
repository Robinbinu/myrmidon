/**
 * Stands in for `myrmidon serve` in the server tests: answers /api/whoami for its token, stops on
 * `POST /api/shutdown` with it (not with --no-shutdown) or on SIGTERM, noting which in `<home>/stopped-by`, and
 * keeps server.json the way the real CLI does, with its parent's pid (the leash) for the tests to follow;
 * `--delay MS` writes it that much later. With --crash it exits at once instead.
 */
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1] ?? ''
if (process.argv.includes('--crash')) {
  console.error('cannot open the chat store: disk full')
  process.exit(3)
}

const token = 'fake-token'
const file = join(arg('--home'), 'server.json')
/** Leaves `stopped-by` in the home: which way it was stopped. */
const stop = (by: 'api' | 'SIGTERM') => {
  rmSync(file, { force: true })
  writeFileSync(join(arg('--home'), 'stopped-by'), by)
  process.exit(0)
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(arg('--port')),
  fetch: (req) => {
    if (req.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 })
    if (new URL(req.url).pathname !== '/api/shutdown') return new Response(null, { status: 200 })
    if (process.argv.includes('--no-shutdown') || req.method !== 'POST')
      return new Response(null, { status: 404 })
    setTimeout(() => stop('api'), 0)
    return new Response(null, { status: 202 })
  },
})
const launch = process.env.MYRMIDON_LAUNCH_ID
await Bun.sleep(Number(arg('--delay')) || 0)
writeFileSync(
  file,
  JSON.stringify({
    url: `http://127.0.0.1:${server.port}/`,
    token,
    pid: process.pid,
    ppid: process.ppid,
    launch,
  }),
)
process.on('SIGTERM', () => stop('SIGTERM'))
