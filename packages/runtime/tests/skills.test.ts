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
