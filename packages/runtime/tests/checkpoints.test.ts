import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoints } from '../src/checkpoints.ts'

let dir: string
let project: { id: string; path: string }
let checkpoints: Checkpoints

const sh = (args: string[]) => {
  const r = Bun.spawnSync(args, { cwd: project.path })
  return new TextDecoder().decode(r.stdout).trim()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-ckpt-'))
  project = { id: 'app-abc123', path: join(dir, 'app') }
  mkdirSync(join(project.path, 'src'), { recursive: true })
  writeFileSync(join(project.path, 'src', 'main.ts'), 'export const a = 1\n')
  writeFileSync(join(project.path, 'README.md'), '# app\n')
  writeFileSync(join(project.path, '.gitignore'), 'dist/\n')
  sh(['git', 'init', '-q'])
  sh(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  sh(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  checkpoints = new Checkpoints(join(dir, 'checkpoints'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a round is snapshotted, diffed and rewound without touching the project’s own git', async () => {
  const head = sh(['git', 'rev-parse', 'HEAD'])
  const start = await checkpoints.snapshot(project, 'before round 1')

  writeFileSync(join(project.path, 'src', 'main.ts'), 'export const a = 2\nexport const b = 3\n')
  writeFileSync(join(project.path, 'src', 'new.ts'), 'export const n = 0\n')
  rmSync(join(project.path, 'README.md'))
  mkdirSync(join(project.path, 'dist'))
  writeFileSync(join(project.path, 'dist', 'out.js'), 'ignored')
  mkdirSync(join(project.path, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(project.path, 'node_modules', 'x', 'index.js'), 'ignored')
  const end = await checkpoints.snapshot(project, 'after round 1')

  const changes = await checkpoints.changes(project, start, end)
  expect(changes.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
    'A src/new.ts',
    'D README.md',
    'M src/main.ts',
  ])
  expect(changes.files.find((f) => f.path === 'src/main.ts')).toMatchObject({ added: 2, removed: 1 })
  expect(changes.patch).toContain('+export const b = 3')

  const files = await checkpoints.files(project, start, end)
  expect(files.sort()).toEqual(['README.md', 'src/main.ts', 'src/new.ts'])
  const { undo, changed } = await checkpoints.restore(project, start, files)
  expect(changed).toBe(3)
  expect(readFileSync(join(project.path, 'src', 'main.ts'), 'utf8')).toBe('export const a = 1\n')
  expect(existsSync(join(project.path, 'README.md'))).toBe(true)
  expect(existsSync(join(project.path, 'src', 'new.ts'))).toBe(false)
  // Ignored files are not the round's work and are left alone.
  expect(existsSync(join(project.path, 'dist', 'out.js'))).toBe(true)
  // The project's own repository saw none of this.
  expect(sh(['git', 'rev-parse', 'HEAD'])).toBe(head)
  expect(sh(['git', 'status', '--porcelain'])).toBe('?? node_modules/')
  expect(sh(['git', 'stash', 'list'])).toBe('')

  // Undoing the rewind brings the round's work back.
  await checkpoints.restore(project, undo, files)
  expect(readFileSync(join(project.path, 'src', 'main.ts'), 'utf8')).toContain('b = 3')
  expect(existsSync(join(project.path, 'src', 'new.ts'))).toBe(true)
  expect(existsSync(join(project.path, 'README.md'))).toBe(false)
})

test('changes against the folder as it is now', async () => {
  const start = await checkpoints.snapshot(project, 'before')
  writeFileSync(join(project.path, 'src', 'main.ts'), 'export const a = 9\n')
  const now = await checkpoints.changes(project, start)
  expect(now.files).toEqual([{ path: 'src/main.ts', status: 'M', added: 1, removed: 1 }])
})

test('a restore touches only the files it is given', async () => {
  const start = await checkpoints.snapshot(project, 'before')
  writeFileSync(join(project.path, 'src', 'main.ts'), 'export const a = 2\n')
  writeFileSync(join(project.path, 'README.md'), '# app, edited by someone else\n')
  const { changed } = await checkpoints.restore(project, start, ['src/main.ts'])
  expect(changed).toBe(1)
  expect(readFileSync(join(project.path, 'src', 'main.ts'), 'utf8')).toBe('export const a = 1\n')
  expect(readFileSync(join(project.path, 'README.md'), 'utf8')).toBe('# app, edited by someone else\n')
})
