import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatService, ModelResolver, parseWav, SettingsStore, wav } from '@myrmidon/runtime'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
const others: { stop(force?: boolean): void }[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const s of others.splice(0)) s.stop(true)
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('a call over the WebSocket: the person speaks, the call model answers aloud, the transcript is kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-voice-server-'))
  homes.push(home)
  // Speech endpoints standing in for Phonon-2 and Kitten.
  const speech = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === '/v1/audio/transcriptions') return Response.json({ text: 'what time is it' })
      if (path === '/v1/audio/speech') return new Response(wav(new Int16Array(2400), 24_000))
      return new Response('no', { status: 404 })
    },
  })
  others.push(speech)
  const settings = new SettingsStore(home)
  const base = `http://127.0.0.1:${speech.port}/v1`
  settings.set({
    ...settings.get(),
    profile: { name: 'Robin', greeting: 'rules' },
    voice: {
      callModel: 'mock/voice',
      stt: { provider: 'endpoint', baseUrl: base, model: 'phonon-2' },
      tts: {
        provider: 'endpoint',
        baseUrl: base,
        model: 'kitten',
        kittenModel: 'nano',
        voice: 'Leo',
        speed: 1,
      },
      sensitivity: 'normal',
    },
  })
  const resolver = new ModelResolver()
  const model = createMockModel({ handler: () => ({ content: ['It is half past four.'] }) })
  resolver.register('mock/voice', { model: model.model, streamFn: model.stream })
  const chats = {
    list: async () => [{ chatId: 'c1', title: 'Planning', rounds: [] }],
    onEvents: () => () => {},
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats, resolver, settings })
  servers.push(server)
  const origin = new URL(server.url.replace(/#.*$/, ''))
  const auth = { authorization: `Bearer ${server.token}` }

  const status = await (await fetch(new URL('/api/voice', origin), { headers: auth })).json()
  expect(status).toMatchObject({
    callModel: 'mock/voice',
    stt: { provider: 'endpoint' },
    tts: { provider: 'endpoint' },
  })

  const ws = new WebSocket(`ws://${origin.host}/api/voice/call?chat=c1&rate=16000`, {
    headers: { origin: origin.origin, ...auth },
  } as never)
  ws.binaryType = 'arraybuffer'
  const said: string[] = []
  const heard: string[] = []
  let audioFrames = 0
  let rate = 0
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      audioFrames++
      rate = new DataView(e.data as ArrayBuffer).getUint32(0, true)
      return
    }
    const msg = JSON.parse(e.data) as { type: string; text?: string }
    if (msg.type === 'said' && msg.text) said.push(msg.text)
    if (msg.type === 'heard' && msg.text) heard.push(msg.text)
  }
  await new Promise((resolve) => {
    ws.onopen = resolve
  })
  const until = async (check: () => boolean) => {
    const end = Date.now() + 5000
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await Bun.sleep(10)
    }
  }
  await until(() => said.length === 1)
  expect(said[0]).toBe("Hi Robin, I'm listening.")
  const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(3000 * Math.sin(i / 3)))
  for (let i = 0; i < 25; i++) ws.send(loud)
  for (let i = 0; i < 50; i++) ws.send(new Int16Array(320))
  await until(() => said.includes('It is half past four.'))
  expect(heard).toEqual(['what time is it'])
  expect(audioFrames).toBe(2)
  expect(rate).toBe(24_000)

  ws.send(JSON.stringify({ type: 'hangup' }))
  await new Promise((resolve) => {
    ws.onclose = resolve
  })
  const calls = (await (await fetch(new URL('/api/chats/c1/calls', origin), { headers: auth })).json()) as {
    calls: { turns: { who: string; text: string }[] }[]
  }
  expect(calls.calls[0]?.turns.map((t) => t.who)).toEqual(['voice', 'person', 'voice'])

  // "Try it" speaks a sentence in the chosen voice.
  const sample = await fetch(new URL('/api/voice/sample', origin), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello there.' }),
  })
  expect(sample.headers.get('content-type')).toBe('audio/wav')
  expect(parseWav(new Uint8Array(await sample.arrayBuffer())).sampleRate).toBe(24_000)
})

test('calling is open to chats-only devices; installing engines, keys and samples are not', () => {
  expect(needsFull('GET', '/api/voice/call')).toBe(false)
  expect(needsFull('GET', '/api/voice')).toBe(false)
  expect(needsFull('GET', '/api/chats/c1/calls')).toBe(false)
  expect(needsFull('POST', '/api/voice/phonon/install')).toBe(true)
  expect(needsFull('POST', '/api/voice/kitten/download')).toBe(true)
  expect(needsFull('PUT', '/api/voice/keys')).toBe(true)
  expect(needsFull('POST', '/api/voice/sample')).toBe(true)
})
