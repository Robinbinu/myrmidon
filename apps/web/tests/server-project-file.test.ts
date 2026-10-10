import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '@myrmidon/runtime'
import { pendingOn } from '../../../tests/platform.ts'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const dirs: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('GET /api/projects/:id/file opens a file an agent edited, and only files in that folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-pfile-home-'))
  const folders = realpathSync(mkdtempSync(join(tmpdir(), 'myr-pfile-')))
  dirs.push(home, folders)
  const root = join(folders, 'app')
  mkdirSync(root)
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  writeFileSync(join(folders, 'secret.txt'), 'outside')
  const projects = new ProjectStore(home)
  const project = projects.add(root)
  const server = startServer({ home, port: 0, projects })
  servers.push(server)
  const get = (id: string, path: string) =>
    fetch(
      new URL(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, server.url.replace(/#.*$/, '')),
      { headers: { authorization: `Bearer ${server.token}` } },
    )

  const ok = await get(project.id, 'calc.py')
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ path: 'calc.py', text: 'def add(a, b):\n    return a + b\n' })
  expect((await get(project.id, '../secret.txt')).status).toBe(400)
  expect((await get(project.id, 'gone.py')).status).toBe(404)
  expect((await get('nope', 'calc.py')).status).toBe(404)
  // Any file in the folder, `.env` included: a chats-only device does not browse the folder.
  expect(needsFull('GET', `/api/projects/${project.id}/file`)).toBe(true)
})

test('GET /api/projects/:id/tree lists a folder and /find finds files by name, both inside the folder only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-ptree-home-'))
  const folders = realpathSync(mkdtempSync(join(tmpdir(), 'myr-ptree-')))
  dirs.push(home, folders)
  const root = join(folders, 'app')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'calc.py'), 'x\n')
  const projects = new ProjectStore(home)
  const project = projects.add(root)
  const server = startServer({ home, port: 0, projects })
  servers.push(server)
  const get = (path: string) =>
    fetch(new URL(path, server.url.replace(/#.*$/, '')), {
      headers: { authorization: `Bearer ${server.token}` },
    })

  const top = await get(`/api/projects/${project.id}/tree`)
  expect(top.status).toBe(200)
  expect(await top.json()).toEqual({
    path: '',
    entries: [{ name: 'src', path: 'src', dir: true }],
    truncated: false,
  })
  expect((await get(`/api/projects/${project.id}/tree?path=..`)).status).toBe(400)
  expect(await (await get(`/api/projects/${project.id}/find?q=calc`)).json()).toEqual({
    paths: ['src/calc.py'],
    truncated: false,
  })
  expect(needsFull('GET', `/api/projects/${project.id}/tree`)).toBe(true)
  expect(needsFull('GET', `/api/projects/${project.id}/find`)).toBe(true)
})

pendingOn('win32', 'dataFolderOnWindows')(
  "a project around Myrmidon's data folder does not show it",
  async () => {
    const folders = realpathSync(mkdtempSync(join(tmpdir(), 'myr-pdata-')))
    dirs.push(folders)
    const root = join(folders, 'app')
    const home = join(root, '.myrmidon')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(root, 'calc.py'), 'x\n')
    writeFileSync(join(home, 'credentials.json'), '{"key":"sk-1"}')
    const projects = new ProjectStore(home)
    const project = projects.add(root)
    const server = startServer({ home, port: 0, projects })
    servers.push(server)
    const get = (path: string) =>
      fetch(new URL(path, server.url.replace(/#.*$/, '')), {
        headers: { authorization: `Bearer ${server.token}` },
      })

    const file = await get(`/api/projects/${project.id}/file?path=.myrmidon/credentials.json`)
    expect(file.status).toBe(400)
    expect(((await file.json()) as { error: string }).error).toContain('keys or sign-ins')
    const top = (await (await get(`/api/projects/${project.id}/tree`)).json()) as {
      entries: { name: string }[]
    }
    expect(top.entries.map((e) => e.name)).not.toContain('.myrmidon')
    expect(await (await get(`/api/projects/${project.id}/find?q=json`)).json()).toEqual({
      paths: [],
      truncated: false,
    })
  },
)

pendingOn('win32', 'dataFolderOnWindows')(
  'the git views of a project never show its ignored files in full, nor keys or Myrmidon data inside it',
  async () => {
    const folders = realpathSync(mkdtempSync(join(tmpdir(), 'myr-pgit-')))
    dirs.push(folders)
    const root = join(folders, 'app')
    const home = join(root, 'data')
    mkdirSync(home, { recursive: true })
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@x', ...args], { cwd: root })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(root, '.gitignore'), '.env\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    writeFileSync(join(root, '.env'), 'API_KEY=sk-env\n')
    writeFileSync(join(root, 'new.txt'), 'fresh\n')
    const projects = new ProjectStore(home)
    const project = projects.add(root)
    writeFileSync(join(home, 'credentials.json'), '{"key":"sk-data"}\n')
    const server = startServer({ home, port: 0, projects })
    servers.push(server)
    const get = (path: string) =>
      fetch(new URL(path, server.url.replace(/#.*$/, '')), {
        headers: { authorization: `Bearer ${server.token}` },
      })
    const diff = (kind: string, path: string) =>
      get(`/api/projects/${project.id}/git/diff?kind=${kind}&path=${encodeURIComponent(path)}`)

    expect(await (await diff('untracked', 'new.txt')).json()).toMatchObject({
      patch: expect.stringContaining('+fresh'),
    })
    for (const [kind, path] of [
      ['untracked', '.env'],
      ['untracked', 'data/credentials.json'],
      ['unstaged', 'data/credentials.json'],
    ] as const) {
      const res = await diff(kind, path)
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).not.toContain('sk-')
    }
    const changes = await (await get(`/api/projects/${project.id}/git/changes`)).json()
    expect(JSON.stringify(changes)).toContain('new.txt')
    expect(JSON.stringify(changes)).not.toContain('sk-data')
  },
)
