/**
 * The compiled server's entry point (scripts/build-sidecar.ts): Myrmidon's CLI, and the worker processes the server
 * starts by running this same executable again, since a compiled build has no script files on disk to run them from.
 * A worker is picked before the CLI is loaded, so it does not carry the whole server.
 */
import {
  CELL_WORKER_COMMAND,
  EMBEDDED_SHELL_COMMAND,
  LEASH_COMMAND,
} from '../../../packages/runtime/src/config.ts'
import { KITTEN_WORKER_COMMAND } from '../../../packages/runtime/src/voice/tts.ts'

if (Bun.argv[2] === KITTEN_WORKER_COMMAND) {
  // The worker reads its arguments as when it is started from its file.
  process.argv.splice(2, 1)
  await import('../../../packages/runtime/src/voice/kitten-worker.ts')
} else if (Bun.argv[2] === EMBEDDED_SHELL_COMMAND) {
  process.argv.splice(2, 1)
  await import('../../../packages/runtime/src/embedded-shell.ts')
} else if (Bun.argv[2] === LEASH_COMMAND) {
  process.argv.splice(2, 1)
  const { runLeash } = await import('../../../packages/runtime/src/leash.ts')
  await runLeash()
} else if (Bun.argv[2] === CELL_WORKER_COMMAND) await import('../../../packages/runtime/src/cells-worker.ts')
else await import('../../cli/src/main.ts')
