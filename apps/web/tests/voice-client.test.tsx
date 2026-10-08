import { beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { copy } from '../src/client/copy.ts'
import { CallBar, callee, speaker } from '../src/client/voice/CallBar.tsx'
import type { CallMedia } from '../src/client/voice/call-client.ts'
import { engineTrouble } from '../src/client/voice/engine-trouble.ts'

// call-client.ts reaches the API module, which reads the page's address when it loads. Bun runs every test file in one
// process, so the stand-ins are put back as soon as the module has loaded.
let client: typeof import('../src/client/voice/call-client.ts')
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>
  const before = { location: g.location, window: g.window }
  g.location ??= { hash: '', pathname: '/', protocol: 'http:', host: 'localhost' }
  g.window ??= globalThis
  try {
    client = await import('../src/client/voice/call-client.ts')
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete g[key]
      else g[key] = value
    }
  }
})

/** A browser's mic and audio, as far as a call uses them, recording what was made and released. */
function fakeMedia(addModule: () => Promise<void> = async () => {}) {
  const made = { contexts: 0, closed: 0, sockets: 0, stopped: 0 }
  const track = {
    enabled: true,
    stop: () => {
      made.stopped++
    },
  }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  let grant: () => void = () => {}
  const media = {
    mic: () => new Promise((resolve) => (grant = () => resolve(stream))),
    audio: () => {
      made.contexts++
      const ctx = {
        state: 'running',
        audioWorklet: { addModule },
        createMediaStreamSource: () => ({ connect() {} }),
        close: async () => {
          ctx.state = 'closed'
          made.closed++
        },
      }
      return ctx
    },
    worklet: () => ({ port: {}, disconnect() {} }),
    socket: () => {
      made.sockets++
      return { readyState: 0, send() {}, close() {} }
    },
  } as unknown as CallMedia
  return { made, track, media, grant: () => grant() }
}

const handlers = (ended: string[] = []) => ({
  state() {},
  hello() {},
  line() {},
  level() {},
  chat() {},
  task() {},
  error() {},
  latency() {},
  approval() {},
  approvalDone() {},
  ended: (reason: string) => ended.push(reason),
})

test('hanging up while the mic is being asked for leaves no mic, audio or socket behind', async () => {
  const audio = fakeMedia()
  const ended: string[] = []
  const call = new client.CallClient('chat-1', handlers(ended), undefined, audio.media)
  const starting = call.start()
  call.hangUp()
  audio.grant()
  await starting
  expect(ended).toEqual(['hung-up'])
  expect(audio.made.stopped).toBe(1)
  expect(audio.made.contexts).toBe(0)
  expect(audio.made.sockets).toBe(0)
})

test('hanging up while the audio thread loads closes the context and opens no socket', async () => {
  let loaded: () => void = () => {}
  const audio = fakeMedia(() => new Promise<void>((resolve) => (loaded = resolve)))
  const call = new client.CallClient(undefined, handlers(), undefined, audio.media)
  const starting = call.start()
  audio.grant()
  await Promise.resolve()
  await Promise.resolve()
  call.hangUp()
  loaded()
  await starting
  expect(audio.made.contexts).toBe(1)
  expect(audio.made.closed).toBe(1)
  expect(audio.made.stopped).toBeGreaterThan(0)
  expect(audio.made.sockets).toBe(0)
})

test('muting turns the mic track off, so the browser no longer shows it in use', async () => {
  const audio = fakeMedia()
  const call = new client.CallClient('chat-1', handlers(), undefined, audio.media)
  const starting = call.start()
  audio.grant()
  await starting
  expect(audio.made.sockets).toBe(1)
  call.mute(true)
  expect(audio.track.enabled).toBe(false)
  call.mute(false)
  expect(audio.track.enabled).toBe(true)
  call.hangUp()
})

test('a refused call shows the server’s reason; server errors and lost connections are said plainly', () => {
  const off = 'Voice calls are off: turn them on in Settings → Voice.'
  expect(client.closeMessage(4409, off, true)).toBe(off)
  expect(client.closeMessage(4429, 'There are already 4 calls going on; hang one up first.', true)).toContain(
    'hang one up',
  )
  expect(client.closeMessage(1011, '', true)).toBe(copy.call.failed)
  // An older server's engine failure comes with 1011 and its reason.
  expect(client.closeMessage(1011, 'Phonon-2 took too long to start', true)).toBe(
    'Phonon-2 took too long to start',
  )
  expect(client.closeMessage(1009, 'audio frame too large', true)).toBe(copy.call.failed)
  expect(client.closeMessage(1006, '', false)).toBe(copy.call.couldNotStart)
  expect(client.closeMessage(1006, '', true)).toBe(copy.call.dropped)
})

const bar = (props: Partial<Parameters<typeof CallBar>[0]> = {}) =>
  renderToStaticMarkup(
    <CallBar
      talk="lead"
      state="listening"
      lines={[]}
      muted={false}
      onMute={() => {}}
      onHangUp={() => {}}
      {...props}
    />,
  )

test('the call bar says Muted while muted, not Listening', () => {
  expect(bar({ muted: true })).toContain(copy.call.states.muted)
  expect(bar({ muted: true })).not.toContain(copy.call.states.listening)
  expect(bar()).toContain(copy.call.states.listening)
})

test('the call bar names who spoke each line, who the call reached and its chat', () => {
  const html = bar({
    talk: 'assistant',
    chat: { title: 'Fix the login page', onOpen() {} },
    lines: [
      { who: 'person', text: 'how is it going' },
      { who: 'voice', text: 'Ana is on it', from: 'ana' },
    ],
  })
  expect(html).toContain(copy.call.with(copy.call.assistantName))
  expect(html).toContain(copy.call.inChat('Fix the login page'))
  expect(html).toContain(`${copy.call.you}: `)
  expect(html).toContain('ana: ')
  expect(html).not.toContain('Crew:')
  // An older server says nothing of who spoke: the one the call reached did.
  expect(bar({ lines: [{ who: 'voice', text: 'On it' }] })).toContain(`${copy.call.speaker.lead}: `)
})

test('the call bar shows what waits for a yes or no, and announces only its state, lines and approval', () => {
  const html = bar({ approval: 'Run npm install', lines: [{ who: 'person', text: 'hi' }] })
  expect(html).toContain(copy.call.approval)
  expect(html).toContain('Run npm install')
  expect(html.match(/role="(status|log)"/g)?.length).toBe(3)
  expect(bar()).not.toMatch(/^<div[^>]*(role|aria-live)=/)
})

test('speakers and callees read as names', () => {
  expect(speaker('assistant')).toBe(copy.call.speaker.assistant)
  expect(speaker('lead')).toBe(copy.call.speaker.lead)
  expect(speaker('ana')).toBe('ana')
  expect(callee('assistant')).toBe(copy.call.assistantName)
})

test('an engine’s raw error becomes a plain cause and fix', () => {
  const t = copy.settings.voice.trouble
  expect(
    engineTrouble('phonon', 'uv is not installed: get it from https://docs.astral.sh/uv/ and try again'),
  ).toBe(t.noUv)
  expect(engineTrouble('phonon', 'error: Failed to download mlx==0.29')).toBe(t.phonon)
  expect(engineTrouble('kitten', 'downloading voices.npz failed (502)')).toBe(t.kitten)
})
