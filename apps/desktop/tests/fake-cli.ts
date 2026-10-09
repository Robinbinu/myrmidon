/**
 * Stands in for `myrmidon serve` in the server tests: answers /api/whoami for its token and keeps server.json the
 * way the real CLI does. With --crash it exits at once instead.
 */
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1] ?? ''
if (process.argv.includes('--crash')) process.exit(3)

const token = 'fake-token'
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(arg('--port')),
  fetch: (req) =>
    new Response(null, { status: req.headers.get('authorization') === `Bearer ${token}` ? 200 : 401 }),
})
const file = join(arg('--home'), 'server.json')
writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${server.port}/`, token, pid: process.pid }))
process.on('SIGTERM', () => {
  rmSync(file, { force: true })
  process.exit(0)
})
