import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PermissionCall } from '@myrmidon/protocol'
import { astEdit, astGrep, type FileChange, type LspScope, lsp, projectChecks } from '../src/code-intel.ts'
import { AST_EDIT_MAX_FILES } from '../src/config.ts'
import type { ColonyHost } from '../src/host.ts'
import { detectSandbox } from '../src/sandbox.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'myr-code-')))
  mkdirSync(join(dir, 'src'))
  writeFileSync(
    join(dir, 'src', 'a.ts'),
    'export function add(a: number, b: number) {\n  console.log(a, b)\n  return a + b\n}\nconsole.log(add(1, 2))\n',
  )
  writeFileSync(join(dir, 'src', 'b.ts'), "import { add } from './a'\nconsole.log(add(3, 4))\n")
  mkdirSync(join(dir, 'keys'))
  writeFileSync(join(dir, 'keys', 'c.ts'), 'console.log(secret)\n')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A scope as tools.ts builds one, without a colony: `keys/` stays hidden, and writes land directly. */
function scope(written: FileChange[][] = []): LspScope {
  const hidden = join(dir, 'keys')
  return {
    root: dir,
    resolveRead: (p) => resolve(dir, p),
    mayRead: (p) => !p.startsWith(hidden),
    mayWrite: (p) => p.startsWith(dir),
    async write(changes) {
      written.push([...changes])
      for (const c of changes) writeFileSync(c.path, c.after)
      return []
    },
    launch: async (server) => server,
    check: async () => ({ ok: true, output: '' }),
  }
}

test('ast_grep finds code by its shape, with captures, and leaves out what the agent may not read', async () => {
  const out = await astGrep(scope(), { pattern: 'console.log($$$ARGS)' })
  expect(out).toContain('3 matches in 2 files')
  expect(out).toContain(`src${'/'}a.ts\n  2: console.log(a, b)`)
  expect(out).toContain('  5: console.log(add(1, 2))')
  expect(out).toContain('$ARGS=')
  expect(out).toContain('1 match in files you may not read left out')
  expect(out).not.toContain('secret')
  // One file, and paging on past the first match.
  const one = await astGrep(scope(), { pattern: 'console.log($$$ARGS)', path: 'src/b.ts' })
  expect(one).toContain('console.log(add(3, 4))')
  expect(one).not.toContain('a.ts')
  const paged = await astGrep(scope(), { pattern: 'console.log($$$ARGS)', path: 'src', skip: 2 })
  expect(paged).toContain('showing 3-3')
  expect(await astGrep(scope(), { pattern: 'fetch($URL)' })).toBe('No matches for fetch($URL).')
})

test('ast_edit previews without writing, then rewrites every match through the write it is given', async () => {
  const written: FileChange[][] = []
  const before = readFileSync(join(dir, 'src', 'a.ts'), 'utf8')
  const preview = await astEdit(scope(written), {
    pattern: 'console.log($$$ARGS)',
    rewrite: 'logger.debug($$$ARGS)',
    path: 'src',
    preview: true,
  })
  expect(preview).toContain('Preview: 3 replacements in 2 files; nothing was changed')
  expect(preview).toContain('→ logger.debug(a, b)')
  expect(written).toEqual([])
  expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe(before)

  const done = await astEdit(scope(written), {
    pattern: 'console.log($$$ARGS)',
    rewrite: 'logger.debug($$$ARGS)',
    path: 'src',
  })
  expect(done).toContain('Rewrote 3 matches in 2 files')
  // Every file in one write, so a refusal can stop all of them.
  expect(written).toHaveLength(1)
  expect(written[0]?.map((c) => c.before)).toContain(before)
  expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe(
    'export function add(a: number, b: number) {\n  logger.debug(a, b)\n  return a + b\n}\nlogger.debug(add(1, 2))\n',
  )
  expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toBe(
    "import { add } from './a'\nlogger.debug(add(3, 4))\n",
  )
})

test('ast_edit refuses a rewrite that reaches a file the agent may not change, or too many files', async () => {
  await expect(astEdit(scope(), { pattern: 'console.log($$$A)', rewrite: '' })).rejects.toThrow(
    'which you may read but not change',
  )
  expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toContain('console.log(a, b)')
  for (let i = 0; i <= AST_EDIT_MAX_FILES; i++)
    writeFileSync(join(dir, 'src', `m${i}.ts`), 'console.log(1)\n')
  await expect(
    astEdit(scope(), { pattern: 'console.log($$$A)', rewrite: 'log($$$A)', path: 'src' }),
  ).rejects.toThrow('narrow path or glob')
})

/** A host that decides every file change with `decision`, records the cards it shows, and approves all but `refuse`. */
function host(decision: 'allow' | 'ask' | 'deny', refuse?: string) {
  const cards: string[] = []
  const calls: PermissionCall[] = []
  const h = {
    spec: { agents: [], chat: { project: { id: 'p', name: 'demo', path: dir } } },
    state: () => ({ rounds: [{ round: 1 }], receipts: {}, approvals: {} }),
    permit: (_: string, call: PermissionCall) => {
      calls.push(call)
      return decision === 'deny'
        ? { decision, source: { by: 'read-only', scope: 'project' }, preset: 'read-only' }
        : { decision, source: { by: 'preset', scope: 'global', preset: decision === 'ask' ? 'ask' : 'auto' } }
    },
    reviewChange: async (_: string, _tool: string, summary: string) => {
      cards.push(summary)
      return { approved: !summary.includes(refuse ?? '\0') }
    },
    workspace: {
      workdir: () => dir,
      scratch: () => join(dir, '.scratch'),
      resolveForRead: (_: string, p: string) => resolve(dir, p),
      resolveInWorkdir: (_: string, p: string) => resolve(dir, p),
      mayRead: () => true,
    },
  } as unknown as ColonyHost
  return { host: h, cards, calls }
}

const astEditTool = TOOL_DEFS.find((d) => d.name === 'ast_edit')
const rewrite = { pattern: 'console.log($$$ARGS)', rewrite: 'logger.debug($$$ARGS)', path: 'src' }

test('ast_edit in a project follows the permission model as fs_edit does, and writes nothing when one file is turned down', async () => {
  rmSync(join(dir, 'keys'), { recursive: true })
  const original = readFileSync(join(dir, 'src', 'a.ts'), 'utf8')
  // Read-only: refused, nothing written.
  const ro = host('deny')
  await expect(astEditTool?.run(rewrite, 'kai', ro.host)).rejects.toThrow('demo is read-only for agents')
  expect(ro.calls[0]).toMatchObject({ tool: 'ast_edit', kind: 'edit', where: 'project' })
  expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe(original)
  // Ask: a card per file; turning down the second leaves the first unwritten too.
  const ask = host('ask', 'b.ts')
  await expect(astEditTool?.run(rewrite, 'kai', ask.host)).rejects.toThrow(
    'the person did not approve changing',
  )
  expect(ask.cards).toEqual([`edit src${'/'}a.ts`, `edit src${'/'}b.ts`])
  expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe(original)
  // Approved: written.
  const ok = host('ask')
  expect(await astEditTool?.run(rewrite, 'kai', ok.host)).toContain('Rewrote 3 matches in 2 files')
  expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toContain('logger.debug(add(3, 4))')
})

test('lsp is a read unless it renames, so only a rename is scheduled and receipted as a write', () => {
  const def = TOOL_DEFS.find((d) => d.name === 'lsp')
  expect(def?.tier).toBe('read')
  expect(def?.tierOf?.({ action: 'references' })).toBe('read')
  expect(def?.tierOf?.({ action: 'rename' })).toBe('write')
})

test('the project type check uses an installed checker, never npx, named so any shell can run it', () => {
  writeFileSync(join(dir, 'tsconfig.json'), '{}')
  writeFileSync(join(dir, 'Cargo.toml'), '')
  const local = join(dir, 'node_modules', '.bin', 'tsc')
  const which = (cmd: string) => (cmd === 'tsc' ? local : cmd === 'cargo' ? '/usr/bin/cargo' : null)
  expect(projectChecks(dir, which)).toEqual([
    './node_modules/.bin/tsc --noEmit --pretty false',
    'cargo check --message-format=short',
  ])
  expect(projectChecks(dir, () => null)).toEqual([])
})

// The repo's own TypeScript 7 `tsc` speaks LSP (omp's typescript-native); without it these are skipped.
const repoBin = resolve(import.meta.dir, '../../../node_modules/.bin')
const tsLsp =
  existsSync(join(repoBin, 'tsc')) &&
  !existsSync(join(realpathSync(join(repoBin, 'tsc')), '..', '..', 'lib', 'tsserver.js'))

test.skipIf(!tsLsp)(
  'lsp answers from a real language server: diagnostics, references, hover, symbols and a rename',
  async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"demo","private":true}')
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noEmit":true}}')
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(repoBin, join(dir, 'node_modules', '.bin'))
    writeFileSync(join(dir, 'src', 'c.ts'), "export const n: number = 'x'\n")
    rmSync(join(dir, 'keys'), { recursive: true })
    const s = scope()
    expect(await lsp(s, { action: 'status' })).toContain('typescript-native')
    expect(await lsp(s, { action: 'diagnostics', path: 'src/c.ts' })).toContain(
      "Type 'string' is not assignable to type 'number'",
    )
    const refs = await lsp(s, { action: 'references', path: 'src/a.ts', line: 1, symbol: 'add' })
    expect(refs).toContain('src/b.ts:2:')
    expect(await lsp(s, { action: 'hover', path: 'src/a.ts', line: 1, symbol: 'add' })).toContain('number')
    expect(await lsp(s, { action: 'symbols', path: 'src/a.ts' })).toContain('Function add')
    const renamed = await lsp(s, {
      action: 'rename',
      path: 'src/a.ts',
      line: 1,
      symbol: 'add',
      newName: 'sum',
    })
    expect(renamed).toContain('Renamed:')
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toBe(
      "import { sum } from './a'\nconsole.log(sum(3, 4))\n",
    )
    // A kind of file no installed server reads is said plainly.
    writeFileSync(join(dir, 'notes.xyz'), 'hello')
    expect(await lsp(s, { action: 'hover', path: 'notes.xyz', line: 1, symbol: 'hello' })).toContain(
      'No language server is installed for notes.xyz',
    )
  },
  120_000,
)

const confined = detectSandbox()

test.skipIf(!tsLsp || (confined.kind !== 'sandbox-exec' && confined.kind !== 'bubblewrap'))(
  'the lsp tool starts its server inside the OS sandbox, decided as a command, and reads through it',
  async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"demo","private":true}')
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noEmit":true}}')
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(repoBin, join(dir, 'node_modules', '.bin'))
    writeFileSync(join(dir, 'src', 'c.ts'), "export const n: number = 'x'\n")
    mkdirSync(join(dir, '.scratch'))
    const { host: h, calls } = host('allow')
    const workspace = (h as unknown as { workspace: object }).workspace
    Object.assign(h, {
      sandbox: confined,
      unsafeNoSandbox: false,
      workspace: {
        ...workspace,
        // The repo's node_modules, which the stand-in project links to, is read through the link.
        confinement: () => ({ readable: [dir, resolve(repoBin, '..', '..')], hidden: [] }),
      },
    })
    const tool = TOOL_DEFS.find((d) => d.name === 'lsp')
    expect(await tool?.run({ action: 'diagnostics', path: 'src/c.ts' }, 'kai', h)).toContain(
      "Type 'string' is not assignable to type 'number'",
    )
    expect(calls.find((c) => c.kind === 'command')).toMatchObject({
      tool: 'lsp',
      command: expect.stringContaining('tsc --lsp --stdio'),
    })
  },
  120_000,
)
