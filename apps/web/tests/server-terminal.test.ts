import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectStore } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test("the person's terminal in a project folder that is gone closes with the reason, not silently", async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-term-'))
  homes.push(home)
  const projects = {
    get: (id: string) => ({ id, name: 'gone', path: join(home, 'deleted-folder'), addedAt: '' }),
  } as unknown as ProjectStore
  const server = startServer({ home, port: 0, projects })
  servers.push(server)
  const base = new URL(server.url.replace(/#.*$/, ''))
  const url = `ws://${base.host}/api/terminal?project=p1&cols=80&rows=24`
  const ws = new WebSocket(url, {
    headers: { origin: base.origin, authorization: `Bearer ${server.token}` },
  } as never)
  const closed = await new Promise<CloseEvent>((resolve) => {
    ws.onclose = resolve
  })
  expect(closed.code).toBe(1011)
  expect(closed.reason).toContain('moved or deleted')
})

/** A terminal socket with what it has shown so far and the control messages it was sent. */
function openTerminal(server: WebServer, project: string) {
  const base = new URL(server.url.replace(/#.*$/, ''))
  const ws = new WebSocket(`ws://${base.host}/api/terminal?project=${project}&cols=80&rows=24`, {
    headers: { origin: base.origin, authorization: `Bearer ${server.token}` },
  } as never)
  ws.binaryType = 'arraybuffer'
  const seen = { text: '', controls: [] as { type: string; name?: string | null }[] }
  const decoder = new TextDecoder()
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') seen.controls.push(JSON.parse(e.data))
    else seen.text += decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true })
  }
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
  })
  const type = (data: string) => ws.send(JSON.stringify({ type: 'input', data }))
  return { ws, seen, opened, type }
}

async function until(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

test('several terminals run their own shells, and each says what runs in its foreground', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-term-'))
  homes.push(home)
  const projects = {
    get: (id: string) => ({ id, name: 'here', path: home, addedAt: '' }),
  } as unknown as ProjectStore
  const server = startServer({ home, port: 0, projects })
  servers.push(server)
  const one = openTerminal(server, 'p1')
  const two = openTerminal(server, 'p1')
  try {
    await Promise.all([one.opened, two.opened])
    // The arithmetic is done by the shell, so the typed line's echo alone never satisfies the check.
    one.type('echo first-$((20+1))\n')
    two.type('echo second-$((40+2))\n')
    await until(() => one.seen.text.includes('first-21') && two.seen.text.includes('second-42'))
    expect(one.seen.text).not.toContain('second-42')
    expect(two.seen.text).not.toContain('first-21')

    one.type('sleep 30\n')
    await until(() => one.seen.controls.some((c) => c.type === 'process' && c.name === 'sleep 30'))
    // Back at the prompt the shell is idle again: no command runs in the foreground.
    one.type('\x03')
    await until(() => one.seen.controls.at(-1)?.name === null)
    // The idle terminal never had anything to report.
    expect(two.seen.controls).toEqual([])
  } finally {
    one.ws.close()
    two.ws.close()
  }
}, 60_000)

test('more terminals than allowed at once are refused with a reason, even when asked for together', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-term-'))
  homes.push(home)
  const projects = {
    get: (id: string) => ({ id, name: 'here', path: home, addedAt: '' }),
  } as unknown as ProjectStore
  const server = startServer({ home, port: 0, projects })
  servers.push(server)
  const many = Array.from({ length: 9 }, () => openTerminal(server, 'p1'))
  const refused: CloseEvent[] = []
  for (const t of many) t.ws.addEventListener('close', (e) => refused.push(e))
  try {
    await until(() => refused.length >= 1)
    await Bun.sleep(300)
    expect(refused).toHaveLength(1)
    expect(refused[0]?.code).toBe(4429)
    expect(refused[0]?.reason).toBe('Too many terminals are open (8). Close one to open another.')
  } finally {
    for (const t of many) t.ws.close()
  }
}, 60_000)
