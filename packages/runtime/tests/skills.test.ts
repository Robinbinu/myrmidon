import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillFile, SkillLibrary } from '../src/skills.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-skills-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const skill = (root: string, name: string, description: string, body = 'Do it well.') => {
  mkdirSync(join(root, name, 'scripts'), { recursive: true })
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  )
  writeFileSync(join(root, name, 'scripts', 'run.sh'), 'echo hi\n')
}

test('skills come from Myrmidon, the person and the project, read progressively and switch off', () => {
  const home = join(dir, 'home')
  const claude = join(dir, 'claude')
  const project = join(dir, 'project')
  skill(join(home, 'skills'), 'release-notes', 'Write release notes from merged changes.')
  skill(claude, 'release-notes', 'A second one with the same name loses to Myrmidon’s own.')
  skill(claude, 'pdf-forms', 'Fill PDF forms.')
  skill(join(project, '.claude', 'skills'), 'deploy', 'How this project deploys.', 'Run scripts/run.sh.')
  mkdirSync(join(claude, 'broken'))
  writeFileSync(join(claude, 'broken', 'SKILL.md'), 'no front matter')

  const library = new SkillLibrary(home, claude)
  expect(library.list().map((s) => [s.name, s.source])).toEqual([
    ['pdf-forms', 'claude'],
    ['release-notes', 'myrmidon'],
  ])
  expect(library.list(project).map((s) => s.name)).toEqual(['deploy', 'pdf-forms', 'release-notes'])

  const text = library.read('deploy', project)
  expect(text).toContain('Run scripts/run.sh.')
  expect(text).toContain('- scripts/run.sh')
  expect(library.read('deploy', project, 'scripts/run.sh')).toBe('echo hi\n')
  expect(() => library.read('deploy', project, '../../home/skills/release-notes/SKILL.md')).toThrow('outside')

  library.setEnabled('pdf-forms', false)
  expect(library.list().find((s) => s.name === 'pdf-forms')?.enabled).toBe(false)
  expect(() => library.read('pdf-forms')).toThrow('no skill')
})

test('a SKILL.md needs a valid name and a description', () => {
  expect(parseSkillFile('---\nname: Bad Name\ndescription: x\n---\nbody')).toBeUndefined()
  expect(parseSkillFile('---\nname: ok\n---\nbody')).toBeUndefined()
  // An unquoted colon breaks strict YAML; other harnesses accept it, so Myrmidon does too.
  expect(
    parseSkillFile('---\nname: notes\ndescription: Use for notes. Trigger on: "note this"\n---\nbody'),
  ).toEqual({
    name: 'notes',
    description: 'Use for notes. Trigger on: "note this"',
    body: 'body',
  })
  expect(parseSkillFile('---\nname: ok\ndescription: >-\n  folded\n  text\n---\nbody')).toEqual({
    name: 'ok',
    description: 'folded text',
    body: 'body',
  })
})

test('learned skills nobody uses go stale, then to the archive; using, keeping or restoring one saves it', () => {
  const home = join(dir, 'home')
  const claude = join(dir, 'claude')
  skill(claude, 'pdf-forms', 'Fill PDF forms.')
  const library = new SkillLibrary(home, claude)
  const day = 24 * 60 * 60_000
  const t0 = Date.parse('2026-01-01T00:00:00Z')
  library.write('weekly-report', 'Write the weekly report.', 'Steps.', t0)
  library.write('old-habit', 'Something done once.', 'Steps.', t0)
  library.write('kept-one', 'Rare but wanted.', 'Steps.', t0)
  library.setKept('kept-one', true)

  // Using a skill counts it and resets its clock.
  library.noteUse('weekly-report', t0 + 20 * day)
  const at = (now: number) =>
    Object.fromEntries(library.list(undefined, now).map((s) => [s.name, s.curation]))
  expect(at(t0 + 35 * day)).toMatchObject({
    'weekly-report': { uses: 1, stale: false, kept: false },
    'old-habit': { uses: 0, stale: true },
    'kept-one': { stale: false, kept: true },
    // Skills the person wrote or installed are never curated.
    'pdf-forms': undefined,
  })
  // Stale skills stay usable; past the archive age they are moved out, never deleted.
  expect(library.read('old-habit')).toContain('Steps.')
  expect(library.curate(t0 + 95 * day)).toEqual(['old-habit'])
  expect(library.list(undefined, t0 + 95 * day).map((s) => s.name)).toEqual([
    'kept-one',
    'pdf-forms',
    'weekly-report',
  ])
  expect(library.archived()).toEqual([{ name: 'old-habit', description: 'Something done once.' }])
  expect(library.curate(t0 + 115 * day)).toEqual(['weekly-report'])

  // Restored, a skill starts a fresh clock and is not archived again at once.
  library.restore('old-habit', t0 + 120 * day)
  expect(library.curate(t0 + 121 * day)).toEqual([])
  expect(library.list(undefined, t0 + 121 * day).find((s) => s.name === 'old-habit')?.curation).toMatchObject(
    {
      stale: false,
      uses: 0,
    },
  )
  expect(() => library.restore('nothing-here')).toThrow('no archived skill called nothing-here')
})
