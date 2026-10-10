import { afterEach, expect, test } from 'bun:test'
import { fetchBytes } from '../src/voice/download.ts'

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

test('a download whose server never answers fails after the quiet limit, saying so', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
  servers.push(server)
  const started = Date.now()
  const err = await fetchBytes(`http://127.0.0.1:${server.port}/model.onnx`, 'the speech detector', 200).then(
    () => undefined,
    (e: Error) => e,
  )
  expect(err?.message).toContain('the speech detector')
  expect(err?.message).toContain('stopped')
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a download that stalls partway fails too; one that flows comes back whole', async () => {
  const stall = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]))
          },
        }),
      ),
  })
  servers.push(stall)
  const err = await fetchBytes(`http://127.0.0.1:${stall.port}/x`, 'the turn model', 200).then(
    () => undefined,
    (e: Error) => e,
  )
  expect(err?.message).toContain('the turn model')
  const ok = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array([7, 8, 9])) })
  servers.push(ok)
  expect([...(await fetchBytes(`http://127.0.0.1:${ok.port}/x`, 'the turn model', 200))]).toEqual([7, 8, 9])
})
