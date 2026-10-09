// Stands in for the app in the server tests: starts the (fake) server the way the app does, prints `started`, then
// waits to be killed.
//   bun server-parent.ts <home>
import { join } from 'node:path'
import { freePort, startServer } from '../src/server.ts'

const home = process.argv[2]
if (!home) throw new Error('usage: server-parent.ts <home>')
await startServer({
  command: [process.execPath, join(import.meta.dir, 'fake-cli.ts')],
  home,
  port: freePort(),
  pollMs: 20,
})
console.log('started')
setInterval(() => {}, 60_000)
