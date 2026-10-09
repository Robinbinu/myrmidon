import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  history.replaceState(null, '', '/')
})

const PROVIDERS = [
  {
    id: 'deepgram',
    label: 'Deepgram',
    keysUrl: 'https://console.deepgram.com',
    key: 'stored',
    configured: true,
    stt: { models: [{ id: 'nova-3', label: 'Nova-3' }], streaming: true },
    tts: {
      models: [{ id: 'aura-2', label: 'Aura-2' }],
      voices: [{ id: 'aura-2-thalia-en', label: 'Thalia' }],
      streaming: true,
      voiceList: false,
    },
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    keysUrl: 'https://elevenlabs.io',
    key: 'env',
    configured: true,
    tts: {
      models: [
        { id: 'eleven_flash_v2_5', label: 'Flash v2.5' },
        { id: 'eleven_multilingual_v2', label: 'Multilingual v2' },
      ],
      voices: [{ id: 'premade', label: 'Sarah' }],
      streaming: true,
      voiceList: true,
    },
  },
  {
    id: 'cartesia',
    label: 'Cartesia',
    keysUrl: 'https://play.cartesia.ai/keys',
    key: 'missing',
    configured: false,
    stt: { models: [{ id: 'ink-whisper', label: 'Ink Whisper' }], streaming: true },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keysUrl: 'https://platform.openai.com/api-keys',
    key: 'shared',
    sharedWith: 'openai',
    configured: true,
    stt: { models: [{ id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' }], streaming: false },
    realtime: {
      models: [{ id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1' }],
      voices: [{ id: 'marin', label: 'Marin' }],
    },
  },
  {
    id: 'aws',
    label: 'AWS (Transcribe, Polly)',
    keysUrl: 'https://console.aws.amazon.com',
    key: 'missing',
    aws: true,
    region: { required: true, default: 'us-east-1' },
    configured: false,
    stt: { models: [{ id: 'streaming', label: 'Streaming' }], streaming: true },
  },
]

const ENDPOINTS = [{ id: 'kokoro', baseUrl: 'http://localhost:8880/v1', hasKey: false }]

function settings(voice: Record<string, unknown>) {
  return {
    settings: {
      version: 1,
      team: { mode: 'orchestrated', workers: 0, wallMinutes: 30, maxTurns: 40, costUsd: 5, tokens: 0 },
      verification: { threshold: 0.7, reviewer: 'auto' },
      instructions: {},
      observer: { intervalSeconds: 45 },
      search: { provider: 'auto' },
      models: { hidden: [], hiddenProviders: [], windows: {} },
      permissions: { preset: 'auto', rules: [] },
      profile: { greeting: 'model', titles: 'model' },
      voice: {
        enabled: true,
        mode: 'pipeline',
        stt: { provider: 'phonon' },
        tts: { provider: 'kitten', kittenModel: 'nano', voice: 'Leo', speed: 1 },
        sensitivity: 'normal',
        ...voice,
      },
    },
    providers: [],
    searchProviders: [],
    customApis: [],
    sandbox: 'none',
    home: '/tmp/home',
    ompSetup: false,
    toolCatalog: [],
  }
}

/** A Myrmidon for the page: settings, voice status with providers, voice lists, and what was sent to it. */
function fakeServer(voice: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = []
  let data = settings(voice)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (method !== 'GET') sent.push({ method, path: url.pathname, body })
    if (url.pathname === '/api/settings') {
      if (method === 'PUT') data = { ...data, settings: body }
      return Response.json(method === 'PUT' ? { settings: body } : data)
    }
    if (url.pathname === '/api/voice')
      return Response.json({
        enabled: true,
        mode: data.settings.voice.mode,
        stt: {
          provider: data.settings.voice.stt.provider,
          phonon: { state: 'ready' },
          omp: [],
          keySet: true,
        },
        tts: { provider: 'kitten', kitten: { state: 'ready' }, voices: ['Leo'], omp: [], keySet: true },
        providers: PROVIDERS,
        endpoints: ENDPOINTS,
      })
    if (url.pathname === '/api/voice/providers/elevenlabs/voices')
      return Response.json({
        voices: [
          { id: 'rachel-id', label: 'Rachel' },
          { id: 'adam-id', label: 'Adam' },
        ],
      })
    if (url.pathname.startsWith('/api/voice/providers/'))
      return Response.json({ providers: PROVIDERS, endpoints: ENDPOINTS })
    return Response.json({})
  }) as unknown as typeof fetch
  return { sent }
}

async function showSettings(initialSection: 'voice' | 'models') {
  const { Settings } = await import('../src/client/Settings.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  return mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <Settings
          onClose={() => {}}
          theme="system"
          onTheme={() => {}}
          reduceMotion
          onReduceMotion={() => {}}
          models={[]}
          onModelsChanged={() => {}}
          onConfig={() => {}}
          initialSection={initialSection}
        />
      </ToastProvider>
    </MotionConfig>,
  )
}

const settle = () => act(async () => await Bun.sleep(20))
const select = (label: string) => document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
const choose = async (el: HTMLSelectElement, value: string) =>
  act(async () => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })

test('the speech pickers offer this computer, configured providers and your services; the rest show they need a key', async () => {
  const { engineGroups } = await import('../src/client/voice/providers.ts')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.voice
  const groups = engineGroups('stt', 'phonon', PROVIDERS as never, [
    { id: 'kokoro', baseUrl: 'http://localhost:8880/v1', hasKey: false },
  ])
  expect(
    groups.map((g) => [g.label, g.options.map((o) => `${o.value}${o.disabled ? ' (off)' : ''}`)]),
  ).toEqual([
    [t.groups.local, ['phonon']],
    [t.groups.omp, ['omp']],
    [t.groups.cloud, ['deepgram', 'openai']],
    [t.groups.missing, ['cartesia (off)', 'aws (off)']],
    [t.groups.yours, ['endpoint:kokoro']],
  ])
  expect(groups[3]?.options[0]?.label).toBe(t.needsKey('Cartesia'))
  // A saved choice that is not offered any more is still shown.
  expect(engineGroups('stt', 'gone', [], [])[0]?.options).toEqual([{ value: 'gone', label: 'gone' }])
})

test('Settings → Voice picks a configured provider, its model and its voice from the provider’s list', async () => {
  const { sent } = fakeServer()
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.voice
  const { host, unmount } = await showSettings('voice')
  try {
    await settle()
    const stt = select(t.sttTitle)
    expect([...stt.options].map((o) => o.value)).toEqual([
      'phonon',
      'omp',
      'deepgram',
      'openai',
      'cartesia',
      'aws',
      'endpoint:kokoro',
    ])
    expect([...stt.options].find((o) => o.value === 'cartesia')?.disabled).toBe(true)
    await choose(stt, 'deepgram')
    expect(host.textContent).toContain(t.cloudHints.streams('Deepgram'))
    await choose(select(t.ttsTitle), 'elevenlabs')
    await settle()
    // ElevenLabs' voices come from its list, through Myrmidon (which holds the key).
    const voices = select(t.voice)
    expect([...voices.options].map((o) => o.textContent)).toEqual(['Rachel', 'Adam'])
    await choose(voices, 'adam-id')
    await choose(select(t.model), 'eleven_multilingual_v2')
    await act(async () => await Bun.sleep(600))
    const saved = sent.filter((s) => s.path === '/api/settings').at(-1)?.body.voice as Record<string, unknown>
    expect(saved.stt).toEqual({ provider: 'deepgram' })
    expect(saved.tts).toMatchObject({
      provider: 'elevenlabs',
      voiceId: 'adam-id',
      model: 'eleven_multilingual_v2',
    })
  } finally {
    await unmount()
  }
})

test('realtime mode picks a configured realtime model and voice, and hides the call model', async () => {
  fakeServer({ mode: 'realtime' })
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.voice
  const { host, unmount } = await showSettings('voice')
  try {
    await settle()
    expect(host.textContent).toContain(t.realtimeTitle)
    expect(host.textContent).not.toContain(t.callModel)
    expect(select(t.realtimeTitle).value).toBe('openai')
    expect(select(t.realtimeModel).value).toBe('gpt-realtime-2.1')
    expect(select(t.realtimeVoice).value).toBe('marin')
    expect(host.textContent).toContain(t.directOnly)
  } finally {
    await unmount()
  }
})

test('"Add a voice provider" opens Models & providers at its voice providers, where a key is added', async () => {
  const { sent } = fakeServer()
  const { copy } = await import('../src/client/copy.ts')
  const scrolled: string[] = []
  const realScroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id)
  }
  const { host, unmount } = await showSettings('voice')
  try {
    await settle()
    const add = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === copy.settings.voice.addProvider,
    ) as HTMLButtonElement
    await act(async () => add.click())
    await settle()
    // The Providers tab, scrolled to Voice providers.
    expect(host.textContent).toContain(copy.settings.voiceProviders.heading)
    expect(scrolled).toContain('voice-providers')
    const row = (id: string) => host.querySelector(`[data-voice-provider="${id}"]`) as HTMLElement
    expect(row('openai').textContent).toContain(copy.settings.voiceProviders.key.shared('openai'))
    expect(row('elevenlabs').textContent).toContain(copy.settings.voiceProviders.key.env)
    expect(row('cartesia').textContent).toContain(copy.settings.voiceProviders.key.missing)
    // Cartesia's key, through the form.
    const addKey = [...row('cartesia').querySelectorAll('button')].find(
      (b) => b.textContent === copy.settings.voiceProviders.addKey,
    ) as HTMLButtonElement
    await act(async () => addKey.click())
    const input = row('cartesia').querySelector('input[type=password]') as HTMLInputElement
    // happy-dom's input events do not reach React's change tracking, so the field gets its typing through its handler.
    await act(async () => {
      const handlers = Object.entries(input).find(([k]) => k.startsWith('__reactProps'))?.[1] as {
        onChange(e: { target: { value: string } }): void
      }
      handlers.onChange({ target: { value: 'sk_car_123' } })
    })
    await act(async () =>
      (row('cartesia').querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    )
    await settle()
    expect(sent).toContainEqual({
      method: 'PUT',
      path: '/api/voice/providers/cartesia/key',
      body: { apiKey: 'sk_car_123' },
    })
    // AWS asks for its two parts, and shows its region.
    const awsKey = [...row('aws').querySelectorAll('button')].find(
      (b) => b.textContent === copy.settings.voiceProviders.addKey,
    ) as HTMLButtonElement
    await act(async () => awsKey.click())
    expect(
      row('aws').querySelector(`input[aria-label="${copy.settings.voiceProviders.accessKeyId}"]`),
    ).not.toBeNull()
    expect(
      row('aws').querySelector(`input[aria-label="${copy.settings.voiceProviders.secretAccessKey}"]`),
    ).not.toBeNull()
    expect(row('aws').textContent).toContain(copy.settings.voiceProviders.region)
    // The person's own services are listed with their address.
    expect(host.textContent).toContain('http://localhost:8880/v1')
  } finally {
    Element.prototype.scrollIntoView = realScroll
    await unmount()
  }
})
