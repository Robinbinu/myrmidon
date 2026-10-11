import { afterEach, expect, test } from 'bun:test'
import type { ImportableSkill } from '@myrmidon/runtime'
import { importSkills } from '../src/import-skills.ts'
import type { Call, Terminal } from '../src/setup.ts'

const plain = (s: string) => s
const style = { dim: plain, bold: plain, green: plain, red: plain, yellow: plain, cyan: plain }

afterEach(() => {
  process.exitCode = 0
})

function scripted(answers: string[], interactive = true) {
  const out: string[] = []
  const term: Terminal = {
    print: (line = '') => out.push(line),
    ask: async (question) => {
      const next = answers.shift()
      if (next === undefined) throw new Error(`unexpected question: ${question}`)
      return next
    },
    piped: async () => undefined,
    interactive,
    headless: true,
    onInterrupt: () => () => {},
    style,
  }
  return { term, out }
}

const scan = (verdict: 'clean' | 'warn' | 'block') => ({
  verdict,
  findings: [],
  scannedFiles: 1,
  skippedFiles: 0,
  hash: verdict,
})

const skill = (over: Partial<ImportableSkill> & { name: string }): ImportableSkill => ({
  id: `${over.origin ?? 'agents'}:${over.name}`,
  origin: 'agents',
  importAs: over.name,
  description: 'Does a thing',
  dir: `/x/${over.name}`,
  alreadyImported: false,
  scan: scan('clean'),
  ...over,
})

const SKILLS = [
  skill({ name: 'notes', origin: 'claude', alreadyImported: true, importedAs: 'notes' }),
  skill({ name: 'beta', origin: 'claude-plugin', plugin: 'tools', disabledThere: true }),
  skill({ name: 'alpha', importAs: 'alpha-codex' }),
  skill({ name: 'wipe', scan: scan('block') }),
]

function api() {
  const posts: unknown[] = []
  const call: Call = async <T>(method: string, path: string, body?: unknown) => {
    if (method === 'GET' && path === '/api/skill-imports') return { skills: SKILLS } as T
    if (method === 'POST' && path === '/api/skill-imports') {
      posts.push(body)
      const { ids, override = [] } = body as { ids: string[]; override?: string[] }
      const blocked = ids.filter((id) => id.endsWith(':wipe') && !override.includes(id))
      return {
        imported: ids
          .filter((id) => !blocked.includes(id))
          .map((id) => ({ id, name: SKILLS.find((x) => x.id === id)?.importAs })),
        skipped: blocked.map((id) => ({ id, name: 'wipe', reason: 'blocked' })),
      } as T
    }
    throw new Error(`no route ${method} ${path}`)
  }
  return { call, posts }
}

test('with no names it lists the skills with their verdicts and what importing would do', async () => {
  const { call, posts } = api()
  const { term, out } = scripted([])
  await importSkills(call, term, [])
  const text = out.join('\n')
  expect(text).toContain('Claude Code    notes clean  already in Myrmidon as notes')
  expect(text).toContain('beta clean  plugin tools · off there')
  expect(text).toContain('alpha clean  imports as alpha-codex')
  expect(text).toContain('wipe blocked')
  expect(posts).toEqual([])

  const codex = scripted([])
  await importSkills(call, codex.term, [], { from: 'codex' })
  expect(codex.out.join('\n')).not.toContain('notes')
  await expect(importSkills(call, codex.term, [], { from: 'cursor' })).rejects.toThrow('usage')
})

test('named or --all skills import; one the scan blocks needs --force and a typed yes', async () => {
  const named = api()
  const one = scripted([])
  await importSkills(named.call, one.term, ['alpha'])
  expect(named.posts).toEqual([{ ids: ['agents:alpha'] }])
  expect(one.out.join('\n')).toContain('Imported alpha-codex: off until you switch it on')
  await expect(importSkills(named.call, one.term, ['missing'])).rejects.toThrow(
    'no Claude Code or Codex skill',
  )

  const all = api()
  const every = scripted([])
  await importSkills(all.call, every.term, [], { all: true })
  expect(all.posts).toEqual([{ ids: ['claude-plugin:beta', 'agents:alpha', 'agents:wipe'] }])
  expect(every.out.join('\n')).toContain('Not imported wipe: the skill scan blocks it')
  expect(process.exitCode).toBe(1)

  const forced = api()
  const no = scripted(['no'])
  await importSkills(forced.call, no.term, ['wipe'], { force: true })
  expect(forced.posts).toEqual([])
  expect(no.out.join('\n')).toContain('Not imported.')
  const yes = scripted(['yes'])
  await importSkills(forced.call, yes.term, ['wipe'], { force: true })
  expect(forced.posts).toEqual([{ ids: ['agents:wipe'], override: ['agents:wipe'] }])
  await expect(
    importSkills(forced.call, scripted([], false).term, ['wipe'], { force: true }),
  ).rejects.toThrow('nothing is typing here')
})
