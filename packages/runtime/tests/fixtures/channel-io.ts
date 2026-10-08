import { tmpdir } from 'node:os'
import type { AdapterIO, AdapterStatus, Inbound } from '../../src/channels/index.ts'

/** What a running adapter is given by the hub, recording what it hands back. */
export function fakeIO(extra: Partial<AdapterIO> = {}) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const logs: string[] = []
  const kv = new Map<string, string>()
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    status: (s) => statuses.push(s),
    log: (m) => logs.push(m),
    dir: tmpdir(),
    ...extra,
  }
  return { handle, received, statuses, logs, kv }
}

export async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}
