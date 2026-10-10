import { afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { parseWav, wav } from '../src/voice/audio.ts'
import { AssemblyAiStt } from '../src/voice/cloud/assemblyai.ts'
import {
  awsCredentials,
  decodeEvent,
  encodeEvent,
  pollyTts,
  signRequest,
  transcribeProtocol,
} from '../src/voice/cloud/aws.ts'
import { AzureStt, azureTts } from '../src/voice/cloud/azure.ts'
import { CARTESIA_VERSION, CartesiaStt, cartesiaTts } from '../src/voice/cloud/cartesia.ts'
import { PcmBytes } from '../src/voice/cloud/common.ts'
import { DeepgramStt, deepgramTts } from '../src/voice/cloud/deepgram.ts'
import { ElevenLabsStt, elevenLabsTts, elevenLabsVoices } from '../src/voice/cloud/elevenlabs.ts'
import { fishTts } from '../src/voice/cloud/fish.ts'
import { GoogleStt, googleTts } from '../src/voice/cloud/google.ts'
import { groqStt, openAiStt, openAiTts } from '../src/voice/cloud/openai.ts'
import { rimeTts } from '../src/voice/cloud/rime.ts'
import { speechmaticsStt } from '../src/voice/cloud/speechmatics.ts'
import { ENDPOINT_DEFAULTS, VOICE_PROVIDERS, voiceProvider } from '../src/voice/providers.ts'

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

const RATE = 16_000
/** A tenth of a second of a tone: speech enough for a stand-in. */
const tone = (n = 1600) => Int16Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin(i / 5)))
const bytes = (pcm: Int16Array) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(5)
  }
}

interface Seen {
  url: URL
  headers: Headers
  text: string[]
  binary: Uint8Array[]
}

/** A WebSocket stand-in for a provider: what it was sent, and `reply` to answer each message. */
function wsServer(reply: (ws: ServerWebSocket<unknown>, message: string | Uint8Array, seen: Seen) => void) {
  const seen: Seen = { url: new URL('http://x'), headers: new Headers(), text: [], binary: [] }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      seen.url = new URL(req.url)
      seen.headers = req.headers
      if (srv.upgrade(req, { data: undefined })) return undefined
      return new Response('no', { status: 400 })
    },
    websocket: {
      message(ws, message) {
        const m = typeof message === 'string' ? message : new Uint8Array(message)
        if (typeof m === 'string') seen.text.push(m)
        else seen.binary.push(m)
        reply(ws, m, seen)
      },
    },
  })
  servers.push(server)
  return { ws: `ws://127.0.0.1:${server.port}`, seen }
}

interface HttpSeen {
  url: URL
  method: string
  headers: Headers
  body: Uint8Array
}

/** An HTTP stand-in: what it was asked, and `answer` for the response. */
function httpServer(answer: (seen: HttpSeen) => Response | Promise<Response>) {
  const seen: HttpSeen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const s = {
        url: new URL(req.url),
        method: req.method,
        headers: req.headers,
        body: new Uint8Array(await req.arrayBuffer()),
      }
      seen.push(s)
      return answer(s)
    },
  })
  servers.push(server)
  return { api: `http://127.0.0.1:${server.port}`, seen }
}

/**
 * Raw PCM sent back in parts that split samples (an odd number of bytes) and come a moment apart, as a provider's
 * stream does.
 */
function pcmResponse(pcm: Int16Array, part = 1333): Response {
  const all = bytes(pcm)
  let at = 0
  return new Response(
    new ReadableStream({
      async pull(c) {
        if (at >= all.length) return c.close()
        await Bun.sleep(3)
        c.enqueue(all.slice(at, at + part))
        at += part
      },
    }),
    { headers: { 'content-type': 'audio/pcm' } },
  )
}

test('raw PCM split mid-sample is put back together', () => {
  const pcm = Int16Array.from([1, -2, 300, -32768, 32767])
  const b = new PcmBytes()
  const all = bytes(pcm)
  const out = [...b.push(all.subarray(0, 3)), ...b.push(all.subarray(3, 7)), ...b.push(all.subarray(7))]
  expect(out).toEqual([1, -2, 300, -32768, 32767])
})

test('every provider is on the one interface, with models, voices and a key home', () => {
  expect(VOICE_PROVIDERS.map((p) => p.id)).toEqual([
    'deepgram',
    'elevenlabs',
    'cartesia',
    'assemblyai',
    'openai',
    'gemini',
    'groq',
    'google-cloud',
    'azure',
    'aws',
    'speechmatics',
    'rime',
    'fish-audio',
  ])
  for (const p of VOICE_PROVIDERS) {
    expect(p.stt || p.tts || p.realtime).toBeTruthy()
    for (const kind of [p.stt, p.tts, p.realtime]) if (kind) expect(kind.models.length).toBeGreaterThan(0)
    if (p.tts) expect(p.tts.voices.length).toBeGreaterThan(0)
    if (p.realtime) expect(p.realtime.voices.length).toBeGreaterThan(0)
    expect(p.keysUrl).toStartWith('https://')
  }
  // The providers whose API takes a model provider's key read that one.
  expect(voiceProvider('openai')?.key).toEqual({ vault: 'openai', sharedWith: 'openai' })
  expect(voiceProvider('groq')?.key.vault).toBe('groq')
  expect(voiceProvider('gemini')?.key.vault).toBe('google')
  expect(voiceProvider('azure')?.region?.required).toBe(true)
  expect(ENDPOINT_DEFAULTS.stt).toBe('whisper-1')
})

test("Deepgram streams a turn's words with its key in the header, and finalizes when the turn ends", async () => {
  const { ws, seen } = wsServer((socket, m) => {
    if (typeof m !== 'string') {
      if (seen.binary.length === 1)
        socket.send(
          JSON.stringify({
            type: 'Results',
            is_final: false,
            channel: { alternatives: [{ transcript: 'hello' }] },
          }),
        )
      return
    }
    if (JSON.parse(m).type === 'Finalize')
      socket.send(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          from_finalize: true,
          channel: { alternatives: [{ transcript: 'hello there' }] },
        }),
      )
  })
  const heard: string[] = []
  const stt = new DeepgramStt({ key: 'dg-key', model: 'nova-3', ws })
  const live = stt.listen(RATE, (t) => heard.push(t), { hotwords: ['Quillon'] })
  live.push(tone())
  await until(() => heard.length > 0)
  expect(await live.finish?.()).toBe('hello there')
  expect(seen.headers.get('authorization')).toBe('Token dg-key')
  const q = seen.url.searchParams
  expect([q.get('model'), q.get('encoding'), q.get('sample_rate'), q.get('interim_results')]).toEqual([
    'nova-3',
    'linear16',
    '16000',
    'true',
  ])
  expect(q.getAll('keyterm')).toEqual(['Quillon'])
  // Raw PCM as binary frames, the Finalize as text.
  expect(seen.binary[0]?.length).toBe(3200)
  expect(seen.text.map((t) => JSON.parse(t).type)).toContain('Finalize')
  expect(heard).toEqual(['hello', 'hello there'])
})

test("Deepgram's batch upload and Aura's streamed speech", async () => {
  const voice = tone(9600)
  const { api, seen } = httpServer((s) =>
    s.url.pathname === '/v1/listen'
      ? Response.json({ results: { channels: [{ alternatives: [{ transcript: ' what time is it ' }] }] } })
      : pcmResponse(voice),
  )
  const stt = new DeepgramStt({ key: 'dg-key', model: 'nova-3', api })
  expect(await stt.transcribe(tone(), RATE)).toBe('what time is it')
  expect(seen[0]?.headers.get('content-type')).toBe('audio/wav')
  expect(parseWav(seen[0]?.body ?? new Uint8Array()).sampleRate).toBe(RATE)
  const tts = deepgramTts({ key: 'dg-key', voice: 'aura-2-thalia-en', speed: 1.2, api })
  const pieces: Int16Array[] = []
  for await (const piece of tts.stream(`Hi.`)) {
    expect(piece.sampleRate).toBe(24_000)
    pieces.push(piece.pcm)
  }
  expect(pieces.length).toBeGreaterThan(1)
  expect(Int16Array.from(pieces.flatMap((p) => [...p]))).toEqual(voice)
  const speak = seen[1]
  expect(speak?.url.pathname).toBe('/v1/speak')
  expect(Object.fromEntries(speak?.url.searchParams ?? [])).toEqual({
    model: 'aura-2-thalia-en',
    encoding: 'linear16',
    container: 'none',
    sample_rate: '24000',
    speed: '1.2',
  })
  expect(speak?.headers.get('authorization')).toBe('Token dg-key')
  expect(JSON.parse(new TextDecoder().decode(speak?.body))).toEqual({ text: 'Hi.' })
})

test('a provider that refuses the stream fails the turn, so it can be transcribed another way', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('bad key', { status: 401 }),
  })
  servers.push(server)
  const stt = new DeepgramStt({ key: 'wrong', model: 'nova-3', ws: `ws://127.0.0.1:${server.port}` })
  const live = stt.listen(RATE, () => {})
  live.push(tone())
  await expect(live.finish?.() ?? Promise.resolve('')).rejects.toThrow('Deepgram')
})

test('ElevenLabs Scribe streams base64 audio in JSON and commits by hand; its voices stream as PCM', async () => {
  const { ws, seen } = wsServer((socket, m) => {
    if (typeof m !== 'string') return
    const msg = JSON.parse(m)
    if (msg.commit)
      socket.send(JSON.stringify({ message_type: 'committed_transcript', text: 'book a table' }))
    else socket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'book a' }))
  })
  const heard: string[] = []
  const live = new ElevenLabsStt({ key: 'xi-key', model: 'scribe_v2', ws }).listen(RATE, (t) => heard.push(t))
  live.push(tone())
  await until(() => heard.length > 0)
  expect(await live.finish?.()).toBe('book a table')
  expect(seen.headers.get('xi-api-key')).toBe('xi-key')
  expect(Object.fromEntries(seen.url.searchParams)).toMatchObject({
    model_id: 'scribe_v2_realtime',
    audio_format: 'pcm_16000',
    commit_strategy: 'manual',
    language_code: 'en',
  })
  const first = JSON.parse(seen.text[0] ?? '{}')
  expect(first).toMatchObject({ message_type: 'input_audio_chunk', commit: false, sample_rate: RATE })
  expect(Buffer.from(first.audio_base_64, 'base64').length).toBe(3200)

  const voice = tone(2400)
  const { api, seen: asked } = httpServer((s) =>
    s.url.pathname === '/v2/voices'
      ? Response.json({ voices: [{ voice_id: 'v1', name: 'Rachel' }] })
      : pcmResponse(voice),
  )
  const tts = elevenLabsTts({ key: 'xi-key', model: 'eleven_flash_v2_5', voice: 'v1', api })
  expect((await tts.speak('Hello.')).pcm).toEqual(voice)
  expect(asked[0]?.url.pathname).toBe('/v1/text-to-speech/v1/stream')
  expect(asked[0]?.url.searchParams.get('output_format')).toBe('pcm_24000')
  expect(JSON.parse(new TextDecoder().decode(asked[0]?.body))).toEqual({
    text: 'Hello.',
    model_id: 'eleven_flash_v2_5',
  })
  expect(await elevenLabsVoices({ key: 'xi-key', api })).toEqual([{ id: 'v1', label: 'Rachel' }])
  expect(asked[1]?.headers.get('xi-api-key')).toBe('xi-key')
})

test("Cartesia's Ink takes a plain finalize word and its final pieces are joined as sent", async () => {
  const { ws, seen } = wsServer((socket, m) => {
    if (m !== 'finalize') return
    // A word can be split across pieces: they are joined as sent.
    socket.send(JSON.stringify({ type: 'transcript', is_final: true, text: 'Hel' }))
    socket.send(JSON.stringify({ type: 'transcript', is_final: true, text: 'lo there.' }))
    socket.send(JSON.stringify({ type: 'flush_done' }))
  })
  const live = new CartesiaStt({ key: 'sk_car', model: 'ink-whisper', ws }).listen(RATE, () => {})
  live.push(tone())
  expect(await live.finish?.()).toBe('Hello there.')
  expect(seen.headers.get('x-api-key')).toBe('sk_car')
  expect(seen.url.searchParams.get('cartesia_version')).toBe(CARTESIA_VERSION)
  expect(seen.url.searchParams.get('encoding')).toBe('pcm_s16le')

  const { api, seen: asked } = httpServer(() => pcmResponse(tone(480)))
  await cartesiaTts({ key: 'sk_car', model: 'sonic-3.6', voice: 'katie', speed: 1.3, api }).speak('Hi!')
  expect(asked[0]?.url.pathname).toBe('/tts/bytes')
  expect(asked[0]?.headers.get('authorization')).toBe('Bearer sk_car')
  expect(asked[0]?.headers.get('cartesia-version')).toBe(CARTESIA_VERSION)
  expect(JSON.parse(new TextDecoder().decode(asked[0]?.body))).toEqual({
    model_id: 'sonic-3.6',
    transcript: 'Hi!',
    voice: { id: 'katie' },
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24_000 },
    language: 'en',
    generation_config: { speed: 1.3 },
  })
})

test('AssemblyAI gets audio in pieces of at least 50 ms, ends the turn by force, and waits for the formatted one', async () => {
  const { ws, seen } = wsServer((socket, m) => {
    if (typeof m !== 'string') return
    if (JSON.parse(m).type !== 'ForceEndpoint') return
    socket.send(
      JSON.stringify({ type: 'Turn', end_of_turn: true, turn_is_formatted: false, transcript: 'hi robin' }),
    )
    socket.send(
      JSON.stringify({ type: 'Turn', end_of_turn: true, turn_is_formatted: true, transcript: 'Hi, Robin.' }),
    )
  })
  const live = new AssemblyAiStt({ key: 'aai', model: 'universal-3-6-pro', ws }).listen(RATE, () => {}, {
    hotwords: ['Quillon'],
  })
  // Two pieces of 32 ms (a VAD chunk each) make one message of 64 ms.
  live.push(tone(512))
  live.push(tone(512))
  live.push(tone(100))
  expect(await live.finish?.()).toBe('Hi, Robin.')
  expect(seen.headers.get('authorization')).toBe('aai')
  expect(seen.url.searchParams.get('keyterms_prompt')).toBe('["Quillon"]')
  for (const b of seen.binary) expect(b.length).toBeGreaterThanOrEqual(1600)
})

test('Speechmatics waits for its start to be taken, counts frames, and ends the stream to get the rest', async () => {
  const { ws, seen } = wsServer((socket, m) => {
    if (typeof m !== 'string') return socket.send(JSON.stringify({ message: 'AudioAdded', seq_no: 1 }))
    const msg = JSON.parse(m)
    if (msg.message === 'StartRecognition') socket.send(JSON.stringify({ message: 'RecognitionStarted' }))
    if (msg.message === 'EndOfStream') {
      socket.send(JSON.stringify({ message: 'AddTranscript', metadata: { transcript: 'Hello' } }))
      socket.send(JSON.stringify({ message: 'AddTranscript', metadata: { transcript: 'world.' } }))
      socket.send(JSON.stringify({ message: 'EndOfTranscript' }))
    }
  })
  const stt = speechmaticsStt({ key: 'sm', model: 'enhanced', ws })
  expect(await stt.transcribe(tone(), RATE)).toBe('Hello world.')
  expect(seen.headers.get('authorization')).toBe('Bearer sm')
  const start = JSON.parse(seen.text[0] ?? '{}')
  expect(start.audio_format).toEqual({ type: 'raw', encoding: 'pcm_s16le', sample_rate: RATE })
  expect(start.transcription_config).toMatchObject({
    language: 'en',
    model: 'enhanced',
    enable_partials: true,
  })
  expect(JSON.parse(seen.text.at(-1) ?? '{}')).toEqual({
    message: 'EndOfStream',
    last_seq_no: seen.binary.length,
  })
})

test('OpenAI and Groq transcribe an uploaded turn, and OpenAI speaks raw 24 kHz PCM', async () => {
  const { api, seen } = httpServer(async (s) =>
    s.url.pathname.endsWith('/audio/transcriptions')
      ? Response.json({ text: ' sure ' })
      : pcmResponse(tone(240)),
  )
  expect(
    await openAiStt({ key: 'sk', model: 'gpt-4o-mini-transcribe', api: `${api}/v1` }).transcribe(
      tone(),
      RATE,
    ),
  ).toBe('sure')
  expect(
    await groqStt({ key: 'gsk', model: 'whisper-large-v3-turbo', api: `${api}/openai/v1` }).transcribe(
      tone(),
      RATE,
    ),
  ).toBe('sure')
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk')
  expect(seen[1]?.url.pathname).toBe('/openai/v1/audio/transcriptions')
  const form = await new Response(seen[0]?.body as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': seen[0]?.headers.get('content-type') ?? '' },
  }).formData()
  expect([form.get('model'), form.get('language'), (form.get('file') as File).name]).toEqual([
    'gpt-4o-mini-transcribe',
    'en',
    'turn.wav',
  ])
  const speech = await openAiTts({
    key: 'sk',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    api: `${api}/v1`,
  }).speak('Hi.')
  expect(speech).toEqual({ pcm: tone(240), sampleRate: 24_000 })
  expect(JSON.parse(new TextDecoder().decode(seen[2]?.body))).toEqual({
    model: 'gpt-4o-mini-tts',
    input: 'Hi.',
    voice: 'marin',
    response_format: 'pcm',
  })
})

test('Google Cloud reads a turn in one request and its speech comes back as a WAV in base64', async () => {
  const { api, seen } = httpServer((s) =>
    s.url.pathname === '/v1/speech:recognize'
      ? Response.json({
          results: [
            { alternatives: [{ transcript: 'call mom' }] },
            { alternatives: [{ transcript: ' now' }] },
          ],
        })
      : Response.json({ audioContent: Buffer.from(wav(tone(480), 24_000)).toString('base64') }),
  )
  expect(await new GoogleStt({ key: 'g-key', model: 'latest_short', api }).transcribe(tone(), RATE)).toBe(
    'call mom now',
  )
  const body = JSON.parse(new TextDecoder().decode(seen[0]?.body))
  expect(body.config).toEqual({
    encoding: 'LINEAR16',
    sampleRateHertz: RATE,
    languageCode: 'en-US',
    model: 'latest_short',
    enableAutomaticPunctuation: true,
  })
  expect(Buffer.from(body.audio.content, 'base64').length).toBe(3200)
  expect(seen[0]?.headers.get('x-goog-api-key')).toBe('g-key')
  // The key never travels in the address.
  expect(seen[0]?.url.search).toBe('')
  const speech = await googleTts({ key: 'g-key', voice: 'en-GB-Chirp3-HD-Kore', api }).speak('Hi')
  expect(speech).toEqual({ pcm: tone(480), sampleRate: 24_000 })
  expect(JSON.parse(new TextDecoder().decode(seen[1]?.body)).voice).toEqual({
    languageCode: 'en-GB',
    name: 'en-GB-Chirp3-HD-Kore',
  })
})

test('Azure takes a short turn as WAV and speaks escaped SSML as raw PCM, with the resource key', async () => {
  const { api, seen } = httpServer((s) =>
    s.url.pathname.includes('/speech/recognition/')
      ? Response.json({ RecognitionStatus: 'Success', DisplayText: 'Remind me.' })
      : pcmResponse(tone(480)),
  )
  expect(await new AzureStt({ key: 'az', region: 'westeurope', api }).transcribe(tone(), RATE)).toBe(
    'Remind me.',
  )
  expect(seen[0]?.headers.get('ocp-apim-subscription-key')).toBe('az')
  expect(seen[0]?.headers.get('content-type')).toBe('audio/wav; codecs=audio/pcm; samplerate=16000')
  expect(seen[0]?.url.searchParams.get('language')).toBe('en-US')
  await azureTts({
    key: 'az',
    region: 'westeurope',
    voice: 'en-US-AvaMultilingualNeural',
    speed: 1.2,
    api,
  }).speak('Tom & <Jerry>')
  expect(seen[1]?.headers.get('x-microsoft-outputformat')).toBe('raw-24khz-16bit-mono-pcm')
  expect(seen[1]?.headers.get('user-agent')).toBe('Myrmidon')
  expect(new TextDecoder().decode(seen[1]?.body)).toContain(
    '<voice name="en-US-AvaMultilingualNeural"><prosody rate="1.2">Tom &amp; &lt;Jerry&gt;</prosody></voice>',
  )
  // Nothing said is no words, not a failure.
  const { api: quiet } = httpServer(() => Response.json({ RecognitionStatus: 'NoMatch' }))
  expect(await new AzureStt({ key: 'az', region: 'x', api: quiet }).transcribe(tone(), RATE)).toBe('')
})

test("SigV4 signs as AWS's own worked example does", () => {
  // https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (the ListUsers example).
  const headers = signRequest({
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    region: 'us-east-1',
    service: 'iam',
    method: 'GET',
    url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    now: new Date('2015-08-30T12:36:00Z'),
  })
  expect(headers.authorization).toBe(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  )
  expect(headers['x-amz-date']).toBe('20150830T123600Z')
})

test("AWS event-stream frames round-trip with their checksums, and Transcribe's partials and finals are read", () => {
  const frame = encodeEvent(
    { ':message-type': 'event', ':event-type': 'AudioEvent' },
    new Uint8Array([1, 2, 3]),
  )
  expect(decodeEvent(frame)).toEqual({
    headers: { ':message-type': 'event', ':event-type': 'AudioEvent' },
    payload: new Uint8Array([1, 2, 3]),
  })
  const broken = frame.slice()
  broken[broken.length - 6] = (broken[broken.length - 6] ?? 0) ^ 0xff
  expect(() => decodeEvent(broken)).toThrow('damaged')
  const p = transcribeProtocol(
    { key: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'S' }), region: 'us-west-2' },
    RATE,
  )
  const event = (IsPartial: boolean, Transcript: string) =>
    encodeEvent(
      { ':message-type': 'event', ':event-type': 'TranscriptEvent' },
      new TextEncoder().encode(
        JSON.stringify({ Transcript: { Results: [{ IsPartial, Alternatives: [{ Transcript }] }] } }),
      ),
    )
  expect(p.read(event(true, 'hel'))).toEqual({ partial: 'hel' })
  expect(p.read(event(false, 'Hello.'))).toEqual({ final: 'Hello.' })
  const oops = encodeEvent(
    { ':message-type': 'exception', ':exception-type': 'UnrecognizedClientException' },
    new TextEncoder().encode(JSON.stringify({ Message: 'bad key' })),
  )
  expect(p.read(oops)).toEqual({ error: 'UnrecognizedClientException: bad key' })
  // The stream's address is presigned for the host and port Transcribe listens on.
  const url = new URL(String(p.url()))
  expect(url.host).toBe('transcribestreaming.us-west-2.amazonaws.com:8443')
  expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AK\/\d{8}\/us-west-2\/transcribe\/aws4_request$/)
  expect(url.searchParams.get('media-encoding')).toBe('pcm')
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  // An empty audio event ends the stream.
  const end = p.end?.()[0]
  expect(end && typeof end !== 'string' && decodeEvent(end).payload.length).toBe(0)
  expect(() => awsCredentials('not json')).toThrow('access key id and secret')
})

test('Polly is asked for 16 kHz PCM with a signed request', async () => {
  const { api, seen } = httpServer(() => pcmResponse(tone(160)))
  const key = JSON.stringify({ accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'tok' })
  const speech = await pollyTts({ key, region: 'eu-west-1', voice: 'Joanna', engine: 'neural', api }).speak(
    'Hi',
  )
  expect(speech.sampleRate).toBe(16_000)
  expect(seen[0]?.url.pathname).toBe('/v1/speech')
  expect(seen[0]?.headers.get('authorization')).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/polly\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  )
  expect(seen[0]?.headers.get('x-amz-security-token')).toBe('tok')
  expect(JSON.parse(new TextDecoder().decode(seen[0]?.body))).toEqual({
    Engine: 'neural',
    OutputFormat: 'pcm',
    SampleRate: '16000',
    Text: 'Hi',
    TextType: 'text',
    VoiceId: 'Joanna',
  })
})

test('Rime and Fish Audio are asked for raw PCM in their own shapes', async () => {
  const { api, seen } = httpServer(() => pcmResponse(tone(240)))
  await rimeTts({ key: 'rime', model: 'coda', voice: 'astra', api }).speak('Hey.')
  expect(seen[0]?.headers.get('accept')).toBe('audio/L16')
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer rime')
  expect(JSON.parse(new TextDecoder().decode(seen[0]?.body))).toEqual({
    speaker: 'astra',
    text: 'Hey.',
    modelId: 'coda',
    lang: 'eng',
    samplingRate: 24_000,
  })
  await fishTts({ key: 'fish', model: 's2.1-pro', voice: 'ref-1', api }).speak('Hey.')
  expect(seen[1]?.headers.get('model')).toBe('s2.1-pro')
  expect(JSON.parse(new TextDecoder().decode(seen[1]?.body))).toMatchObject({
    text: 'Hey.',
    reference_id: 'ref-1',
    format: 'pcm',
    sample_rate: 24_000,
    chunk_length: 100,
  })
})

test("a provider's failure says its status and words, never the key", async () => {
  const { api } = httpServer(() => new Response('{"detail":"quota exceeded"}', { status: 429 }))
  const err = await deepgramTts({ key: 'dg-secret-key', voice: 'aura-2-thalia-en', api })
    .speak('Hi')
    .catch((e: Error) => e)
  expect(String(err)).toContain('Deepgram speech failed (429): {"detail":"quota exceeded"}')
  expect(String(err)).not.toContain('dg-secret-key')
})

test('a stream finishes with what it has when the provider never says it is done', async () => {
  const { ws } = wsServer((socket, m) => {
    if (typeof m !== 'string')
      socket.send(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: { alternatives: [{ transcript: 'yes' }] },
        }),
      )
  })
  const stt = new DeepgramStt({ key: 'k', model: 'nova-3', ws })
  const turn = stt.listen(RATE, () => {})
  turn.push(tone())
  await Bun.sleep(100)
  const started = Date.now()
  // No from_finalize: the finish waits out its time and keeps what was settled.
  expect(await turn.finish?.()).toBe('yes')
  expect(Date.now() - started).toBeGreaterThan(1000)
})
