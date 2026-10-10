import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  findProjectFiles,
  listProjectDir,
  ProjectStore,
  projectSecret,
  readProjectFile,
} from '../src/projects.ts'

let home: string
let folders: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-projects-'))
  folders = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-folders-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(folders, { recursive: true, force: true })
})

// Changed with the permission model: new folders used to start on "Ask first"; now they use the global preset
// (Auto by default) until the person gives one its own, and folders saved in the old shape keep their choice.
test('a new project folder uses the global preset; saved modes keep their meaning', () => {
  const older = join(folders, 'older')
  const asking = join(folders, 'asking')
  const newer = join(folders, 'newer')
  mkdirSync(older)
  mkdirSync(asking)
  mkdirSync(newer)
  writeFileSync(
    join(home, 'projects.json'),
    JSON.stringify([
      // Before folders had a mode: autonomous, which is "use global".
      { id: 'older-abc123', name: 'older', path: older, addedAt: '2026-10-01T00:00:00.000Z' },
      {
        id: 'asking-abc123',
        name: 'asking',
        path: asking,
        addedAt: '2026-10-02T00:00:00.000Z',
        permissions: { mode: 'ask', allow: ['bun test'], read: ['~/docs'] },
      },
    ]),
  )
  const store = new ProjectStore(home)
  const added = store.add(newer)
  expect(added.permissions).toEqual({ rules: [] })
  expect(store.get('older-abc123')?.permissions).toEqual({ rules: [] })
  expect(store.get('asking-abc123')?.permissions).toEqual({
    preset: 'ask',
    rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }],
    read: ['~/docs'],
  })
  // Adding a folder already on the list returns it as it is.
  expect(store.add(asking).permissions.preset).toBe('ask')
  // The old shape is still accepted when set; old `auto` means "use global".
  store.setPermissions(added.id, { mode: 'auto', allow: [] })
  expect(store.get(added.id)?.permissions).toEqual({ rules: [] })
  store.setPermissions(added.id, {
    preset: 'read-only',
    rules: [{ kind: 'tool', target: 'shell', decision: 'ask' }],
  })
  expect(store.add(newer).permissions).toEqual({
    preset: 'read-only',
    rules: [{ kind: 'tool', target: 'shell', decision: 'ask' }],
  })
  expect(() => store.setPermissions(added.id, { preset: 'yolo' } as never)).toThrow('preset')
})

test('a project file opens by its path in the folder, and nothing outside the folder does', () => {
  const root = join(folders, 'app')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n')
  writeFileSync(join(folders, 'secret.txt'), 'outside')
  symlinkSync(join(folders, 'secret.txt'), join(root, 'link.txt'))
  writeFileSync(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))

  expect(readProjectFile(root, 'src/calc.py')).toEqual({
    path: 'src/calc.py',
    text: 'def add(a, b):\n    return a + b\n',
  })
  // Agents may name a file by its full path; one inside the folder opens the same way.
  expect(readProjectFile(root, join(root, 'src', 'calc.py')).path).toBe('src/calc.py')
  for (const outside of ['../secret.txt', join(folders, 'secret.txt'), 'link.txt', 'src/../../secret.txt'])
    expect(() => readProjectFile(root, outside)).toThrow(/not in this project/)
  expect(() => readProjectFile(root, 'gone.py')).toThrow(/no longer in the folder/)
  expect(() => readProjectFile(root, 'src')).toThrow(/not a file/)
  expect(() => readProjectFile(root, 'logo.png')).toThrow(/not a text file/)
})

test('a project folder lists one level at a time, folders first, with git status and ignored files marked', async () => {
  const root = join(folders, 'app')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@x', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(root, 'README.md'), '# app\n')
  writeFileSync(join(root, 'src', 'calc.py'), 'def add(a, b):\n    return a - b\n')
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync(join(root, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n')
  writeFileSync(join(root, 'src', 'new.py'), 'x = 1\n')

  const top = await listProjectDir(root, '')
  expect(top.entries).toEqual([
    { name: 'node_modules', path: 'node_modules', dir: true, ignored: true },
    { name: 'src', path: 'src', dir: true, changed: true },
    { name: '.gitignore', path: '.gitignore', dir: false },
    { name: 'README.md', path: 'README.md', dir: false },
  ])
  expect((await listProjectDir(root, 'src')).entries).toEqual([
    { name: 'calc.py', path: 'src/calc.py', dir: false, status: 'M' },
    { name: 'new.py', path: 'src/new.py', dir: false, status: '?' },
  ])
  await expect(listProjectDir(root, '../')).rejects.toThrow(/not in this project/)
  await expect(listProjectDir(root, 'README.md')).rejects.toThrow(/not a folder/)

  // Finding by name looks through the whole folder, leaving out what git ignores.
  expect((await findProjectFiles(root, 'PY')).paths).toEqual(['src/calc.py', 'src/new.py'])
  expect((await findProjectFiles(root, 'index')).paths).toEqual([])
})

test('a folder that is not a repository lists and finds its files without git', async () => {
  const root = join(folders, 'plain')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'plan.md'), '# plan\n')
  expect((await listProjectDir(root, '')).entries).toEqual([{ name: 'docs', path: 'docs', dir: true }])
  expect((await findProjectFiles(root, 'plan')).paths).toEqual(['docs/plan.md'])
})

test("a project around the person's home hides their keys and Myrmidon's data, but not the project's own .env", async () => {
  // A project one level above a home (as /Users is above ~): its .ssh and the data folder are inside it.
  const root = join(folders, 'Users')
  const home = join(root, 'ada')
  const data = join(home, '.myrmidon')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(join(home, 'code'), { recursive: true })
  mkdirSync(data)
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
  writeFileSync(join(home, '.netrc'), 'machine x password y')
  writeFileSync(join(data, 'credentials.json'), '{}')
  writeFileSync(join(home, 'code', '.env'), 'API_KEY=mine')
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'code', 'key'))
  const guard = { home, dataDir: data }

  for (const file of ['ada/.ssh/id_ed25519', 'ada/.netrc', 'ada/.myrmidon/credentials.json', 'ada/code/key'])
    expect(() => readProjectFile(root, file, guard)).toThrow(/keys or sign-ins/)
  // A missing key answers as a present one does, so nothing tells which exist.
  expect(() => readProjectFile(root, 'ada/.ssh/id_rsa', guard)).toThrow(/keys or sign-ins/)
  await expect(listProjectDir(root, 'ada/.ssh', guard)).rejects.toThrow(/keys or sign-ins/)
  // A link into them is left out of the folder's listing too.
  expect((await listProjectDir(root, 'ada/code', guard)).entries.map((e) => e.name)).toEqual(['.env'])
  expect(
    ['ada/.ssh/id_rsa', 'ada/code/key', 'ada/code/.env'].map((f) => projectSecret(root, f, guard)),
  ).toEqual([true, true, false])
  expect((await listProjectDir(root, 'ada', guard)).entries.map((e) => e.name)).toEqual(['code'])
  expect((await findProjectFiles(root, '', guard)).paths).toEqual(['ada/code/.env'])
  // The project's own files stay open, secrets-looking or not: full access is what guards those.
  expect(readProjectFile(root, 'ada/code/.env', guard).text).toBe('API_KEY=mine')
  // A project the person made inside one of those folders is theirs to read, as the sandbox lets its agents.
  expect(readProjectFile(join(home, '.ssh'), 'id_ed25519', guard).text).toBe('PRIVATE KEY')
})

test("a project beside, around or inside Myrmidon's data folder never serves its keys, however the folder is spelled", async () => {
  const data = join(folders, '.myrmidon')
  const beside = join(folders, 'app')
  const inside = join(data, 'notes')
  mkdirSync(join(data, 'colonies'), { recursive: true })
  mkdirSync(beside)
  mkdirSync(inside)
  writeFileSync(join(data, 'credentials.json'), '{"key":"sk-1"}')
  writeFileSync(join(beside, 'main.ts'), 'export {}\n')
  symlinkSync(join(data, 'credentials.json'), join(beside, 'creds.json'))
  // Folders as Myrmidon may be handed them: real; as the temp folder names them (/var for /private/var on macOS, an
  // 8.3 short name such as RUNNER~1 on Windows); and, where names ignore case, in other case.
  const ways = process.platform === 'linux' ? ['real', 'temp'] : ['real', 'temp', 'case']
  const spell = (path: string, way: string) =>
    way === 'temp'
      ? join(tmpdir(), basename(folders), path.slice(folders.length))
      : way === 'case'
        ? path.toUpperCase()
        : path
  for (const dataWay of ways)
    for (const way of ways) {
      const dataDir = spell(data, dataWay)
      const [around, app, notes] = [folders, beside, inside].map((p) => spell(p, way)) as [
        string,
        string,
        string,
      ]
      const guard = { dataDir }
      expect(() => readProjectFile(app, '../.myrmidon/credentials.json', guard)).toThrow(
        /not in this project/,
      )
      expect(() => readProjectFile(app, join(data, 'credentials.json'), guard)).toThrow(/not in this project/)
      expect(() => readProjectFile(app, 'creds.json', guard)).toThrow(/not in this project/)
      expect(() => readProjectFile(notes, '../credentials.json', guard)).toThrow(/not in this project/)
      expect(() => readProjectFile(around, '.myrmidon/credentials.json', guard)).toThrow(/keys or sign-ins/)
      expect(projectSecret(around, '.myrmidon/colonies', guard)).toBe(true)
      expect((await listProjectDir(around, '', guard)).entries.map((e) => e.name)).toEqual(['app'])
      expect((await findProjectFiles(around, '', guard)).paths).toEqual(['app/main.ts'])
      expect(readProjectFile(app, 'main.ts', guard).text).toBe('export {}\n')
    }
})
