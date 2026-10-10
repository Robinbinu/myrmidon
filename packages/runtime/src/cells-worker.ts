/**
 * The JavaScript cell runtime (see cells.ts): omp's WorkerCore and JsRuntime, run as a process of their own in the
 * agent's sandbox and spoken to in NDJSON over stdin and stdout, since omp's own transports (worker threads, Bun IPC)
 * do not cross the sandbox's wrapper and the leash. Nothing here is trusted by Myrmidon: it is the agent's code.
 *
 * Frames out start with the marker the parent passed in MYR_CELL_FRAME, so what a cell writes to stdout itself
 * (process.stdout, `Bun.$`, a child process) reads as its output rather than as a frame. stdin reaching its end
 * means the parent has gone: the runtime exits with it.
 */
import { WorkerCore, type WorkerInbound, type WorkerOutbound } from './omp/eval-worker.ts'

const marker = process.env.MYR_CELL_FRAME ?? ''
// Cells and what they start never see it.
delete process.env.MYR_CELL_FRAME

const handlers = new Set<(message: WorkerInbound) => void>()
// JsRuntime routes process.stdout.write into the running cell's output; frames must bypass that, or each would be
// sent as output of its own, without end.
const write = process.stdout.write.bind(process.stdout)

new WorkerCore(
  {
    send: (message: WorkerOutbound) => {
      write(`${marker}${JSON.stringify(message)}\n`)
    },
    onMessage: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close: () => setTimeout(() => process.exit(0), 0),
  },
  { mode: 'isolated', chdir: (cwd) => process.chdir(cwd) },
)

let pending = ''
const decoder = new TextDecoder()
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true })
  for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
    const line = pending.slice(0, at)
    pending = pending.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line) as WorkerInbound
    for (const handler of handlers) handler(message)
  }
}
process.exit(0)
