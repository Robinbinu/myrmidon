import { afterAll, beforeAll, expect, test } from 'bun:test'
import { settingsSchema } from '@myrmidon/runtime'

// Settings' modules read the page's address and storage when they load (api.ts), as icons.test.ts explains.
const page = globalThis as unknown as Record<string, unknown>
beforeAll(() => {
  page.window = Object.assign(new EventTarget(), { innerWidth: 1440 })
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})
afterAll(() => {
  delete page.window
  delete page.location
})

const load = async () => {
  const registry = await import('../src/client/settings/registry.ts')
  const search = await import('../src/client/settings/search.ts')
  const pages = await import('../src/client/settings/pages.ts')
  return { ...registry, ...search, ...pages }
}

/** Every key path of the settings file, down to its leaves (an array, a dict or `any` is one leaf). */
function schemaPaths(): { leaves: string[]; all: Set<string> } {
  const leaves: string[] = []
  const all = new Set<string>()
  const walk = (node: { type?: string; dict?: Record<string, unknown> }, path: string) => {
    if (path) all.add(path)
    if (node.type === 'object' && node.dict)
      for (const [key, child] of Object.entries(node.dict))
        walk(child as typeof node, path ? `${path}.${key}` : key)
    else leaves.push(path)
  }
  walk(settingsSchema as unknown as { type?: string; dict?: Record<string, unknown> }, '')
  return { leaves, all }
}

test('every key of the settings file is shown by a registry entry, or marked as not shown and why', async () => {
  const { SETTINGS, DYNAMIC, NOT_SHOWN } = await load()
  const claimed = new Set<string>([
    ...[...Object.values(SETTINGS), ...Object.values(DYNAMIC)].flatMap(
      (e) => (e as { keys?: readonly string[] }).keys ?? [],
    ),
    ...Object.keys(NOT_SHOWN),
  ])
  const { leaves, all } = schemaPaths()
  const covered = (path: string) =>
    path.split('.').some((_, i, parts) => claimed.has(parts.slice(0, i + 1).join('.')))
  expect(leaves.filter((p) => !covered(p))).toEqual([])
  // A claim must name a key the file has, so a renamed key cannot leave a stale entry behind.
  expect([...claimed].filter((k) => !all.has(k))).toEqual([])
  for (const reason of Object.values(NOT_SHOWN)) expect(reason.length).toBeGreaterThan(10)
})

test('registry entries hang together: each names a page, and each row it depends on exists', async () => {
  const { SETTINGS, DYNAMIC, SECTIONS } = await load()
  const pages = new Set(SECTIONS.map((s) => s.id))
  const ids = new Set([...Object.keys(SETTINGS), ...Object.keys(DYNAMIC)])
  const entries = [...Object.entries(SETTINGS), ...Object.entries(DYNAMIC)] as [
    string,
    { page: string; dependsOn?: string },
  ][]
  expect(entries.filter(([, e]) => !pages.has(e.page as never)).map(([id]) => id)).toEqual([])
  expect(entries.filter(([, e]) => e.dependsOn && !ids.has(e.dependsOn)).map(([id]) => id)).toEqual([])
  // Every page has something to find on it.
  expect([...pages].filter((p) => !entries.some(([, e]) => e.page === p))).toEqual([])
})

test('search answers in the words people use: synonyms, prefixes and typos find the right page', async () => {
  const { settingsIndex, searchSettings } = await load()
  const index = settingsIndex()
  const top = (q: string) => searchSettings(index, q)[0]?.entry
  const pagesFor = (q: string, n = 3) =>
    searchSettings(index, q)
      .slice(0, n)
      .map((r) => r.entry.page)
  expect(top('dark mode')?.page).toBe('appearance')
  const { themeItems } = await import('../src/client/themes/AppearanceSection.tsx')
  const withThemes = settingsIndex({ themes: themeItems([]) })
  expect(searchSettings(withThemes, 'dark mode').map((r) => r.entry.key ?? r.entry.id)).toContain('dark')
  expect(pagesFor('api key')).toEqual(['models', 'models', 'models'])
  expect(top('mic')?.page).toBe('voice')
  expect(top('microphone')?.page).toBe('voice')
  expect(top('sandbox')?.id).toBe('permissions.preset')
  expect(top('full access')?.id).toBe('permissions.preset')
  expect(top('shortcut')?.id).toBe('general.shortcuts')
  expect(top('notifications')?.id).toBe('general.notifications')
  // Typos: a letter missing, two swapped, one wrong.
  expect(top('notifcations')?.id).toBe('general.notifications')
  expect(top('spend limti')?.id).toBe('team.costUsd')
  expect(top('reveiwer')?.page).toBe('team')
  // A label's own start ranks above a word deep in a hint.
  expect(top('reduce')?.id).toBe('general.reduceMotion')
  // Words spread over a setting's parts: "kitten" is one of its engine's names, "model size" its label.
  expect(top('kitten model size')?.id).toBe('voice.tts.kittenModel')
  expect(top('telegram mention')).toBeUndefined()
  expect(searchSettings(index, 'zzzz qqqq')).toEqual([])
  expect(searchSettings(index, '   ')).toEqual([])
})

test('every result says where it is: Page › section, from the same pages the list shows', async () => {
  const { settingsIndex, searchSettings, sectionInfo } = await load()
  const r = searchSettings(settingsIndex(), 'speech to text')[0]?.entry
  expect(r?.trail).toEqual([sectionInfo('voice').label, 'Speech to text'])
  const { themeItems } = await import('../src/client/themes/AppearanceSection.tsx')
  const theme = searchSettings(settingsIndex({ themes: themeItems([]) }), 'dracula')[0]?.entry
  expect(theme?.id).toBe('appearance.theme')
  expect(theme?.trail).toEqual([sectionInfo('appearance').label, 'Themes', 'Dark'])
})

test('live rows are found by name, through the same registry entries the pages render them with', async () => {
  const { settingsIndex, searchSettings, itemKey } = await load()
  const index = settingsIndex({
    providers: [{ id: 'lmstudio', models: 2, ready: true, custom: true }],
    mcpServers: [
      { name: 'github', transport: 'stdio', target: 'npx gh', enabled: true, status: 'connected', tools: [] },
    ],
    voiceProviders: [
      {
        id: 'deepgram',
        label: 'Deepgram',
        keysUrl: '',
        key: 'missing',
        configured: false,
        stt: { models: [], streaming: true },
      },
    ],
    specialists: [
      { id: 's1', name: 'ada', specialty: 'data analyst', instructions: '', off: [], createdAt: '' },
    ],
    schedules: [
      { id: 'x', name: 'n', request: 'Summarize the repo every morning', cron: '0 9 * * *', enabled: true },
    ],
  })
  const first = (q: string) => searchSettings(index, q)[0]?.entry
  expect(first('lmstud')).toMatchObject({
    id: 'providers.provider',
    key: 'lmstudio',
    page: 'models',
    tab: 'providers',
  })
  expect(first('github')).toMatchObject({ id: 'tools.mcpServer', key: 'github', page: 'tools' })
  expect(first('deepgram')).toMatchObject({ id: 'voiceProviders.provider', key: 'deepgram' })
  expect(first('data analyst')).toMatchObject({ id: 'specialists.specialist', key: 's1' })
  expect(first('summarize the repo')).toMatchObject({ id: 'schedules.schedule', key: 'x' })
  // The key a row carries on the page is the one search jumps to.
  expect(itemKey('tools.mcpServer', { name: 'github' } as never)).toBe('github')
})

test('an address naming a page that moved opens where it went', async () => {
  const { sectionFor } = await load()
  expect(sectionFor('verification')).toBe('team')
  expect(sectionFor('voice')).toBe('voice')
  expect(sectionFor('nowhere')).toBeUndefined()
  expect(sectionFor(null)).toBeUndefined()
})
