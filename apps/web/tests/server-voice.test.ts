import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ChatService,
  ModelResolver,
  parseWav,
  SettingsStore,
  SileroVad,
  SmartTurn,
  wav,
} from '@myrmidon/runtime'
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
      enabled: true,
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
  // Models whose download fails at once: turns are then found by level, and the test stays offline.
  const voiceModels = {
    vad: new SileroVad(home, `${base}/no-model.onnx`),
    turn: new SmartTurn(home, `${base}/no-model.onnx`),
  }
  const server = startServer({ home, port: 0, chats, resolver, settings, voiceModels })
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

/** A gateway with voice on (unless `enabled` is false), speech endpoints standing in for the engines, and chat c1. */
function gateway(o: { enabled?: boolean; slowModels?: Promise<void> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'myr-voice-server-'))
  homes.push(home)
  const spoken: string[] = []
  const speech = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === '/v1/audio/transcriptions') return Response.json({ text: 'hello' })
      if (path === '/v1/audio/speech') {
        spoken.push(((await req.json()) as { input: string }).input)
        return new Response(wav(new Int16Array(2400), 24_000))
      }
      // The speech detector and turn model: never here, after a while when the test says so.
      if (o.slowModels) await o.slowModels
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
      enabled: o.enabled ?? true,
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
  const model = createMockModel({ handler: () => ({ content: ['Okay.'] }) })
  resolver.register('mock/voice', { model: model.model, streamFn: model.stream })
  const chats = {
    list: async () => [{ chatId: 'c1', title: 'Planning', rounds: [], crew: [{ name: 'ana' }] }],
    onEvents: () => () => {},
    onStream: () => () => {},
  } as unknown as ChatService
  const voiceModels = {
    vad: new SileroVad(home, `${base}/no-model.onnx`),
    turn: new SmartTurn(home, `${base}/no-model.onnx`),
  }
  const server = startServer({ home, port: 0, chats, resolver, settings, voiceModels })
  servers.push(server)
  const origin = new URL(server.url.replace(/#.*$/, ''))
  const auth = { authorization: `Bearer ${server.token}` }
  /** Opens a call; resolves once open, keeping every message and how it closed. */
  const call = async (query: string, headers: Record<string, string> = auth) => {
    const ws = new WebSocket(`ws://${origin.host}/api/voice/call?${query}`, {
      headers: { origin: origin.origin, ...headers },
    } as never)
    ws.binaryType = 'arraybuffer'
    const messages: { type: string; [k: string]: unknown }[] = []
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })
    })
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') messages.push(JSON.parse(e.data))
    }
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = reject
    })
    return { ws, messages, closed }
  }
  return { call, spoken }
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

test('a call first says who it reached: a member not in the crew gets the call assistant', async () => {
  const { call } = gateway()
  const direct = await call('chat=c1&talk=ana')
  await until(() => direct.messages.some((m) => m.type === 'hello'))
  expect(direct.messages.find((m) => m.type === 'hello')).toEqual({
    type: 'hello',
    talk: 'ana',
    chatId: 'c1',
    chatTitle: 'Planning',
  })
  await until(() => direct.messages.some((m) => m.type === 'said'))
  expect(direct.messages.find((m) => m.type === 'said')).toMatchObject({ from: 'ana' })
  direct.ws.close()
  await direct.closed
  const stranger = await call('chat=c1&talk=nobody')
  await until(() => stranger.messages.some((m) => m.type === 'hello'))
  expect(stranger.messages.find((m) => m.type === 'hello')).toMatchObject({ talk: 'assistant' })
  stranger.ws.close()
})

test('a refused call opens and closes with a code and a reason the page can show', async () => {
  const { call } = gateway()
  const unsigned = await call('chat=c1', {})
  expect(await unsigned.closed).toEqual({ code: 4401, reason: 'not signed in' })

  const first = await call('chat=c1')
  await until(() => first.messages.some((m) => m.type === 'hello'))
  const second = await call('chat=c1')
  expect((await second.closed).code).toBe(4423)
  first.ws.close()
  await first.closed

  const off = gateway({ enabled: false })
  const refused = await off.call('chat=c1')
  const { code, reason } = await refused.closed
  expect(code).toBe(4409)
  expect(reason).toContain('voice calls are off')
})

test('a call whose page closes while the engines warm up is never made', async () => {
  let release: () => void = () => {}
  const slowModels = new Promise<void>((resolve) => {
    release = resolve
  })
  const { call, spoken } = gateway({ slowModels })
  const early = await call('chat=c1')
  await until(() => early.messages.some((m) => m.state === 'preparing'))
  early.ws.close()
  await early.closed
  release()
  // The next call in the chat is not refused as a second one, and only it greets.
  const next = await call('chat=c1')
  await until(() => next.messages.some((m) => m.type === 'said'))
  expect(spoken).toHaveLength(1)
  next.ws.close()
})

test('odd frames and broken messages do not break a call; oversized ones close it', async () => {
  const { call } = gateway()
  const c = await call('chat=c1')
  await until(() => c.messages.some((m) => m.type === 'said'))
  c.ws.send(new Uint8Array(641))
  c.ws.send('not json')
  c.ws.send('null')
  await until(() => c.messages.some((m) => m.type === 'error'))
  expect(c.messages.find((m) => m.type === 'error')).toEqual({
    type: 'error',
    message: 'a call message must be JSON',
  })
  c.ws.send(JSON.stringify({ type: 'mute', muted: true }))
  await until(() => c.messages.some((m) => m.state === 'muted'))
  c.ws.send(new Uint8Array(200_000))
  expect((await c.closed).code).toBe(1009)
})

test("deleting a chat deletes its calls' transcripts", async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-voice-server-'))
  homes.push(home)
  const settings = new SettingsStore(home)
  const chats = {
    list: async () => [],
    onEvents: () => () => {},
    onStream: () => () => {},
    delete: async (chatId: string) => (chatId === 'c1' ? ['col-1'] : []),
  } as unknown as ChatService
  const offline = 'http://127.0.0.1:9/no-model.onnx'
  const voiceModels = { vad: new SileroVad(home, offline), turn: new SmartTurn(home, offline) }
  const server = startServer({ home, port: 0, chats, resolver: new ModelResolver(), settings, voiceModels })
  servers.push(server)
  const origin = new URL(server.url.replace(/#.*$/, ''))
  const auth = { authorization: `Bearer ${server.token}` }
  mkdirSync(join(home, 'calls'), { recursive: true })
  const saved = (id: string, chatId: string) =>
    writeFileSync(
      join(home, 'calls', `${id}.json`),
      JSON.stringify({
        id,
        chatId,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        turns: [],
        rounds: [],
      }),
    )
  saved('a', 'c1')
  saved('b', 'c2')
  const res = await fetch(new URL('/api/chats/c1', origin), { method: 'DELETE', headers: auth })
  expect(res.status).toBe(200)
  expect(readdirSync(join(home, 'calls'))).toEqual(['b.json'])
})

test('the phone line’s hooks refuse what Twilio did not sign, and calling out needs full access', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-voice-server-'))
  homes.push(home)
  const settings = new SettingsStore(home)
  const chats = {
    list: async () => [],
    onEvents: () => () => {},
    onStream: () => () => {},
  } as unknown as ChatService
  const offline = 'http://127.0.0.1:9/no-model.onnx'
  const voiceModels = { vad: new SileroVad(home, offline), turn: new SmartTurn(home, offline) }
  const server = startServer({ home, port: 0, chats, resolver: new ModelResolver(), settings, voiceModels })
  servers.push(server)
  const origin = new URL(server.url.replace(/#.*$/, ''))
  const auth = { authorization: `Bearer ${server.token}` }
  const status = await (await fetch(new URL('/api/voice', origin), { headers: auth })).json()
  expect(status.phone).toEqual({ state: 'off' })
  // No SMS channel, no public address: nothing Twilio could have signed.
  const hook = await fetch(new URL('/hooks/channels/sms/voice', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' },
    body: 'From=%2B15550002222&Direction=inbound',
  })
  expect(hook.status).toBe(403)
  expect((await fetch(new URL('/hooks/channels/sms/stream', origin))).status).toBe(400)
  const stream = await fetch(new URL('/hooks/channels/sms/stream', origin), {
    headers: {
      upgrade: 'websocket',
      connection: 'upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  })
  expect(stream.status).toBe(403)
  const dial = await fetch(new URL('/api/voice/phone/call', origin), {
    method: 'POST',
    headers: auth,
    body: '{}',
  })
  expect(dial.status).toBe(400)
  expect(needsFull('POST', '/api/voice/phone/call')).toBe(true)
})
