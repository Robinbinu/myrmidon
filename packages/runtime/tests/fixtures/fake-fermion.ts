// Stands in for `fermion serve phonon-2` in children.test.ts: answers /health where it is told to listen (a Unix
// socket, or on Windows a loopback port), and starts a process of its own, as a real server's workers would be.
import { sleeper } from './sleeper.ts'

const arg = (name: string) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const socket = arg('--unix-socket')
const port = Number(arg('--port'))
const fetch = () => new Response('ok')
if (socket) Bun.serve({ unix: socket, fetch })
else if (port > 0) Bun.serve({ hostname: '127.0.0.1', port, fetch })
else process.exit(2)
Bun.spawn(sleeper(), { stdout: 'ignore', stderr: 'ignore' })
