// Stands in for `fermion serve phonon-2 --unix-socket <path>` in children.test.ts: answers /health on the socket, and
// starts a process of its own, as a real server's workers would be.
const socket = process.argv[process.argv.indexOf('--unix-socket') + 1]
if (!socket) process.exit(2)
Bun.serve({ unix: socket, fetch: () => new Response('ok') })
Bun.spawn(['sleep', '600'], { stdout: 'ignore', stderr: 'ignore' })
