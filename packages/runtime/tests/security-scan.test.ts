import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ColonyHost } from '../src/host.ts'
import { prompts } from '../src/prompts.ts'
import { lockfileDependencies, type ScanScope, secretsIn, securityScan } from '../src/security-scan.ts'
import { TOOL_DEFS } from '../src/tools.ts'

const say = prompts.securityScan

// Credential-shaped strings are built from parts, so this file itself holds none.
const AWS = `AKIA${'Q7'.repeat(8)}`
const GITHUB = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD9',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'myr-scan-')))
  // .gitignore is read inside a repository.
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function scope(more: Partial<ScanScope> = {}): ScanScope {
  return { root: dir, target: dir, mayRead: () => true, ...more }
}

test('credential shapes and quoted secrets are found by line; references and placeholders are not', () => {
  const text = [
    `const aws = "${AWS}"`,
    `token = ${GITHUB}`,
    'const apiKey = "s3cr3tValue9876543"',
    'const token = process.env.TOKEN',
    'password: "your-password-here-123"',
    PEM,
  ].join('\n')
  const found = secretsIn(text)
  expect(found.map((f) => [f.line, f.kind])).toEqual([
    [1, 'AWSAccessKey'],
    [2, 'Credential'],
    [3, say.assignedKind('apiKey')],
    [6, 'PrivateKey'],
  ])
})

test('a scan reads what git keeps, masks every value, and leaves out ignored, dependency and unreadable files', async () => {
  writeFileSync(join(dir, 'config.ts'), `export const key = "${AWS}"\n`)
  writeFileSync(join(dir, '.env'), `GITHUB_TOKEN=${GITHUB}\n`)
  writeFileSync(join(dir, '.gitignore'), '.env\n')
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), `"${AWS}"`)
  mkdirSync(join(dir, 'keys'))
  writeFileSync(join(dir, 'keys', 'id.pem'), PEM)
  const report = await securityScan(scope({ mayRead: (p) => !p.startsWith(join(dir, 'keys')) }), {
    checks: 'secrets',
  })
  expect(report).toContain('config.ts:1 AWSAccessKey: AKIA… (20 chars)')
  expect(report).not.toContain(AWS)
  expect(report).not.toContain('.env')
  expect(report).not.toContain('node_modules')
  expect(report).toContain(say.hiddenFiles(1))
  expect(await securityScan(scope({ target: join(dir, '.gitignore') }), { checks: 'secrets' })).toBe(
    say.noSecrets(1),
  )
})

test('each lockfile kind gives its pinned packages', () => {
  const npm = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/lodash': { version: '4.17.20' },
      'node_modules/a/node_modules/@scope/b': { version: '1.0.0' },
      'node_modules/local': { link: true },
    },
  })
  expect(lockfileDependencies('package-lock.json', npm).map((d) => `${d.name}@${d.version}`)).toEqual([
    'lodash@4.17.20',
    '@scope/b@1.0.0',
  ])
  const bun = [
    '{',
    '  "packages": {',
    '    "lodash": ["lodash@4.17.20", "", {}, "sha512-x"],',
    '    "@scope/b": ["@scope/b@1.0.0", "", {}, "sha512-y"],',
    '    "app": ["app@workspace:packages/app"],',
    '  }',
    '}',
  ].join('\n')
  expect(lockfileDependencies('bun.lock', bun).map((d) => `${d.name}@${d.version}`)).toEqual([
    'lodash@4.17.20',
    '@scope/b@1.0.0',
  ])
  const pnpm =
    "lockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.20:\n    resolution: {}\n\n  '@scope/b@1.0.0':\n    resolution: {}\n\nsnapshots:\n\n  lodash@4.17.20: {}\n"
  expect(lockfileDependencies('pnpm-lock.yaml', pnpm).map((d) => `${d.name}@${d.version}`)).toEqual([
    'lodash@4.17.20',
    '@scope/b@1.0.0',
  ])
  const yarn =
    '# yarn lockfile v1\n\n"lodash@^4.17.0", lodash@^4.17.20:\n  version "4.17.20"\n  resolved "x"\n\n"@scope/b@npm:^1.0.0":\n  version: 1.0.0\n'
  expect(lockfileDependencies('yarn.lock', yarn).map((d) => `${d.name}@${d.version}`)).toEqual([
    'lodash@4.17.20',
    '@scope/b@1.0.0',
  ])
  expect(
    lockfileDependencies(
      'requirements-dev.txt',
      'django==3.2.0\nrequests[socks]==2.19.0 ; python_version > "3"\nflask>=2\n',
    ),
  ).toEqual([
    { ecosystem: 'PyPI', name: 'django', version: '3.2.0' },
    { ecosystem: 'PyPI', name: 'requests', version: '2.19.0' },
  ])
  const toml =
    '[[package]]\nname = "serde"\nversion = "1.0.100"\nsource = "registry"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n'
  expect(
    lockfileDependencies('Cargo.lock', toml).map((d) => `${d.ecosystem}:${d.name}@${d.version}`),
  ).toEqual(['crates.io:serde@1.0.100', 'crates.io:app@0.1.0'])
  expect(lockfileDependencies('poetry.lock', toml)[0]?.ecosystem).toBe('PyPI')
  const sum = 'golang.org/x/text v0.3.7 h1:abc=\ngolang.org/x/text v0.3.7/go.mod h1:def=\n'
  expect(lockfileDependencies('go.sum', sum)).toEqual([
    { ecosystem: 'Go', name: 'golang.org/x/text', version: '0.3.7' },
  ])
  expect(lockfileDependencies('README.md', 'lodash@1.0.0')).toEqual([])
})

/** OSV.dev as it answers: lodash 4.17.20 has one vulnerability, everything else none. */
function osv() {
  const asked: { url: string; body?: unknown }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    asked.push({ url, body })
    if (url.endsWith('/querybatch'))
      return Response.json({
        results: (body.queries as { package: { name: string } }[]).map((q) =>
          q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] } : {},
        ),
      })
    return Response.json({
      id: 'GHSA-35jh-r3h4-6jhm',
      summary: 'Command Injection in lodash',
      aliases: ['CVE-2021-23337'],
      database_specific: { severity: 'HIGH' },
      affected: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
        },
      ],
    })
  }
  return { fetch, asked }
}

test('dependencies are looked up in OSV.dev by name and version only, and each hit says what fixes it', async () => {
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      packages: { 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/ms': { version: '2.1.3' } },
    }),
  )
  const { fetch, asked } = osv()
  const report = await securityScan(scope({ fetch }), { checks: 'dependencies' })
  expect(report).toContain(say.vulnerable(1, 2, ['package-lock.json']))
  expect(report).toContain('- lodash@4.17.20 (npm, package-lock.json)')
  expect(report).toContain(
    'GHSA-35jh-r3h4-6jhm / CVE-2021-23337 [high]: Command Injection in lodash (fixed in 4.17.21)',
  )
  expect(asked[0]?.body).toEqual({
    queries: [
      { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.20' },
      { package: { name: 'ms', ecosystem: 'npm' }, version: '2.1.3' },
    ],
  })
  // Without the web the packages are counted, and nothing is sent.
  expect(await securityScan(scope(), { checks: 'dependencies' })).toBe(
    say.dependenciesOffline(2, ['package-lock.json']),
  )
  // OSV.dev down is said, not taken for a clean result.
  const down = async () => new Response('', { status: 503 })
  expect(await securityScan(scope({ fetch: down }), { checks: 'dependencies' })).toBe(
    say.osvFailed('HTTP 503'),
  )
  rmSync(join(dir, 'package-lock.json'))
  expect(await securityScan(scope({ fetch }), { checks: 'dependencies' })).toBe(say.noLockfiles)
})

test('the security_scan tool reads the agent working directory and reaches OSV.dev only with web access', async () => {
  writeFileSync(join(dir, 'app.py'), `KEY = "${AWS}"\n`)
  writeFileSync(join(dir, 'requirements.txt'), 'django==3.2.0\n')
  const tool = TOOL_DEFS.find((d) => d.name === 'security_scan')
  expect(tool?.tier).toBe('read')
  const h = {
    spec: { agents: [{ name: 'kai', model: 'mock/x', tools: ['security_scan'] }], chat: {} },
    workspace: {
      workdir: () => dir,
      resolveForRead: (_: string, path: string) => resolve(dir, path),
      mayRead: () => true,
    },
  } as unknown as ColonyHost
  const report = String(await tool?.run({}, 'kai', h))
  expect(report).toContain('app.py:1 AWSAccessKey')
  expect(report).toContain(say.dependenciesOffline(1, ['requirements.txt']))
})
