import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore } from '@myrmidon/core'
import { applyEvent, type EventDraft, emptyColonyState, type MyrEvent } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { removeTempDir } from '../../../tests/platform.ts'
import type { ColonyHost } from '../src/host.ts'
import {
  bootRuntime,
  ColonyRun,
  type GeneratedImages,
  type ImageModels,
  type ImageRequest,
  ModelResolver,
  ompMediaTools,
  onDemand,
  parseColonySpec,
  preloaded,
  SettingsStore,
  toolsFor,
  VoiceHub,
} from '../src/index.ts'
import { prompts } from '../src/prompts.ts'
import { mediaName, sniffAudio, TOOL_DEFS } from '../src/tools.ts'
import { wav } from '../src/voice/audio.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** The first bytes of a PNG and a JPEG: what the harness checks a picture by. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const tone = (samples: number) =>
  Int16Array.from({ length: samples }, (_, i) =>
    Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24_000)),
  )

/** A colony host with real blobs, artifacts and scratch, and nothing else a media tool does not touch. */
function fakeHost(media: ColonyHost['media']) {
  const dir = tempDir('myr-media-')
  const state = emptyColonyState('col-media')
  let seq = 0
  const apply = (drafts: EventDraft[]): MyrEvent[] =>
    drafts.map((d) => {
      seq += 1
      const e = { ...d, seq, id: `e${seq}`, time: new Date().toISOString() } as unknown as MyrEvent
      applyEvent(state, e)
      return e
    })
  const scratch = join(dir, 'scratch')
  const work = join(dir, 'work')
  mkdirSync(scratch, { recursive: true })
  mkdirSync(work, { recursive: true })
  const host = {
    blobs: new BlobStore(join(dir, 'blobs')),
    state: () => state,
    appendAtomic: async (build: (s: typeof state) => EventDraft[]) => apply(build(state)),
    workspace: {
      resolveForRead: (_agent: string, path: string) => join(work, path),
      resolveInScratch: (_agent: string, path: string) => join(scratch, path),
    },
    ...(media ? { media } : {}),
  } as unknown as ColonyHost
  return { host, state, scratch, work, apply }
}

/** omp's image models, stubbed: records what it was asked and answers with `images`. */
function stubImages(models: string[], images: GeneratedImages['images'], cost?: number) {
  const asked: { request: ImageRequest; model?: string }[] = []
  const stub: ImageModels = {
    imageModels: () => models,
    async generateImage(request, options = {}) {
      asked.push({ request, ...(options.model ? { model: options.model } : {}) })
      return {
        model: options.model ?? models[0] ?? '',
        images,
        tokens: { input: 40, output: 1000, total: 1040 },
        ...(cost !== undefined ? { cost } : {}),
      }
    },
  }
  return { stub, asked }
}

const generate = TOOL_DEFS.find((d) => d.name === 'generate_image')
const tts = TOOL_DEFS.find((d) => d.name === 'tts')

test('generate_image publishes each picture as an image the chat shows, keeps a copy in scratch, and lets the agent see them', async () => {
  const { stub, asked } = stubImages(
    ['openai/gpt-image-1', 'google/gemini-2.5-flash-image'],
    [
      { data: b64(PNG), mimeType: 'image/png' },
      { data: b64(JPEG), mimeType: 'image/jpeg' },
    ],
    0.08,
  )
  const media = ompMediaTools({ images: stub, imageModel: () => undefined, voice: () => undefined })
  const { host, state, scratch, work, apply } = fakeHost(media)
  // One picture to edit from is a published file, the other a file in the agent's working directory.
  const sketch = await host.blobs.put(PNG)
  apply([
    {
      type: 'artifact/versioned',
      actor: { kind: 'agent', id: 'kai' },
      payload: {
        name: 'sketch.png',
        version: 1,
        blob: sketch.hash,
        size: sketch.size,
        author: 'kai',
        mediaType: 'image/png',
      },
    },
  ])
  writeFileSync(join(work, 'photo.jpg'), JPEG)

  const out = await generate?.run(
    {
      prompt: 'A red fox in the snow, watercolour',
      inputs: ['sketch.png', 'photo.jpg'],
      count: 2,
      size: '1536x1024',
    },
    'kai',
    host,
  )

  // Automatic: no model named, so omp tries its image models in order.
  expect(asked).toHaveLength(1)
  expect(asked[0]?.model).toBeUndefined()
  expect(asked[0]?.request).toMatchObject({
    prompt: 'A red fox in the snow, watercolour',
    imageSize: '1536x1024',
    count: 2,
  })
  expect(asked[0]?.request.inputImages?.map((i) => i.mimeType)).toEqual(['image/png', 'image/jpeg'])
  // Each picture is an artifact typed by its real bytes, with a scratch copy the agent can use.
  const png = state.artifacts['images/a-red-fox-in-the-snow-1.png']?.at(-1)
  const jpg = state.artifacts['images/a-red-fox-in-the-snow-2.jpg']?.at(-1)
  expect(png).toMatchObject({ version: 1, author: 'kai', mediaType: 'image/png' })
  expect(jpg).toMatchObject({ version: 1, author: 'kai', mediaType: 'image/jpeg' })
  expect(new Uint8Array(readFileSync(join(scratch, 'images/a-red-fox-in-the-snow-2.jpg')))).toEqual(JPEG)
  // The agent sees the pictures, and the call's spend goes to the round's budget.
  if (!out || typeof out === 'string') throw new Error('expected pictures in the result')
  expect(out.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/jpeg'])
  expect(out.usage).toEqual({ input: 40, output: 1000, totalTokens: 1040, cost: 0.08 })
  expect(out.text).toContain('Made 2 pictures with openai/gpt-image-1')
  expect(out.text).toContain('images/a-red-fox-in-the-snow-1.png v1')
})

test('generate_image uses the image model chosen in Settings, and names its file as the agent asks', async () => {
  const { stub, asked } = stubImages(
    ['openai/gpt-image-1', 'xai/grok-2-image'],
    [{ data: b64(PNG), mimeType: 'image/png' }],
  )
  const media = ompMediaTools({ images: stub, imageModel: () => 'xai/grok-2-image', voice: () => undefined })
  const { host, state } = fakeHost(media)
  const out = await generate?.run({ prompt: 'A logo for a bakery', name: 'brand/logo.webp' }, 'kai', host)
  expect(asked[0]?.model).toBe('xai/grok-2-image')
  // The extension follows the bytes, not the name asked for.
  expect(state.artifacts['brand/logo.png']?.at(-1)?.mediaType).toBe('image/png')
  // No cost reported: the tokens are counted, the cost is not guessed.
  expect(typeof out === 'string' ? undefined : out?.usage).toEqual({
    input: 40,
    output: 1000,
    totalTokens: 1040,
  })
})

test('with no image model, generate_image says how to set one up instead of failing obscurely', async () => {
  const none = ompMediaTools({
    images: stubImages([], []).stub,
    imageModel: () => undefined,
    voice: () => undefined,
  })
  await expect(generate?.run({ prompt: 'A cat' }, 'kai', fakeHost(none).host)).rejects.toThrow(
    prompts.toolResults.noImageModel,
  )
  expect(prompts.toolResults.noImageModel).toContain('Settings → Models & providers')
  // A chosen model whose provider lost its key says so, and how to go back to Automatic.
  const gone = ompMediaTools({
    images: stubImages(['openai/gpt-image-1'], []).stub,
    imageModel: () => 'google/gemini-2.5-flash-image',
    voice: () => undefined,
  })
  await expect(generate?.run({ prompt: 'A cat' }, 'kai', fakeHost(gone).host)).rejects.toThrow(
    prompts.toolResults.imageModelGone('google/gemini-2.5-flash-image'),
  )
  // A run without the model runtime has no media at all.
  await expect(generate?.run({ prompt: 'A cat' }, 'kai', fakeHost(undefined).host)).rejects.toThrow(
    prompts.toolResults.noMedia,
  )
})

test('generate_image refuses an input that is not a picture', async () => {
  const media = ompMediaTools({
    images: stubImages(['openai/gpt-image-1'], []).stub,
    imageModel: () => undefined,
    voice: () => undefined,
  })
  const { host, work } = fakeHost(media)
  writeFileSync(join(work, 'notes.txt'), 'not a picture')
  await expect(generate?.run({ prompt: 'Edit it', inputs: ['notes.txt'] }, 'kai', host)).rejects.toThrow(
    prompts.toolResults.notAPicture('notes.txt'),
  )
})

/** A voice hub whose settings choose omp's cloud voice at 1.25×, with omp's speech stubbed. */
function cloudVoice() {
  const home = tempDir('myr-media-voice-')
  const stored = new SettingsStore(home).get().voice
  const said: { text: string; speed?: number }[] = []
  const keys = new Map<string, string>()
  const hub = new VoiceHub({
    home,
    resolver: new ModelResolver(),
    settings: () => ({ voice: { ...stored, tts: { ...stored.tts, provider: 'omp', speed: 1.25 } } }),
    omp: {
      transcribe: async () => '',
      speak: async (text, options) => {
        said.push({ text, ...(options?.speed ? { speed: options.speed } : {}) })
        return { audio: wav(tone(2400), 24_000), mimeType: 'audio/wav' }
      },
      speechModels: () => ({ stt: [], tts: ['openai/gpt-4o-mini-tts'] }),
    },
    keys: {
      get: async (id) => keys.get(id),
      stored: (id) => keys.has(id),
      set: async (id, key) => void keys.set(id, key),
      remove: async (id) => void keys.delete(id),
    },
  })
  return { hub, said, home }
}

test('tts speaks in the voice chosen in Settings → Voice and publishes a WAV the chat can play', async () => {
  const { hub, said } = cloudVoice()
  const media = ompMediaTools({
    images: stubImages([], []).stub,
    imageModel: () => undefined,
    voice: () => hub,
  })
  const { host, state, scratch } = fakeHost(media)
  const out = await tts?.run({ text: 'Hello there. This is **the** summary.' }, 'kai', host)
  // Sentence by sentence, markdown read as words, at the speed the person set.
  expect(said).toEqual([
    { text: 'Hello there.', speed: 1.25 },
    { text: 'This is the summary.', speed: 1.25 },
  ])
  const file = state.artifacts['audio/hello-there-this-is-the-summary.wav']?.at(-1)
  expect(file).toMatchObject({ version: 1, author: 'kai', mediaType: 'audio/wav' })
  const bytes = await host.blobs.get(file?.blob ?? '')
  expect(sniffAudio(bytes)).toBe('audio/wav')
  expect(existsSync(join(scratch, 'audio/hello-there-this-is-the-summary.wav'))).toBe(true)
  expect(out).toContain('Published audio/hello-there-this-is-the-summary.wav v1')
  expect(out).toContain('omp')
})

test('with Kitten chosen, voice off and its model not downloaded, tts asks the person instead of downloading it', async () => {
  const home = tempDir('myr-media-kitten-')
  const stored = new SettingsStore(home).get().voice
  expect(stored.tts.provider).toBe('kitten')
  const hub = new VoiceHub({ home, resolver: new ModelResolver(), settings: () => ({ voice: stored }) })
  const media = ompMediaTools({
    images: stubImages([], []).stub,
    imageModel: () => undefined,
    voice: () => hub,
  })
  await expect(tts?.run({ text: 'Hello.' }, 'kai', fakeHost(media).host)).rejects.toThrow(
    prompts.toolResults.voiceNotReady,
  )
  // Without the gateway's voice engines (a single colony run), tts says it cannot speak here.
  const noVoice = ompMediaTools({
    images: stubImages([], []).stub,
    imageModel: () => undefined,
    voice: () => undefined,
  })
  await expect(tts?.run({ text: 'Hello.' }, 'kai', fakeHost(noVoice).host)).rejects.toThrow(
    prompts.toolResults.noVoice,
  )
})

test("a picture's cost counts toward the round's spend limit", async () => {
  const home = tempDir('myr-media-colony-')
  const runtime = await bootRuntime(home)
  try {
    const resolver = new ModelResolver()
    const mock = createMockModel({
      handler: (ctx: LlmContext) =>
        // The model's next reply is slow, so only the picture's own result can have stopped the round in time.
        ctx.messages.some((m) => m.role === 'toolResult')
          ? { content: ['done'], delayMs: 10_000 }
          : {
              content: [{ type: 'toolCall', name: 'generate_image', arguments: { prompt: 'A fox at dawn' } }],
            },
    })
    resolver.register('mock/artist', { model: mock.model, streamFn: mock.stream })
    const { stub } = stubImages(['openai/gpt-image-1'], [{ data: b64(PNG), mimeType: 'image/png' }], 0.6)
    const spec = parseColonySpec({
      name: 'Artist',
      mission: 'Draw a fox at dawn.',
      agents: [{ name: 'artist', model: 'mock/artist' }],
      budget: { wall: '20s', costUsd: 0.5 },
    })
    const media = ompMediaTools({ images: stub, imageModel: () => undefined, voice: () => undefined })
    const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200, media })
    const started = Date.now()
    await run.start()
    const final = await run.done
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(final.statusReason).toMatch(/^spend limit reached: \$0\.60 of \$0\.5 for this run$/)
    expect(final.artifacts['images/a-fox-at-dawn.png']?.at(-1)?.mediaType).toBe('image/png')
    const result = (await runtime.ctx.log.read(run.id)).find((e) => e.type === 'tool/result')
    expect(result?.payload).toMatchObject({ tool: 'generate_image', ok: true, usage: { cost: 0.6 } })
  } finally {
    await runtime.dispose()
  }
})

test('pictures and speech are delivery tools, loaded when a request asks for them', () => {
  const spec = parseColonySpec({
    name: 'Solo',
    mission: 'Write a report.',
    agents: [{ name: 'kai', model: 'mock/x' }],
    budget: { wall: '20s' },
  })
  const agent = spec.agents[0]
  if (!agent) throw new Error('no agent')
  expect(toolsFor(spec, agent)).toEqual(expect.arrayContaining(['publish_artifact', 'generate_image', 'tts']))
  expect(onDemand('generate_image') && onDemand('tts')).toBe(true)
  const names = ['generate_image', 'tts', 'shell']
  expect(preloaded('Draw a logo for my bakery', names)).toEqual(['generate_image'])
  expect(preloaded('Make an image of a lighthouse', names)).toEqual(['generate_image'])
  expect(preloaded('Read this summary aloud for me', names)).toEqual(['tts'])
  expect(preloaded('Fix the docker image build', names)).toEqual([])
})

test('the image model setting starts on Automatic and keeps a chosen model', () => {
  const store = new SettingsStore(tempDir('myr-media-settings-'))
  expect(store.get().images).toEqual({})
  expect(store.set({ ...store.get(), images: { model: ' openai/gpt-image-1 ' } }).images).toEqual({
    model: 'openai/gpt-image-1',
  })
  expect(store.set({ ...store.get(), images: {} }).images).toEqual({})
})

test('media files are named from the request or the agent, and sound is told by its bytes', () => {
  expect(mediaName(undefined, 'A Red Fox, in the snow!', 'images', 'png')).toBe(
    'images/a-red-fox-in-the-snow.png',
  )
  expect(mediaName('logo.webp', 'ignored', 'images', 'png', 2)).toBe('logo-2.png')
  expect(mediaName(undefined, '¿¿', 'audio', 'wav')).toBe('audio/untitled.wav')
  expect(() => mediaName('../escape.png', '', 'images', 'png')).toThrow('invalid artifact name')
  expect(sniffAudio(wav(tone(10), 24_000))).toBe('audio/wav')
  expect(sniffAudio(new TextEncoder().encode('ID3\u0004rest'))).toBe('audio/mpeg')
  expect(sniffAudio(new TextEncoder().encode('<html>'))).toBeUndefined()
})
