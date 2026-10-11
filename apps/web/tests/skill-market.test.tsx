import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act, useState } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const SOURCES = [
  {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://github.com/openai/skills',
    enabled: true,
    optIn: false,
    views: ['all'],
  },
  { id: 'skills.sh', name: 'skills.sh', url: 'https://skills.sh', enabled: true, optIn: false, views: [] },
  {
    id: 'clawhub',
    name: 'ClawHub',
    url: 'https://clawhub.ai',
    enabled: false,
    optIn: true,
    views: ['trending'],
  },
]

const AUDIT = {
  by: 'skills.sh',
  status: 'warn',
  checks: [
    { name: 'Socket', status: 'pass', summary: 'No alerts' },
    { name: 'Snyk', status: 'warn', summary: 'Risk: MEDIUM' },
  ],
}

const PREVIEW = {
  id: 'p1',
  skills: [{ name: 'pdf-reader', description: 'Reads PDFs aloud' }],
  source: 'https://github.com/ada/tools.git (skills/pdf-reader)',
  kind: 'git',
  commit: 'abcdef1',
  files: 1,
  scripts: [],
  warnings: [],
  scan: { verdict: 'clean', findings: [], scannedFiles: 1, skippedFiles: 0, hash: 'h' },
  audit: AUDIT,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  ) as HTMLButtonElement

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await Bun.sleep(10))
}

test('Browse skills searches every source, shows licenses and audits, and opens the review to install', async () => {
  const calls: string[] = []
  let sources = SOURCES
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.pathname === '/api/skill-market') return Response.json({ sources })
    if (url.pathname === '/api/skill-market/sources/clawhub') {
      sources = sources.map((s) => (s.id === 'clawhub' ? { ...s, enabled: true } : s))
      return Response.json({ sources })
    }
    if (url.pathname === '/api/skill-market/search')
      return Response.json({
        hits: [
          {
            source: 'openai',
            id: 'skills/.curated/pdf',
            name: 'pdf',
            description: 'Read and fill PDFs',
            author: 'OpenAI',
            license: 'Apache License',
            installRef: 'openai:skills/.curated/pdf',
          },
          {
            source: 'skills.sh',
            id: 'ada/tools/pdf-reader',
            name: 'pdf-reader',
            description: '',
            author: 'ada',
            installs: 42,
            audit: AUDIT,
            installRef: 'skills.sh:ada/tools/pdf-reader',
          },
        ],
        errors: [{ source: 'omp', error: 'answered 502' }],
      })
    if (url.pathname === '/api/skill-market/install') return Response.json({ preview: PREVIEW })
    if (url.pathname === '/api/skill-installs/p1') return Response.json({ names: ['pdf-reader'], skills: [] })
    return Response.json({})
  }) as unknown as typeof fetch
  const { SkillMarket } = await import('../src/client/skill-market.tsx')
  const { InstallReview } = await import('../src/client/installs.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.skills.market
  const installed: string[] = []
  function Page() {
    const [review, setReview] = useState<Parameters<typeof InstallReview>[0]['review']>()
    return (
      <>
        <SkillMarket installed={[]} onReview={setReview} />
        {review && (
          <InstallReview
            review={review}
            onClose={() => setReview(undefined)}
            onInstalled={() => {
              installed.push('yes')
              setReview(undefined)
            }}
          />
        )}
      </>
    )
  }
  const view = await mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </MotionConfig>,
  )
  await settle()
  // The sources, ClawHub off with its warning, and turning it on.
  expect(document.body.textContent).toContain(t.clawhubWarning)
  const claw = document.querySelector<HTMLButtonElement>(`[aria-label="${t.sourceLabel('ClawHub')}"]`)
  expect(claw?.getAttribute('aria-checked')).toBe('false')
  await act(async () => claw?.click())
  await settle()
  expect(calls).toContain('PUT /api/skill-market/sources/clawhub')
  expect(claw?.getAttribute('aria-checked')).toBe('true')

  await act(async () => buttonNamed(t.openLabel).click())
  await settle()
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${t.searchLabel}"]`)
  expect(field).not.toBeNull()
  // Typed as React hears it here: react-dom listens for key presses on the focused field (live-share.test.tsx).
  await act(async () => {
    field?.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'pdf')
    field?.dispatchEvent(new Event('input', { bubbles: true }))
    field?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'f' }))
  })
  await act(async () => buttonNamed(t.search).click())
  await settle()
  expect(calls).toContain('GET /api/skill-market/search?q=pdf')
  const text = document.body.textContent ?? ''
  expect(text).toContain('Apache License')
  expect(text).toContain(t.auditBadge('skills.sh', t.audit.warn))
  expect(text).toContain(t.installs(42))
  expect(text).toContain(t.failed('Skillshare', 'answered 502'))

  const reviews = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === t.review)
  await act(async () => reviews[1]?.click())
  await settle()
  expect(calls).toContain('POST /api/skill-market/install')
  // The review shows the source's audit beside the scan, and Install confirms it as any install.
  expect(document.body.textContent).toContain(t.auditTitle('skills.sh'))
  expect(document.body.textContent).toContain('Risk: MEDIUM')
  await act(async () => buttonNamed('Install').click())
  await settle()
  expect(calls).toContain('POST /api/skill-installs/p1')
  expect(installed).toEqual(['yes'])
  await view.unmount()
})
