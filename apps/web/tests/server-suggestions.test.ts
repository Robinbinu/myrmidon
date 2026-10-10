import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextWordModel } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function serve(suggestModel?: NextWordModel) {
  const home = mkdtempSync(join(tmpdir(), 'myr-suggest-'))
  homes.push(home)
  const server = startServer({ home, port: 0, ...(suggestModel ? { suggestModel } : {}) })
  servers.push(server)
  const at = (path: string) => new URL(path, server.url.replace(/#.*$/, ''))
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
  return { home, at, headers }
}

test('the next-word model reports itself missing, and typing never starts its download', async () => {
  const { at, headers } = serve()
  const status = await fetch(at('/api/suggestions/model'), { headers })
  expect(await status.json()).toMatchObject({ state: 'missing' })
  const next = await fetch(at('/api/suggestions/next'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'fix the ' }),
  })
  expect(next.status).toBe(200)
  expect(await next.json()).toEqual({})
  expect(await (await fetch(at('/api/suggestions/model'), { headers })).json()).toMatchObject({
    state: 'missing',
  })
})

test('a downloaded model answers with its word', async () => {
  class Downloaded extends NextWordModel {
    override get downloaded() {
      return true
    }
    override async next(text: string) {
      return text === 'thank you very ' ? 'much' : undefined
    }
  }
  const { at, headers } = serve(new Downloaded('/nowhere'))
  const ask = async (text: unknown) =>
    fetch(at('/api/suggestions/next'), { method: 'POST', headers, body: JSON.stringify({ text }) })
  expect(await (await ask('thank you very ')).json()).toEqual({ word: 'much' })
  expect(await (await ask('nothing here ')).json()).toEqual({})
  expect((await ask(3)).status).toBe(400)
})

test('downloading the model takes a full device; asking it for a word does not', () => {
  expect(needsFull('POST', '/api/suggestions/model')).toBe(true)
  expect(needsFull('GET', '/api/suggestions/model')).toBe(false)
  expect(needsFull('POST', '/api/suggestions/next')).toBe(false)
})
