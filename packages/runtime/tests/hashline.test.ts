import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_SUMMARY_MIN_LINES } from '../src/config.ts'
import { editModeFor, lineChange, setEditMode } from '../src/hashline.ts'
import type { ColonyHost, ReviewDecision } from '../src/host.ts'
import { prompts } from '../src/prompts.ts'
import { TOOL_DEFS, toolParameters } from '../src/tools.ts'

let dir: string
let base: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-hashline-'))
  base = realpathSync.native(dir)
  mkdirSync(join(base, 'scratch'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const def = (name: string) => {
  const d = TOOL_DEFS.find((t) => t.name === name)
  if (!d) throw new Error(`no ${name}`)
  return d
}
const read = (args: Record<string, unknown>, host: ColonyHost) => def('fs_read').run(args, 'kai', host)
const edit = async (args: Record<string, unknown>, host: ColonyHost) => {
  const out = await def('fs_edit').run(args, 'kai', host)
  return typeof out === 'string' ? { text: out } : out
}

/** Enough of a round for the file tools, in a project, with each change decided by `decide` (allowed by default). */
function hostWith(decide?: (after: string) => ReviewDecision): ColonyHost {
  const host = {
    spec: { chat: { project: { name: 'app', path: base } } },
    state: () => ({ rounds: [], receipts: {}, approvals: {} }),
    permit: () => ({ decision: decide ? 'ask' : 'allow', source: { by: 'preset' } }),
    reviewChange: async (
      _a: string,
      _t: string,
      _s: string,
      req: { review: { fields: { value?: string }[] } },
    ) => decide?.(String(req.review.fields[0]?.value ?? '')) ?? { approved: true },
    workspace: {
      project: base,
      isolation: () => undefined,
      scratch: () => join(base, 'scratch'),
      workdir: () => base,
      resolveForRead: (_: string, p: string) => join(base, p),
      resolveInWorkdir: (_: string, p: string) => join(base, p),
    },
  } as unknown as ColonyHost
  setEditMode(host, 'kai', 'hashline')
  return host
}

const tagOf = (text: unknown, file: string) => {
  const m = new RegExp(`\\[${file.replace('.', '\\.')}#([0-9A-F]{4})\\]`).exec(String(text))
  if (!m) throw new Error(`no header for ${file} in ${String(text)}`)
  return m[1] as string
}

const FILE = 'const a = 1\nfunction f() {\n  return a\n}\nconst b = 2\n'

test("fs_edit's mode follows omp's per-model choice: hashline, except the models omp gives replace", () => {
  for (const ref of ['anthropic/claude-sonnet-5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'mock/solo'])
    expect(editModeFor(ref)).toBe('hashline')
  for (const ref of [
    'deepseek/deepseek-v4',
    'openrouter/moonshotai/kimi-k2',
    'minimax/minimax-m2',
    'xiaomi/mimo-v2',
    'stepfun/step-3',
    'openai/gpt-5.3-codex-spark',
    'zai/glm-5.3-flash',
  ])
    expect(editModeFor(ref)).toBe('replace')
  // Only GLM 5.3 Flash: other GLMs keep hashline, as in omp.
  expect(editModeFor('zai/glm-5.1')).toBe('hashline')
})

test('a hashline agent reads anchored rows and edits by line number; the reply carries the new header', async () => {
  writeFileSync(join(base, 'a.ts'), FILE)
  const host = hostWith()
  const shown = String(await read({ path: 'a.ts' }, host))
  const tag = tagOf(shown, 'a.ts')
  expect(shown).toBe(`[a.ts#${tag}]\n1:const a = 1\n2:function f() {\n3:  return a\n4:}\n5:const b = 2`)
  const out = await edit({ path: 'a.ts', input: `[a.ts#${tag}]\nPUT 3.=3:\n+  return a + 1\n` }, host)
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(FILE.replace('return a', 'return a + 1'))
  const next = tagOf(out.text, 'a.ts')
  expect(next).not.toBe(tag)
  expect(out.text).toContain('3:  return a + 1')
  // The person's diff: the lines around the change, before and after.
  expect('change' in out && out.change).toEqual({
    before: 'const a = 1\nfunction f() {\n  return a\n}\nconst b = 2',
    after: 'const a = 1\nfunction f() {\n  return a + 1\n}\nconst b = 2',
  })
  // The next edit takes the reply's header without reading again.
  await edit({ path: 'a.ts', input: `[a.ts#${next}]\nPUT >$:\n+const c = 3\n` }, host)
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toEndWith('const b = 2\nconst c = 3\n')
})

test('a stale anchor is refused: the file changed elsewhere on the lines the edit touches', async () => {
  writeFileSync(join(base, 'a.ts'), FILE)
  const host = hostWith()
  const tag = tagOf(await read({ path: 'a.ts' }, host), 'a.ts')
  const changed = FILE.replace('const b = 2', 'const b = 7')
  writeFileSync(join(base, 'a.ts'), changed)
  const stale = edit({ path: 'a.ts', input: `[a.ts#${tag}]\nPUT 5.=5:\n+const b = 3\n` }, host)
  expect(stale).rejects.toThrow('file changed between read and edit')
  await stale.catch(() => {})
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(changed)
  // A tag never shown in this round is refused too.
  expect(edit({ path: 'a.ts', input: '[a.ts#ABCD]\nPUT 5.=5:\n+const b = 3\n' }, host)).rejects.toThrow(
    'is not from this session',
  )
})

test('an edit on lines no read showed is refused with what they hold; a ranged read shows only its lines', async () => {
  writeFileSync(join(base, 'a.ts'), FILE)
  const host = hostWith()
  const shown = String(await read({ path: 'a.ts', offset: 1, limit: 2 }, host))
  const tag = tagOf(shown, 'a.ts')
  expect(shown).toBe(
    `[a.ts#${tag}]\n(lines 1-2 of 5)\n1:const a = 1\n2:function f() {\n… lines 3-5 not shown: fs_read with offset: 3 reads on.`,
  )
  expect(edit({ path: 'a.ts', input: `[a.ts#${tag}]\nPUT 5.=5:\n+const b = 3\n` }, host)).rejects.toThrow(
    'never displayed',
  )
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(FILE)
})

test('fs_edit keeps its guards with anchors: one file named by path, no deletes or moves, the person decides', async () => {
  writeFileSync(join(base, 'a.ts'), FILE)
  writeFileSync(join(base, 'b.ts'), 'x\n')
  const host = hostWith()
  const tag = tagOf(await read({ path: 'a.ts' }, host), 'a.ts')
  expect(edit({ path: 'a.ts', input: 'PUT 1.=1:\n+x\n' }, host)).rejects.toThrow(
    'must start with the [a.ts#TAG]',
  )
  expect(edit({ path: 'b.ts', input: `[a.ts#${tag}]\nPUT 1.=1:\n+x\n` }, host)).rejects.toThrow(
    'the header names a.ts, not b.ts',
  )
  expect(edit({ path: 'a.ts', input: `[a.ts#${tag}]\nREM\n` }, host)).rejects.toThrow('delete or move one')
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(FILE)

  // Turned down: nothing is written, and the decline is what the agent reads.
  const declining = hostWith(() => ({ approved: false, note: 'not now' }))
  const t1 = tagOf(await read({ path: 'a.ts' }, declining), 'a.ts')
  expect(edit({ path: 'a.ts', input: `[a.ts#${t1}]\nPUT 1.=1:\n+const a = 9\n` }, declining)).rejects.toThrow(
    'not now',
  )
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(FILE)

  // Rewritten by the person: their version is written, and the agent is told to read it back.
  const rewriting = hostWith((after) => ({ approved: true, edits: { content: `${after}// checked\n` } }))
  const t2 = tagOf(await read({ path: 'a.ts' }, rewriting), 'a.ts')
  const out = await edit({ path: 'a.ts', input: `[a.ts#${t2}]\nPUT 1.=1:\n+const a = 9\n` }, rewriting)
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(`${FILE.replace('a = 1', 'a = 9')}// checked\n`)
  expect(out.text).toContain('The person edited this before approving')
})

test('a replace-mode agent keeps exact text edits, plain reads and its old parameters', async () => {
  writeFileSync(join(base, 'a.ts'), FILE)
  const host = hostWith()
  setEditMode(host, 'kai', 'replace')
  expect(await read({ path: 'a.ts' }, host)).toBe(FILE)
  expect((await edit({ path: 'a.ts', old: 'b = 2', new: 'b = 3' }, host)).text).toStartWith('edited a.ts')
  expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(FILE.replace('b = 2', 'b = 3'))
  expect(Object.keys((toolParameters('fs_edit') as { properties: object }).properties)).toEqual([
    'path',
    'old',
    'new',
    'all',
  ])
})

test('fs_write in hashline mode gives the new tag, so the file it wrote can be edited by line', async () => {
  const host = hostWith()
  const wrote = String(await def('fs_write').run({ path: 'n.ts', content: 'one\ntwo\n' }, 'kai', host))
  const tag = tagOf(wrote, 'n.ts')
  expect(wrote).toContain(`[n.ts#${tag}] is its header for fs_edit, its lines numbered from 1`)
  await edit({ path: 'n.ts', input: `[n.ts#${tag}]\nPUT 2.=2:\n+TWO\n` }, host)
  expect(readFileSync(join(base, 'n.ts'), 'utf8')).toBe('one\nTWO\n')
})

test("the engine's numbered diff becomes before and after text, a gap between hunks marked", () => {
  expect(lineChange(' 2|a\n-3|b\n+3|B\n 4|c\n 9|x\n-10|y\n+10|Y')).toEqual({
    before: 'a\nb\nc\n…\nx\ny',
    after: 'a\nB\nc\n…\nx\nY',
  })
})

/** A TypeScript file long enough to be summarized: functions whose bodies fold. */
function longSource(): string {
  const parts: string[] = []
  for (let i = 0; parts.join('\n').split('\n').length < READ_SUMMARY_MIN_LINES + 20; i++)
    parts.push(
      `/** Adds ${i}. */\nexport function add${i}(x: number): number {\n  const y = x + ${i}\n  const z = y * 2\n  const w = z - 1\n  return w\n}\n`,
    )
  return parts.join('\n')
}

test('a long source file read whole comes back as its structure first; offset reads its lines', async () => {
  const code = longSource()
  writeFileSync(join(base, 'long.ts'), code)
  writeFileSync(join(base, 'long.md'), code)
  const plain = hostWith()
  setEditMode(plain, 'kai', 'replace')
  const summary = String(await read({ path: 'long.ts' }, plain))
  const total = code.split('\n').length - 1
  expect(summary).toStartWith(`(structure of ${total} lines: bodies folded to …)\n1|/** Adds 0. */\n`)
  expect(summary).toContain('2-7|export function add0(x: number): number { … }')
  expect(summary).toMatch(
    /\[\d+ lines folded; read the ranges you need with offset and limit, e\.g\. offset: 2, limit: 6\]$/,
  )
  expect(summary.length).toBeLessThan(code.length)
  expect(String(await read({ path: 'long.ts', offset: 2, limit: 6 }, plain))).toContain('  const y = x + 0')
  // Prose reads whole.
  expect(String(await read({ path: 'long.md' }, plain))).not.toContain('structure of')

  // With anchors: the header, the shown lines recorded; a folded line is refused, a kept one edits.
  const host = hostWith()
  const anchored = String(await read({ path: 'long.ts' }, host))
  const tag = tagOf(anchored, 'long.ts')
  expect(anchored).toStartWith(`[long.ts#${tag}]\n1:/** Adds 0. */\n2-7:export function add0`)
  expect(
    edit({ path: 'long.ts', input: `[long.ts#${tag}]\nPUT 3.=3:\n+  const y = x\n` }, host),
  ).rejects.toThrow('never displayed')
  await edit({ path: 'long.ts', input: `[long.ts#${tag}]\nPUT 1.=1:\n+/** Adds zero. */\n` }, host)
  expect(readFileSync(join(base, 'long.ts'), 'utf8')).toStartWith('/** Adds zero. */\nexport function add0')
})

test("the example in fs_edit's description is an edit the engine applies", async () => {
  const description = prompts.tools.fs_edit.anchored.description({ where: 'scratch' } as never)
  const example = description.split('Example:\n')[1] ?? ''
  mkdirSync(join(base, 'src'))
  writeFileSync(join(base, 'src/greet.py'), 'def greet(name):\n    """Say hello."""\n    print(name)\n')
  const host = hostWith()
  const tag = tagOf(await read({ path: 'src/greet.py' }, host), 'src/greet.py')
  await edit({ path: 'src/greet.py', input: example.replace('A1B2', tag) }, host)
  expect(readFileSync(join(base, 'src/greet.py'), 'utf8')).toBe(
    'def greet(name):\n    """Say hello."""\n    print(f"Hello, {name}")\n\ngreet("world")\n',
  )
})
