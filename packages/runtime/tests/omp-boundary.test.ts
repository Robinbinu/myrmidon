import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

// omp changes often and its internals are not a stable API, so it is reached in one place: packages/runtime/src/omp/.
// An upgrade that moves or renames something then breaks there (and in omp-contract.test.ts), not across Myrmidon.
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const BOUNDARY = 'packages/runtime/src/omp/'
const OMP = /@oh-my-pi[/+]/

/** Files that name omp's packages without importing them, and why. */
const ALLOWED: Record<string, string> = {
  'apps/desktop/scripts/build-sidecar.ts':
    "copies omp's native addon into the compiled app, by its install path",
  'packages/runtime/tests/oauth-page.test.ts':
    "reads omp's installed sign-in page to prove patches/ still applies",
  'packages/runtime/tests/catalog-patch.test.ts':
    "loads omp's installed Groq discovery to prove patches/ still applies",
}

const sources = async () => {
  const files: string[] = []
  for (const pattern of ['{packages,apps}/*/{src,tests,scripts}/**/*.{ts,tsx,js,mjs}', 'tests/**/*.ts'])
    for await (const file of new Glob(pattern).scan(repo)) files.push(file.replaceAll('\\', '/'))
  return files
}

test('only packages/runtime/src/omp/ imports omp', async () => {
  const outside: string[] = []
  for (const file of await sources()) {
    if (file.startsWith(BOUNDARY) || file in ALLOWED) continue
    const text = await Bun.file(repo + file).text()
    text.split('\n').forEach((line, i) => {
      if (OMP.test(line)) outside.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(outside).toEqual([])
})

test('every exception to the omp boundary is still needed', async () => {
  const files = new Set(await sources())
  const stale: string[] = []
  for (const file of Object.keys(ALLOWED))
    if (!files.has(file) || !OMP.test(await Bun.file(repo + file).text())) stale.push(file)
  expect(stale).toEqual([])
})

test('only the runtime package depends on omp', async () => {
  const dependents: string[] = []
  for await (const file of new Glob('{packages,apps}/*/package.json').scan(repo)) {
    const path = file.replaceAll('\\', '/')
    if (path === 'packages/runtime/package.json') continue
    const pkg = await Bun.file(repo + file).json()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
      for (const name of Object.keys(pkg[field] ?? {}))
        if (OMP.test(name)) dependents.push(`${path}: ${name}`)
  }
  expect(dependents).toEqual([])
})
