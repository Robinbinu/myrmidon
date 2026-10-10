import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeTar } from '@oh-my-pi/pi-coding-agent/skillshare/tar'
import { integrityOf } from '../src/install-sources.ts'
import { parseSkillSpec, resolveSkillVersion, SkillRegistryClient } from '../src/skill-registry.ts'
import { SkillLibrary } from '../src/skills.ts'

let dir: string
let home: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-skill-installs-'))
  home = join(dir, 'home')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const enc = new TextEncoder()
const SKILL = (version: string) =>
  `---\nname: pdf-tools\ndescription: Work with PDFs\nmetadata:\n  version: ${version}\n---\nUse pdftotext.`

/** A skills registry package: files relative to the skill, gzipped tar, as omp publishes them. */
const pack = (files: Record<string, { text: string; executable?: boolean }>) =>
  Bun.gzipSync(
    writeTar(
      Object.entries(files).map(([path, f]) => ({
        path,
        content: enc.encode(f.text),
        executable: !!f.executable,
      })),
    ),
  )

/** A registry with `@ada/pdf-tools` at 1.0.0 and 1.1.0 (yanked), answering through a stubbed fetch. */
function registry(opts: { tamper?: boolean } = {}) {
  const v1 = pack({
    'SKILL.md': { text: SKILL('1.0.0') },
    'scripts/extract.sh': { text: '#!/bin/sh\npdftotext "$1"', executable: true },
  })
  const v2 = pack({ 'SKILL.md': { text: SKILL('1.1.0') } })
  const summary = (version: string, tgz: Uint8Array, extra = {}) => ({
    version,
    publishedAt: 0,
    integrity: opts.tamper ? 'sha512-nope' : integrityOf(tgz),
    size: tgz.length,
    unpackedSize: 0,
    fileCount: 1,
    hasScripts: version === '1.0.0',
    yanked: false,
    ...extra,
  })
  const asked: string[] = []
  const fetchFn = async (input: string | URL) => {
    const url = new URL(String(input))
    asked.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/api/v1/search')
      return Response.json({
        total: 1,
        page: 1,
        perPage: 20,
        hits: [
          {
            scope: 'ada',
            name: 'pdf-tools',
            description: 'Work with PDFs',
            keywords: [],
            version: '1.0.0',
            publisher: { username: 'ada', avatar: '' },
            updatedAt: 0,
            weeklyDownloads: 12,
          },
        ],
      })
    if (url.pathname === '/api/v1/skills/@ada/pdf-tools')
      return Response.json({
        scope: 'ada',
        name: 'pdf-tools',
        description: 'Work with PDFs',
        distTags: { latest: '1.0.0', next: '1.1.0' },
        versions: { '1.0.0': summary('1.0.0', v1), '1.1.0': summary('1.1.0', v2, { yanked: true }) },
      })
    if (url.pathname === '/api/v1/skills/@ada/pdf-tools/versions/1.0.0/tarball') return new Response(v1)
    if (url.pathname === '/api/v1/skills/@ada/pdf-tools/versions/1.1.0/tarball') return new Response(v2)
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  return { client: new SkillRegistryClient('https://skills.test/', fetchFn), asked }
}

test('registry specs and version picks follow omp', () => {
  expect(parseSkillSpec('@ada/pdf-tools@^1')).toEqual({ scope: 'ada', name: 'pdf-tools', range: '^1' })
  expect(parseSkillSpec('pdf-tools')).toBeUndefined()
  const packument = {
    scope: 'ada',
    name: 'x',
    description: '',
    distTags: { latest: '1.0.0' },
    versions: {
      '1.0.0': { version: '1.0.0', yanked: false },
      '1.2.0': { version: '1.2.0', yanked: true },
      '1.1.0': { version: '1.1.0', yanked: false },
    },
  } as never
  expect(resolveSkillVersion(packument).version).toBe('1.0.0')
  expect(resolveSkillVersion(packument, '^1').version).toBe('1.1.0')
  expect(resolveSkillVersion(packument, '1.2.0').warnings).toEqual(['@ada/x@1.2.0 is yanked'])
})

test('the registry is searched, and a skill installs only after the person saw what it holds', async () => {
  const { client, asked } = registry()
  const hits = await client.search('pdf')
  expect(hits.hits.map((h) => `@${h.scope}/${h.name}`)).toEqual(['@ada/pdf-tools'])
  expect(asked[0]).toBe('/api/v1/search?q=pdf')

  const skills = new SkillLibrary(home, join(dir, 'no-claude'), () => [], client)
  const preview = await skills.installs.prepare('@ada/pdf-tools')
  expect(preview).toMatchObject({
    skills: [{ name: 'pdf-tools', description: 'Work with PDFs' }],
    kind: 'registry',
    version: '1.0.0',
    files: 2,
    scripts: ['scripts/extract.sh'],
    warnings: [],
  })
  expect(skills.list()).toEqual([])
  expect(() => skills.installs.confirm('00000000-0000-0000-0000-000000000000')).toThrow('not reviewed')
  expect(skills.installs.confirm(preview.id)).toEqual(['pdf-tools'])
  const [skill] = skills.list()
  expect(skill).toMatchObject({
    name: 'pdf-tools',
    source: 'myrmidon',
    installed: { source: '@ada/pdf-tools', version: '1.0.0', integrity: preview.integrity },
  })
  // Installing does not run the script it ships; it keeps it runnable for an agent that is allowed to.
  expect(readFileSync(join(home, 'skills', 'pdf-tools', 'scripts', 'extract.sh'), 'utf8')).toContain(
    'pdftotext',
  )

  // Installing it again is refused while it is there (an update goes through prepareUpdate).
  await expect(skills.installs.prepare('@ada/pdf-tools@1.1.0')).rejects.toThrow('already exists')
  // A yanked version is installed only when asked for by its number, with a warning.
  skills.installs.remove('pdf-tools')
  expect(skills.list()).toEqual([])
  const yanked = await skills.installs.prepare('@ada/pdf-tools@1.1.0')
  expect(yanked.warnings).toEqual(['@ada/pdf-tools@1.1.0 is yanked'])
})

test('a download that does not match its published hash installs nothing', async () => {
  const { client } = registry({ tamper: true })
  const skills = new SkillLibrary(home, join(dir, 'no-claude'), () => [], client)
  await expect(skills.installs.prepare('@ada/pdf-tools')).rejects.toThrow('does not match its published hash')
  expect(existsSync(join(home, 'skills', 'pdf-tools'))).toBe(false)
})

test('skills install from a git repository holding several, update from it, and only installed ones are removed', async () => {
  const repo = join(dir, 'skills-repo')
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: First\n---\nOne.')
  write('skills/beta/SKILL.md', '---\nname: beta\ndescription: Second\n---\nTwo.')
  write('README.md', 'Two skills')
  const sh = (args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo })
      .stdout.toString()
      .trim()
  sh(['init', '-q'])
  sh(['add', '-A'])
  sh(['commit', '-qm', 'skills'])
  const first = sh(['rev-parse', 'HEAD'])
  const url = pathToFileURL(repo).href

  const skills = new SkillLibrary(home, join(dir, 'no-claude'), () => [])
  const preview = await skills.installs.prepare(url)
  expect(preview).toMatchObject({ kind: 'git', commit: first, files: 2, scripts: [] })
  expect(preview.skills.map((s) => s.name)).toEqual(['alpha', 'beta'])
  expect(skills.installs.confirm(preview.id)).toEqual(['alpha', 'beta'])
  expect(skills.list().map((s) => [s.name, s.installed?.commit])).toEqual([
    ['alpha', first],
    ['beta', first],
  ])
  await expect(skills.installs.prepare(url)).rejects.toThrow('already exists')

  write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: First, better\n---\nOne.')
  sh(['commit', '-qam', 'better'])
  const update = await skills.installs.prepareUpdate('alpha')
  expect(update).toMatchObject({ skills: [{ name: 'alpha' }], replaces: { commit: first } })
  skills.installs.confirm(update.id)
  expect(skills.list().find((s) => s.name === 'alpha')?.description).toBe('First, better')

  // A skill the person wrote themselves is theirs to delete, not the installer's.
  skills.write('mine', 'My own', 'Steps')
  expect(() => skills.installs.remove('mine')).toThrow('was not installed')
  skills.installs.remove('beta')
  expect(skills.list().map((s) => s.name)).toEqual(['alpha', 'mine'])
})
