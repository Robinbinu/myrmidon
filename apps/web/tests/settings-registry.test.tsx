import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  history.replaceState(null, '', '/')
})

const NOW = new Date().toISOString()
const SOON = new Date(Date.now() + 600_000).toISOString()

const MODELS = [
  {
    ref: 'anthropic/claude-x',
    provider: 'anthropic',
    id: 'claude-x',
    name: 'Claude X',
    reasoning: true,
    contextWindow: 200_000,
    windowSource: 'provider',
  },
  { ref: 'openai/gpt-y', provider: 'openai', id: 'gpt-y', name: 'GPT Y', reasoning: false },
  { ref: 'openai/gpt-old', provider: 'openai', id: 'gpt-old', name: 'GPT Old', reasoning: false },
]

const CONFIG = {
  mode: 'orchestrated',
  leadModel: 'anthropic/claude-x',
  roster: [{ role: 'coder', model: 'openai/gpt-y' }],
  extraWorkers: 1,
  judgeModel: 'openai/gpt-y',
}

const VOICE_PROVIDERS = [
  {
    id: 'deepgram',
    label: 'Deepgram',
    keysUrl: 'https://console.deepgram.com',
    key: 'stored',
    configured: true,
    stt: {
      models: [
        { id: 'nova-3', label: 'Nova-3' },
        { id: 'nova-2', label: 'Nova-2' },
      ],
      streaming: true,
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
        { id: 'flash', label: 'Flash' },
        { id: 'multi', label: 'Multilingual' },
      ],
      voices: [{ id: 'sarah', label: 'Sarah' }],
      streaming: true,
      voiceList: false,
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keysUrl: 'https://platform.openai.com',
    key: 'shared',
    sharedWith: 'openai',
    configured: true,
    region: { required: false, default: 'us' },
    realtime: {
      models: [{ id: 'gpt-realtime', label: 'GPT Realtime' }],
      voices: [{ id: 'marin', label: 'Marin' }],
    },
  },
]
const VOICE_ENDPOINTS = [{ id: 'kokoro', baseUrl: 'http://localhost:8880/v1', hasKey: false }]

const CHANNEL = {
  fields: [{ key: 'token', label: 'Bot token', secret: true }],
  values: {},
  dm: 'pairing',
  groups: 'approve',
  mention: true,
  stream: 'progress',
  perPerson: false,
  allow: [],
  allowInvalid: [],
  health: { reconnects: 0, owed: 0 },
  approvedGroups: [],
}
const CHANNELS = [
  {
    ...CHANNEL,
    id: 'telegram',
    label: 'Telegram',
    secretsSet: ['token'],
    configured: true,
    enabled: true,
    status: { state: 'on', account: '@crewbot' },
    people: [{ id: '1', name: 'Robin', role: 'owner', by: 'code' }],
    pending: [{ id: 'r1', kind: 'person', sender: { id: '2', name: 'Ada' }, chat: {}, expires: SOON }],
  },
  {
    ...CHANNEL,
    id: 'slack',
    label: 'Slack',
    secretsSet: [],
    configured: false,
    enabled: false,
    status: { state: 'off' },
    people: [],
    pending: [],
  },
]

type Variant = {
  voice?: Record<string, unknown>
  mascot?: Record<string, unknown>
  voiceStatus?: Record<string, unknown>
}

function settings(v: Variant) {
  return {
    version: 1,
    team: { mode: 'orchestrated', workers: 1, wallMinutes: 30, maxTurns: 40, costUsd: 5, tokens: 0 },
    sandbox: { read: ['~/notes'] },
    computerUse: { enabled: true, engine: 'cua' },
    verification: { threshold: 0.7, reviewer: 'auto' },
    instructions: {},
    observer: { intervalSeconds: 45 },
    search: { provider: 'auto' },
    models: { hidden: ['openai/gpt-old'], hiddenProviders: [], windows: {} },
    permissions: { preset: 'auto', rules: [{ kind: 'command', target: 'git push', decision: 'ask' }] },
    profile: { greeting: 'model', titles: 'model' },
    mascot: {
      crew: { show: true, names: 'custom', custom: ['Ada'] },
      sounds: { enabled: true },
      ...v.mascot,
    },
    appearance: {
      imported: [
        {
          id: 'imported-abc',
          name: 'Mine',
          type: 'dark',
          colors: { 'editor.background': '#101010' },
          syntax: {},
        },
      ],
    },
    voice: {
      enabled: true,
      mode: 'pipeline',
      stt: { provider: 'phonon' },
      tts: { provider: 'kitten', kittenModel: 'nano', voice: 'Leo', speed: 1 },
      sensitivity: 'normal',
      phone: true,
      ...v.voice,
    },
  }
}

/** A Myrmidon for Settings: every page's data, with something in each list so each kind of row shows. */
function fakeServer(v: Variant = {}) {
  let data = {
    settings: settings(v),
    providers: [
      { id: 'anthropic', models: 1, ready: true, custom: false, stored: true },
      { id: 'openai', models: 2, ready: true, custom: false, stored: false },
      {
        id: 'lmstudio',
        models: 1,
        ready: true,
        custom: true,
        baseUrl: 'http://localhost:1234/v1',
        api: 'openai-completions',
        modelIds: ['qwen'],
      },
      { id: 'mistral', models: 0, ready: false, custom: false },
    ],
    searchProviders: [{ id: 'brave', label: 'Brave' }],
    customApis: ['openai-completions'],
    sandbox: 'sandbox-exec',
    guardedReads: [],
    home: '/tmp/home',
    account: 'robin',
    agentDir: '/tmp/home/agent',
    ompSetup: true,
    toolCatalog: [{ name: 'shell', description: 'Run a command' }],
    mcpServers: ['github'],
  }
  const routes: Record<string, unknown> = {
    '/api/voice': {
      enabled: true,
      mode: data.settings.voice.mode,
      stt: { provider: data.settings.voice.stt.provider, phonon: { state: 'ready' }, omp: [], keySet: true },
      tts: {
        provider: data.settings.voice.tts.provider,
        kitten: { state: 'ready' },
        voices: ['Leo'],
        omp: [],
        keySet: true,
      },
      providers: VOICE_PROVIDERS,
      endpoints: VOICE_ENDPOINTS,
      phone: { state: 'on', number: '+15550100' },
      ...v.voiceStatus,
    },
    '/api/logins': {
      logins: [
        { id: 'anthropic', name: 'Claude Pro/Max', provider: 'anthropic', ready: true, signedIn: true },
        { id: 'kimi-code', name: 'Kimi', provider: 'kimi', ready: false, signedIn: false },
      ],
    },
    '/api/mcp': {
      servers: [
        {
          name: 'github',
          transport: 'stdio',
          target: 'npx gh',
          enabled: true,
          status: 'connected',
          tools: ['x'],
        },
      ],
    },
    '/api/tools': { tools: [] },
    '/api/plugins': {
      plugins: [
        {
          name: 'lint',
          version: '1.0.0',
          dir: '/plugins/lint',
          enabled: true,
          skills: [],
          commands: [],
          hooks: 0,
          mcpServers: [],
          settings: { token: { type: 'string', secret: true }, verbose: { type: 'boolean' } },
          values: {},
        },
      ],
    },
    '/api/specialists': {
      specialists: [
        { id: 's1', name: 'ada', specialty: 'data analyst', instructions: '', off: [], createdAt: NOW },
      ],
    },
    '/api/channels': { channels: CHANNELS },
    '/api/projects': { projects: [{ id: 'p1', name: 'Repo', path: '/repo', addedAt: NOW }] },
    '/api/devices': {
      remote: true,
      devices: [{ id: 'd1', name: 'iPhone', scope: 'chat', createdAt: NOW, lastSeenAt: NOW }],
    },
    '/api/gateways': {
      gateways: [
        {
          id: 'g1',
          name: 'VPS',
          url: 'https://vps.example',
          scope: 'full',
          addedAt: NOW,
          health: { ok: true, checkedAt: NOW },
        },
      ],
    },
    '/api/schedules': {
      schedules: [
        { id: 'sc1', name: 'daily', request: 'Summarize the repo', cron: '0 9 * * *', enabled: true },
      ],
    },
    '/api/skills': {
      skills: [
        {
          name: 'pdf',
          description: 'Work with PDFs',
          dir: '/skills/pdf',
          source: 'myrmidon',
          enabled: true,
          curation: { uses: 2, stale: false, kept: false },
        },
      ],
      archived: [{ name: 'old-skill', description: 'Retired' }],
      retire: { staleDays: 30, archiveDays: 60 },
    },
    '/api/skill-proposals': {
      proposals: [{ id: 'sp1', name: 'deploy', description: 'Deploys', body: 'Steps', why: 'Used twice' }],
    },
    '/api/memory': {
      memories: [
        {
          id: 'm1',
          text: 'I prefer pnpm',
          kind: 'preference',
          status: 'active',
          source: { by: 'person' },
          updatedAt: NOW,
        },
      ],
    },
    '/api/hooks': {
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    },
    '/api/computer': {
      supported: true,
      enabled: true,
      engine: 'cua',
      state: { state: 'ready' },
      driver: { path: '/drv', version: '1.0', own: true },
      version: '1.0',
      downloadBytes: 1000,
      grants: { accessibility: false, screenRecording: true },
      controls: [],
    },
    '/api/chats': [
      {
        chatId: 'c1',
        title: 'A chat',
        computerApps: [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }],
      },
    ],
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/settings') {
      if (method === 'PUT') data = { ...data, settings: JSON.parse(String(init?.body)) }
      return Response.json(method === 'PUT' ? { settings: data.settings } : data)
    }
    return Response.json(routes[url.pathname] ?? {})
  }) as unknown as typeof fetch
  return { data, routes }
}

/** The live lists as search indexes them from the same server, so each live row can be checked against its entry. */
async function liveLabels(server: ReturnType<typeof fakeServer>): Promise<Map<string, string>> {
  const { settingsIndex } = await import('../src/client/settings/search.ts')
  const { modelGroups } = await import('../src/client/settings/live.ts')
  const { themeItems } = await import('../src/client/themes/AppearanceSection.tsx')
  const { ACCESS_INFO } = await import('../src/client/permissions/describe.ts')
  const r = server.routes as Record<string, Record<string, never>>
  const index = settingsIndex({
    providers: server.data.providers as never,
    logins: r['/api/logins']?.logins,
    models: MODELS as never,
    modelProviders: modelGroups(MODELS as never, server.data.settings.models.hidden),
    voiceProviders: VOICE_PROVIDERS as never,
    voiceEndpoints: VOICE_ENDPOINTS,
    themes: themeItems(server.data.settings.appearance.imported as never),
    accessGroups: ACCESS_INFO,
    rules: server.data.settings.permissions.rules as never,
    mcpServers: r['/api/mcp']?.servers,
    plugins: r['/api/plugins']?.plugins,
    specialists: r['/api/specialists']?.specialists,
    channels: CHANNELS as never,
    gateways: r['/api/gateways']?.gateways,
    devices: r['/api/devices']?.devices,
    schedules: r['/api/schedules']?.schedules,
    skills: r['/api/skills']?.skills,
  })
  return new Map(index.filter((e) => e.key !== undefined).map((e) => [`${e.id}|${e.key}`, e.label]))
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await act(async () => await Bun.sleep(15))
}

async function showSettings(section: string, extra: Record<string, unknown> = {}) {
  const { Settings } = await import('../src/client/Settings.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const view = await mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <Settings
          onClose={() => {}}
          theme="system"
          onTheme={() => {}}
          reduceMotion
          onReduceMotion={() => {}}
          models={MODELS as never}
          onModelsChanged={() => {}}
          config={CONFIG as never}
          onConfig={() => {}}
          initialSection={section as never}
          onRunSetup={() => {}}
          onOpenSetupStep={() => {}}
          {...extra}
        />
      </ToastProvider>
    </MotionConfig>,
  )
  await settle()
  return view
}

/** Clicks the first button (or tab) whose text is exactly `text`, if the page has one. */
async function click(text: string, within: ParentNode = document) {
  const buttons = [...within.querySelectorAll<HTMLElement>('button, [role=tab]')]
  const el =
    buttons.find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text) ??
    buttons.find((b) => b.textContent?.trim().startsWith(text))
  if (!el) throw new Error(`No button "${text}" to reveal more of the page`)
  await act(async () => el.click())
  await settle(3)
}

/**
 * Types into a field as React hears it here: react-dom loaded before this file's page went up, so it listens for
 * key presses rather than input events.
 */
async function typeInto(field: HTMLInputElement | null, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text)
    field?.dispatchEvent(new Event('input', { bubbles: true }))
    field?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.at(-1) ?? '' }))
  })
  await settle(3)
}

/** What a settings page shows a person can change: inputs, pop-ups, text areas, switches, segments and radios. */
const CONTROLS =
  'input:not([type=hidden]):not([type=file]), select, textarea, button[aria-pressed], [role=switch], [role=radio]'

/** Each kind of row, as the control the test finds in it. */
const KIND: Record<string, string | undefined> = {
  switch: '[role=switch]',
  segmented: 'button[aria-pressed]',
  select: 'select',
  text: 'input:not([type=number]):not([type=range]):not([type=radio]):not([type=checkbox])',
  number: 'input[type=number]',
  textarea: 'textarea',
  range: 'input[type=range]',
  choice: 'button[aria-pressed], input[type=radio]',
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const describe = (el: Element) =>
  `${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent?.trim().slice(0, 40) ?? ''}"`

interface Seen {
  ids: Set<string>
  loose: string[]
  wrongKind: string[]
  unlabelled: string[]
}

/** Reads what Settings shows now: its page and any sheet it opened. */
async function scan(seen: Seen, where: string, labels: Map<string, string>) {
  const { SETTINGS, DYNAMIC } = await import('../src/client/settings/registry.ts')
  const roots = [
    ...document.querySelectorAll('[data-settings-page]'),
    ...document.querySelectorAll('[role=dialog]'),
  ]
  for (const root of roots) {
    for (const c of root.querySelectorAll(CONTROLS))
      if (!c.closest('[data-setting-id]')) seen.loose.push(`${where}: ${describe(c)}`)
    for (const row of root.querySelectorAll<HTMLElement>('[data-setting-id]')) {
      const id = row.dataset.settingId ?? ''
      seen.ids.add(id)
      const fixed = SETTINGS[id as keyof typeof SETTINGS] as { control: string; label: string } | undefined
      const live = DYNAMIC[id as keyof typeof DYNAMIC] as { control: string } | undefined
      const entry = fixed ?? live
      if (!entry) {
        seen.unlabelled.push(`${where}: ${id} is not in the registry`)
        continue
      }
      // Its own controls: those not in a row nested inside it.
      const own = [...row.querySelectorAll(CONTROLS)].filter((c) => c.closest('[data-setting-id]') === row)
      const kind = KIND[entry.control]
      if (kind && own.length && !own.some((c) => c.matches(kind)))
        seen.wrongKind.push(`${where}: ${id} is a ${entry.control} but shows ${own.map(describe).join(', ')}`)
      // A live row is indexed from the same live list, under the same key.
      const want = fixed ? fixed.label : labels.get(`${id}|${row.dataset.settingKey}`)
      if (want === undefined) {
        seen.unlabelled.push(`${where}: ${id} "${row.dataset.settingKey}" is not indexed from live data`)
        continue
      }
      // A single control's row, and a live item's, shows the label search lists it by.
      if (kind || live) {
        const text = norm(
          [
            row.textContent ?? '',
            ...[row, ...row.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? ''),
          ].join(' '),
        )
        if (!text.includes(norm(want))) seen.unlabelled.push(`${where}: ${id} does not show "${want}"`)
      }
    }
  }
}

test('every control on every Settings page is a registry row, and every registry entry is on some page', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { SECTIONS } = await import('../src/client/settings/pages.ts')
  const { SETTINGS, DYNAMIC } = await import('../src/client/settings/registry.ts')
  const seen: Seen = { ids: new Set(), loose: [], wrongKind: [], unlabelled: [] }
  const t = copy.settings
  /** Opens what each page keeps folded: forms behind a button, a channel's sheet and its tabs. */
  const reveal: Partial<Record<string, (() => Promise<void>)[]>> = {
    models: [
      () => click(t.page.providersTab),
      () => click(t.providers.customEndpoint),
      () => click(t.providers.replaceKey),
      () => click(t.voiceProviders.endpoints.add),
    ],
    team: [() => click(copy.composer.helperList)],
    tools: [() => click(t.mcp.addServer)],
    permissions: [() => click(copy.permissions.rules.add)],
    specialists: [() => click(t.specialists.add), () => click(t.specialists.edit)],
    schedules: [() => click(t.schedules.change), () => click(t.schedules.repeat.custom).catch(() => {})],
    memory: [() => click('I prefer pnpm')],
    channels: [
      () => click('Telegram'),
      () => click(t.channels.tabs.setup),
      () => click(t.channels.tabs.rules),
    ],
  }
  const variants: { section: string; variant?: Variant }[] = [
    ...SECTIONS.map((s) => ({ section: s.id })),
    // Realtime calls with cloud engines, then the person's own speech service.
    {
      section: 'voice',
      variant: {
        voice: {
          mode: 'realtime',
          realtime: { provider: 'openai' },
          stt: { provider: 'deepgram' },
          tts: { provider: 'elevenlabs', kittenModel: 'nano', voice: 'Leo', speed: 1 },
        },
      },
    },
    {
      section: 'voice',
      variant: {
        voice: {
          stt: { provider: 'endpoint:kokoro' },
          tts: { provider: 'endpoint:kokoro', kittenModel: 'nano', voice: 'Leo', speed: 1 },
        },
      },
    },
  ]
  for (const { section, variant } of variants) {
    const labels = await liveLabels(fakeServer(variant))
    const view = await showSettings(section)
    await scan(seen, section, labels)
    for (const step of reveal[section] ?? []) {
      await step()
      await scan(seen, section, labels)
    }
    // A sheet left open would be read again on the next page.
    if (document.querySelector('[role=dialog]')) await press('Escape')
    await view.unmount()
  }
  const all = [...Object.keys(SETTINGS), ...Object.keys(DYNAMIC)]
  expect({
    controlsWithoutARegistryRow: [...new Set(seen.loose)],
    rowsShowingAnotherKindOfControl: [...new Set(seen.wrongKind)],
    rowsNotSayingTheirLabel: [...new Set(seen.unlabelled)],
    entriesNoPageShows: all.filter((id) => !seen.ids.has(id)),
  }).toEqual({
    controlsWithoutARegistryRow: [],
    rowsShowingAnotherKindOfControl: [],
    rowsNotSayingTheirLabel: [],
    entriesNoPageShows: [],
  })
})

test('search: ⌘F focuses the field, results show where each setting is, and choosing one jumps to its row', async () => {
  fakeServer()
  const { copy } = await import('../src/client/copy.ts')
  const view = await showSettings('general')
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${copy.settings.search.label}"]`)
  expect(field).not.toBeNull()
  await press('f', { metaKey: true, ctrlKey: true })
  expect(document.activeElement).toBe(field)
  await settle()
  // Focused and empty: suggestions in place of the page.
  expect(document.body.textContent).toContain(copy.settings.search.empty.title)
  const type = (text: string) => typeInto(field, text)
  await type('dark mode')
  const options = () => [...document.querySelectorAll('[role=option]')].map((o) => o.textContent ?? '')
  expect(options()[0]).toContain(copy.settings.sections.appearance.label)
  // A live item from a page's own list: the MCP server is found by its name.
  await type('github')
  expect(options()[0]).toContain('github')
  expect(options()[0]).toContain(copy.settings.mcp.title)
  // Arrows move, Enter opens the page and highlights the row.
  await type('spend limit')
  await press('Enter')
  await settle(8)
  const row = document.querySelector('[data-setting-id="team.costUsd"]')
  expect(document.querySelector('[data-settings-page="team"]')).not.toBeNull()
  expect(row?.hasAttribute('data-setting-highlight')).toBe(true)
  expect(field?.value).toBe('')
  // Nothing matching: it says so and suggests what to try.
  field?.focus()
  await type('qqqqzz')
  expect(document.body.textContent).toContain(copy.settings.search.noResults('qqqqzz'))
  // Esc clears the field and puts the page back.
  await press('Escape')
  expect(field?.value).toBe('')
  await view.unmount()
})

test('a result inside a folded list opens it: a model of a long list, a provider behind "Show more"', async () => {
  fakeServer()
  const { copy } = await import('../src/client/copy.ts')
  const view = await showSettings('general')
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${copy.settings.search.label}"]`)
  field?.focus()
  await typeInto(field, 'mistral')
  await press('Enter')
  await settle(10)
  const row = document.querySelector('[data-setting-id="providers.provider"][data-setting-key="mistral"]')
  expect(row?.hasAttribute('data-setting-highlight')).toBe(true)
  await view.unmount()
})

test('a result its page hides now shows the row it is under, and says how to reach it', async () => {
  fakeServer({ voice: { enabled: false } })
  const { copy } = await import('../src/client/copy.ts')
  const view = await showSettings('general')
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${copy.settings.search.label}"]`)
  field?.focus()
  await typeInto(field, 'kitten model size')
  await press('Enter')
  // It waits a moment for the row itself before falling back.
  const { SETTINGS_SEARCH } = await import('../src/client/ui-config.ts')
  await act(async () => await Bun.sleep(SETTINGS_SEARCH.fallbackMs + 200))
  await settle(2)
  expect(document.querySelector('[data-setting-id="voice.tts.kittenModel"]')).toBeNull()
  expect(
    document.querySelector('[data-setting-id="voice.enabled"]')?.hasAttribute('data-setting-highlight'),
  ).toBe(true)
  expect(document.body.textContent).toContain(
    copy.settings.search.startWith(copy.settings.voice.kittenModel, copy.settings.voice.enabled),
  )
  await view.unmount()
})
