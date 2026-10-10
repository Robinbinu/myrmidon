import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EventPayloads, foldColony } from '@myrmidon/protocol'
import { INSTRUCTIONS_MAX_TEXT, RULE_FILE_MAX_BYTES, RULE_MAX_TEXT } from '../src/config.ts'
import type { ColonyHost } from '../src/host.ts'
import {
  bootRuntime,
  ChatService,
  ModelResolver,
  ProjectStore,
  parseColonySpec,
  readProjectContext,
  readProjectInstructions,
  SettingsStore,
  systemPrompt,
} from '../src/index.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'
import { containedIn, readProjectRules, ruleMatches, splitGlobs } from '../src/rule-files.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let dir: string
let root: string
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}
const mdc = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-rules-'))
  root = join(dir, 'app')
  mkdirSync(root)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const byName = (root: string) => Object.fromEntries(readProjectRules(root).map((r) => [r.name, r]))

test('every kind of rule file reaches the agents the way its tool applies it', () => {
  write('AGENTS.md', 'Root rules.')
  write('GEMINI.md', 'Gemini notes.')
  write('.github/copilot-instructions.md', 'Copilot notes.')
  write('.omp/RULES.md', mdc('alwaysApply: false', 'Sticky omp rule.'))
  write('.cursorrules', 'Legacy cursor rule.')
  write('.windsurfrules', 'Legacy windsurf rule.')
  write('.clinerules/style.md', 'Cline style.')
  write('.cursor/rules/always.mdc', mdc('alwaysApply: true', 'Cursor always.'))
  write('.cursor/rules/ts.mdc', mdc('globs: src/**/*.ts\nalwaysApply: false', 'Cursor TS rule.'))
  write(
    '.cursor/rules/api.mdc',
    mdc('description: How to add an API route\nalwaysApply: false', 'Cursor API.'),
  )
  write('.cursor/rules/manual.mdc', mdc('alwaysApply: false', 'Only when @-mentioned.'))
  write('.windsurf/rules/on.md', mdc('trigger: always_on', 'Windsurf on.'))
  write(
    '.windsurf/rules/decide.md',
    mdc('trigger: model_decision\ndescription: Release steps', 'Windsurf decide.'),
  )
  write('.windsurf/rules/plain.md', 'Windsurf plain.')
  write('.github/instructions/all.instructions.md', mdc("applyTo: '**'", 'Copilot everywhere.'))
  write('.github/instructions/py/py.instructions.md', mdc("applyTo: '**/*.py'", 'Copilot Python.'))
  write('.github/instructions/loose.instructions.md', 'Copilot without applyTo.')
  write('.github/instructions/README.md', 'Not an instructions file.')
  write('.continue/rules/c.md', 'Continue rule.')
  write('.claude/rules/tests.md', mdc('paths:\n  - "tests/**"', 'Claude test rule.'))

  const found = readProjectInstructions(root)
  expect(found?.files).toEqual([
    'AGENTS.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
    '.omp/RULES.md',
    '.cursor/rules/always.mdc',
    '.cursorrules',
    '.windsurf/rules/on.md',
    '.windsurf/rules/plain.md',
    '.windsurfrules',
    '.continue/rules/c.md',
    '.clinerules/style.md',
    '.github/instructions/all.instructions.md',
  ])
  for (const text of ['Sticky omp rule.', 'Legacy cursor rule.', 'Cline style.', 'Copilot everywhere.'])
    expect(found?.text).toContain(text)
  expect(found?.text).toContain('----- .cursor/rules/always.mdc -----\nCursor always.')
  // Frontmatter stays out of the text agents get.
  expect(found?.text).not.toContain('alwaysApply')
  expect(found?.text).not.toContain('Only when @-mentioned.')

  expect(found?.rules.map((r) => [r.name, r.mode, r.globs ?? [], r.description ?? '', r.file])).toEqual([
    ['tests', 'glob', ['tests/**'], '', '.claude/rules/tests.md'],
    ['api', 'requested', [], 'How to add an API route', '.cursor/rules/api.mdc'],
    ['ts', 'glob', ['src/**/*.ts'], '', '.cursor/rules/ts.mdc'],
    ['decide', 'requested', [], 'Release steps', '.windsurf/rules/decide.md'],
    [
      'loose',
      'requested',
      [],
      'GitHub Copilot instructions without applyTo metadata',
      '.github/instructions/loose.instructions.md',
    ],
    [
      'py',
      'glob',
      ['**/*.py'],
      'GitHub Copilot instructions for **/*.py',
      '.github/instructions/py/py.instructions.md',
    ],
  ])
})

test('mdc frontmatter: comma lists, YAML lists, bare globs, braces, switched-off and empty rules', () => {
  write('.cursor/rules/csv.mdc', mdc('globs: src/**/*.ts, lib/*.js', 'csv'))
  write('.cursor/rules/list.mdc', mdc('globs:\n  - "*.md"\n  - docs/**', 'list'))
  // `*.ts` is a YAML alias, so YAML fails; omp's line-by-line fallback keeps it as written.
  write('.cursor/rules/bare.mdc', mdc('globs: *.ts', 'bare'))
  write('.cursor/rules/brace.mdc', mdc('globs: "src/**/*.{ts,tsx}"\ndescription: React files', 'brace'))
  write('.cursor/rules/both.mdc', mdc('globs: "*.css"\nalwaysApply: true', 'both'))
  write('.cursor/rules/off.mdc', mdc('alwaysApply: true\nenabled: false', 'off'))
  write('.cursor/rules/empty.mdc', mdc('alwaysApply: true', ''))
  write('.cursor/rules/kebab.mdc', mdc('always-apply: true', 'kebab'))
  const rules = byName(root)
  expect(rules.csv?.globs).toEqual(['src/**/*.ts', 'lib/*.js'])
  expect(rules.list?.globs).toEqual(['*.md', 'docs/**'])
  expect(rules.bare?.globs).toEqual(['*.ts'])
  expect(rules.brace).toMatchObject({
    mode: 'glob',
    globs: ['src/**/*.{ts,tsx}'],
    description: 'React files',
  })
  // alwaysApply wins over globs, as in Cursor.
  expect(rules.both?.mode).toBe('always')
  expect(rules.kebab?.mode).toBe('always')
  expect(rules.off).toBeUndefined()
  expect(rules.empty).toBeUndefined()

  expect(splitGlobs(' ./src/a.ts , /lib/** ')).toEqual(['src/a.ts', 'lib/**'])
  const rule = { name: 'r', file: 'f', mode: 'glob' as const, text: '' }
  expect(ruleMatches({ ...rule, globs: ['*.ts'] }, 'src/deep/a.ts')).toBe(true)
  expect(ruleMatches({ ...rule, globs: ['src/*.ts'] }, 'lib/src/a.ts')).toBe(false)
  expect(ruleMatches({ ...rule, globs: ['src/**/*.{ts,tsx}'] }, 'src/ui/x.tsx')).toBe(true)
})

test('a rule named in two tools is read once, and a copy of AGENTS.md adds nothing', () => {
  write('AGENTS.md', '# Rules\n\nUse tabs.\n\nRun the tests.')
  write('.cursorrules', 'Use tabs.\n\nRun the tests.')
  write('.cursor/rules/style.mdc', mdc('alwaysApply: true', 'Cursor style.'))
  write('.windsurf/rules/style.md', mdc('trigger: always_on', 'Windsurf style.'))
  const found = readProjectInstructions(root)
  expect(found?.files).toEqual(['AGENTS.md', '.cursor/rules/style.mdc'])
  expect(found?.text).not.toContain('Windsurf style.')
  expect(containedIn('a\n\nb\n\nc', 'b\n\nc')).toBe(true)
  expect(containedIn('a\n\nb', 'b\n\na')).toBe(false)
  // A paragraph that only appears inside a code example is not a repeat.
  expect(containedIn('```\nUse tabs.\n```', 'Use tabs.')).toBe(false)
})

test('size limits: an oversized rule file is skipped, and the always-apply text is cut at the cap', () => {
  write('.cursor/rules/huge.mdc', mdc('alwaysApply: true', 'x'.repeat(RULE_FILE_MAX_BYTES)))
  expect(byName(root).huge).toBeUndefined()
  rmSync(join(root, '.cursor'), { recursive: true })
  write('.clinerules', 'y'.repeat(INSTRUCTIONS_MAX_TEXT))
  write('AGENTS.md', 'Short.')
  const found = readProjectInstructions(root)
  expect(found?.files).toEqual(['AGENTS.md', '.clinerules'])
  expect(found?.truncated).toBe(true)
  expect(found?.text.endsWith('…[cut at 24 KB]')).toBe(true)
})

test('rule files that lead out of the project are not read', () => {
  writeFileSync(join(dir, 'secret.md'), 'OUTSIDE THE PROJECT')
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true })
  symlinkSync(join(dir, 'secret.md'), join(root, '.cursor', 'rules', 'leak.mdc'))
  symlinkSync(join(dir, 'secret.md'), join(root, '.cursorrules'))
  mkdirSync(join(root, '.github'))
  symlinkSync(join(dir, 'secret.md'), join(root, '.github', 'copilot-instructions.md'))
  expect(readProjectInstructions(root)).toBeUndefined()
})

test('a project without other tools’ rule files reads as before', () => {
  write('AGENTS.md', 'Run bun test before you finish.')
  write('CLAUDE.md', '@AGENTS.md\n')
  const found = readProjectInstructions(root)
  expect(found).toEqual({
    files: ['AGENTS.md'],
    text: '----- AGENTS.md -----\nRun bun test before you finish.',
    nested: [],
    truncated: false,
    rules: [],
  })
  const spec = parseColonySpec({ name: 'T', mission: 'm', agents: [{ name: 'lead', model: 'x/y' }] })
  const chatSpec = {
    ...spec,
    tier: 'solo' as const,
    chat: {
      chatId: 'c',
      round: 1,
      request: 'r',
      history: '',
      project: { id: 'app', name: 'app', path: root },
    },
  }
  const prompt = systemPrompt(chatSpec, spec.agents[0] as never, {
    sandbox: 'sandbox-exec',
    web: false,
    browser: false,
    project: readProjectContext(root),
  }).join('\n')
  expect(prompt).not.toContain('<project_rules>')
})

test('agents get always-apply rules in their instructions and the others listed by name', () => {
  write('.cursor/rules/always.mdc', mdc('alwaysApply: true', 'Prefer named exports.'))
  write('.cursor/rules/ts.mdc', mdc('globs: src/**/*.ts', 'TS rule.'))
  write('.cursor/rules/api.mdc', mdc('description: Adding an API route', 'API rule.'))
  const spec = parseColonySpec({ name: 'T', mission: 'm', agents: [{ name: 'lead', model: 'x/y' }] })
  const chatSpec = {
    ...spec,
    tier: 'solo' as const,
    chat: {
      chatId: 'c',
      round: 1,
      request: 'r',
      history: '',
      project: { id: 'app', name: 'app', path: root },
    },
  }
  const prompt = systemPrompt(chatSpec, spec.agents[0] as never, {
    sandbox: 'sandbox-exec',
    web: false,
    browser: false,
    project: readProjectContext(root),
  }).join('\n')
  expect(prompt).toContain('<project_instructions source=".cursor/rules/always.mdc">')
  expect(prompt).toContain('Prefer named exports.')
  expect(prompt).toContain('- ts (src/**/*.ts) [.cursor/rules/ts.mdc]')
  expect(prompt).toContain('- api: Adding an API route [.cursor/rules/api.mdc]')
  expect(prompt).toContain('fs_read one whose description fits your task first')
  // Their text waits until it applies.
  expect(prompt).not.toContain('TS rule.')
  expect(prompt).not.toContain('API rule.')
})

test('a file-scoped rule comes with the first matching file an agent reads or edits, once', async () => {
  write('.cursor/rules/ts.mdc', mdc('globs: src/**/*.ts', 'Use strict types.'))
  write(
    '.github/instructions/long.instructions.md',
    mdc("applyTo: '**/*.md'", 'z'.repeat(RULE_MAX_TEXT + 10)),
  )
  write('src/a.ts', 'export const a = 1\n')
  write('src/b.ts', 'export const b = 2\n')
  write('notes.md', 'notes\n')
  write('other.txt', 'plain\n')
  const base = realpathSync.native(root)
  // Enough of a round for the file tools: edits in the project are allowed outright.
  const host = {
    project: readProjectContext(root),
    spec: { chat: { project: { name: 'app', path: base } } },
    state: () => ({ rounds: [] }),
    permit: () => ({ decision: 'allow' }),
    workspace: {
      project: base,
      isolation: () => undefined,
      scratch: () => join(dir, 'scratch'),
      workdir: () => base,
      resolveForRead: (_: string, p: string) => join(base, p),
      resolveInWorkdir: (_: string, p: string) => join(base, p),
    },
  } as unknown as ColonyHost
  const read = TOOL_DEFS.find((d) => d.name === 'fs_read')
  const first = String(await read?.run({ path: 'src/a.ts' }, 'kai', host))
  expect(first).toStartWith('export const a = 1\n')
  expect(first).toContain('<project_rule name="ts">\nUse strict types.\n</project_rule>')
  expect(first).toContain('(.cursor/rules/ts.mdc) applies to src/**/*.ts')
  // The same agent is not told twice; another agent is told once too.
  expect(String(await read?.run({ path: 'src/b.ts' }, 'kai', host))).not.toContain('project_rule')
  expect(String(await read?.run({ path: 'src/b.ts' }, 'ana', host))).toContain('<project_rule name="ts">')
  expect(String(await read?.run({ path: 'other.txt' }, 'kai', host))).toBe('plain\n')
  // A long rule is cut and points at its file.
  const md = String(await read?.run({ path: 'notes.md' }, 'kai', host))
  expect(md).toContain('…[cut; the rest is in .github/instructions/long.instructions.md]')
  expect(md.length).toBeLessThan(RULE_MAX_TEXT + 500)
  // Editing a matching file brings the rule too.
  const edit = TOOL_DEFS.find((d) => d.name === 'fs_edit')
  const edited = String(await edit?.run({ path: 'src/b.ts', old: '2', new: '3' }, 'eve', host))
  expect(edited).toStartWith('edited src/b.ts (1 replacement)')
  expect(edited).toContain('<project_rule name="ts">')
  const wrote = TOOL_DEFS.find((d) => d.name === 'fs_write')
  expect(String(await wrote?.run({ path: 'src/c.ts', content: 'x' }, 'eve', host))).toBe(
    'wrote src/c.ts (1 bytes)',
  )
})

test("a round in a project gives its agent the project's rules and says which files they came from", async () => {
  write('.cursorrules', 'Answer in British English.')
  write('.cursor/rules/ts.mdc', mdc('globs: "**/*.ts"', 'Never use any.'))
  write('src/a.ts', 'export {}\n')
  const home = join(dir, 'home')
  mkdirSync(home)
  const runtime = await bootRuntime(home)
  try {
    const resolver = new ModelResolver()
    const prompts: string[] = []
    const script: MockContent[][] = [
      [{ type: 'toolCall', name: 'fs_read', arguments: { path: 'src/a.ts' } }],
      [{ type: 'toolCall', name: 'reply_user', arguments: { text: 'Read it.', final: true } }],
    ]
    const lead = createMockModel({
      handler: (ctx) => {
        prompts.push([ctx.systemPrompt ?? []].flat().join('\n'))
        return { content: script[prompts.length - 1] ?? ['ok'] }
      },
    })
    resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
    const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
    resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
    const projects = new ProjectStore(home)
    const project = projects.add(realpathSync.native(root))
    const chats = new ChatService(runtime, { resolver, settings: new SettingsStore(home), projects })
    const config = {
      mode: 'orchestrated' as const,
      leadModel: 'mock/lead',
      roster: [],
      judgeModel: 'mock/judge',
    }
    const { colonyId } = await chats.send('Read src/a.ts', config, undefined, { project: project.id })
    const events = () => runtime.ctx.log.read(colonyId as never)
    for (let i = 0; i < 400; i++) {
      const st = foldColony(colonyId, await events())
      if (st.status !== 'running' && st.status !== 'created') break
      await Bun.sleep(50)
    }
    await chats.stopAll()
    const all = await events()
    const started = all.find((e) => e.type === 'colony/started')?.payload as EventPayloads['colony/started']
    expect(started.rules).toEqual(['.cursorrules', '.cursor/rules/ts.mdc'])
    expect(prompts[0]).toContain('Answer in British English.')
    expect(prompts[0]).toContain('- ts (**/*.ts) [.cursor/rules/ts.mdc]')
    const read = all
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
      .find((r) => r.tool === 'fs_read')
    expect(read?.output).toContain('<project_rule name="ts">\nNever use any.\n</project_rule>')
  } finally {
    await runtime.dispose()
  }
})
