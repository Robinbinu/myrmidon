import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { ImportableSkillView } from '../src/client/skill-import.tsx'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const scan = (verdict: 'clean' | 'warn' | 'block') => ({
  verdict,
  findings: [],
  scannedFiles: 1,
  skippedFiles: 0,
  hash: verdict,
})

const skill = (over: Partial<ImportableSkillView>): ImportableSkillView => ({
  id: over.name ?? 'x',
  origin: 'agents',
  name: 'x',
  importAs: over.name ?? 'x',
  description: 'Does a thing well',
  dir: '/x',
  alreadyImported: false,
  scan: scan('clean'),
  ...over,
})

const SKILLS = [
  skill({ name: 'notes', origin: 'claude', alreadyImported: true, importedAs: 'notes' }),
  skill({ name: 'beta', origin: 'claude-plugin', plugin: 'tools', disabledThere: true }),
  skill({ name: 'alpha', importAs: 'alpha-codex', displayName: 'Alpha', requires: ['openaiDeveloperDocs'] }),
  skill({ name: 'wipe', scan: scan('block') }),
]

test('the picker groups skills by where they are, shows their scan, and imports the ones picked', async () => {
  const posted: unknown[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/api/skill-imports') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { ids: string[] }
      posted.push(body)
      return Response.json({
        imported: body.ids.map((id) => ({ id, name: id === 'alpha' ? 'alpha-codex' : id })),
        skipped: [],
      })
    }
    return Response.json({ skills: SKILLS })
  }) as unknown as typeof fetch
  const { ImportSkillsSheet } = await import('../src/client/skill-import.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.skillImports
  let imported = 0
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <ImportSkillsSheet onClose={() => {}} onImported={() => imported++} />
      </ToastProvider>
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  const text = () => doc.body.textContent ?? ''
  const box = (name: string) => doc.querySelector<HTMLInputElement>(`input[aria-label="${t.pick(name)}"]`)
  const button = (label: string) =>
    [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  try {
    await act(async () => Bun.sleep(20))
    for (const heading of [t.origins.claude, t.origins['claude-plugin'], t.origins.agents])
      expect(text()).toContain(heading)
    expect(text()).toContain(t.already)
    expect(text()).toContain(t.offThere.claude)
    expect(text()).toContain(t.plugin('tools'))
    expect(text()).toContain(t.renamed('alpha-codex'))
    expect(text()).toContain(t.needs(['openaiDeveloperDocs']))
    expect(text()).toContain(t.verdict.block)
    // Already here, and blocked by its scan: not picked with the others; the blocked one has its own "anyway".
    expect(box('notes')?.disabled).toBe(true)
    expect(box('wipe')?.disabled).toBe(true)
    expect(button(t.importAnyway)).toBeDefined()
    expect(button(t.import(0))?.disabled).toBe(true)

    await act(async () => box('alpha')?.click())
    expect(button(t.import(1))?.disabled).toBe(false)
    await act(async () => {
      button(t.import(1))?.click()
      await Bun.sleep(20)
    })
    expect(posted).toEqual([{ ids: ['alpha'] }])
    expect(imported).toBe(1)
    expect(text()).toContain(t.imported(['alpha-codex']))
  } finally {
    await unmount()
  }
})
