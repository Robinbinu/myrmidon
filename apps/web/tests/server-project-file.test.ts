import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '@myrmidon/runtime'
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
  // Read-only, like the diffs a chats-only device already sees.
  expect(needsFull('GET', `/api/projects/${project.id}/file`)).toBe(false)
})
