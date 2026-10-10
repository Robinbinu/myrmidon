import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pendingOn } from '../../../tests/platform.ts'
import { parseColonySpec, readProjectContext, readProjectInstructions, systemPrompt } from '../src/index.ts'

let dir: string
let root: string
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-instr-'))
  root = join(dir, 'app')
  mkdirSync(root)
  writeFileSync(join(dir, 'secret.md'), 'OUTSIDE THE PROJECT')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a folder without instruction files has none', () => {
  write('src/index.ts', 'export {}')
  expect(readProjectInstructions(root)).toBeUndefined()
})

pendingOn('win32', 'osSeparatorsInText')(
  'AGENTS.md is read with its imports; the CLAUDE.md bridge adds nothing; nested files are listed',
  () => {
    write('AGENTS.md', '# Rules\nUse tabs.\n@docs/style.md\n@../secret.md\n')
    write('docs/style.md', 'Prefer small functions.')
    write('CLAUDE.md', '@AGENTS.md\n')
    write('packages/api/AGENTS.md', 'API rules')
    write('node_modules/lib/AGENTS.md', 'not ours')
    const found = readProjectInstructions(root)
    expect(found?.files).toEqual(['AGENTS.md'])
    expect(found?.text).toContain('Use tabs.')
    expect(found?.text).toContain('Prefer small functions.')
    // An import outside the project stays as written and is not read.
    expect(found?.text).toContain('@../secret.md')
    expect(found?.text).not.toContain('OUTSIDE THE PROJECT')
    expect(found?.nested).toEqual(['packages/api/AGENTS.md'])
  },
)

test('agents in a project chat get the instructions and a shell that starts in the project', () => {
  write('AGENTS.md', 'Run bun test before you finish.')
  const spec = parseColonySpec({ name: 'T', mission: 'm', agents: [{ name: 'lead', model: 'x/y' }] })
  const project = { id: 'app', name: 'app', path: root }
  const chatSpec = {
    ...spec,
    tier: 'solo' as const,
    chat: { chatId: 'chat-a', round: 1, request: 'r', history: '', project },
  }
  write('package.json', '{"scripts": {"test": "bun test", "lint": "biome check ."}}')
  write('bun.lock', '')
  write('src/app/main.ts', 'export {}')
  const prompt = systemPrompt(chatSpec, spec.agents[0] as never, {
    sandbox: 'sandbox-exec',
    web: false,
    browser: false,
    project: readProjectContext(root),
  }).join('\n')
  expect(prompt).toContain('<project_instructions source="AGENTS.md">')
  expect(prompt).toContain('Run bun test before you finish.')
  expect(prompt).toContain('commands start in the project folder')
  expect(prompt).not.toContain('commands start in your scratch directory')
  expect(prompt).toContain('Project checks: lint `bun run lint`, test `bun run test`')
  expect(prompt).toContain('src/ (1 file)\n  src/app/ (1 file)')
})
