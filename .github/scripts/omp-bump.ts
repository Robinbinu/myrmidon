/**
 * Moves Myrmidon to another omp release, for .github/workflows/omp-bump.yml (it runs as well by hand):
 *
 *   bun .github/scripts/omp-bump.ts current           the omp version every package pins
 *   bun .github/scripts/omp-bump.ts set <version>     pins every @oh-my-pi package to <version>, patch included
 *   bun .github/scripts/omp-bump.ts changelog <from>  what the installed omp packages changed after <from>, as Markdown
 *
 * Every @oh-my-pi package is pinned exactly, all at one version, as omp releases them together. The patch on pi-ai
 * (package.json patchedDependencies) is named for the version it applies to, so `set` renames it; whether it still
 * applies shows at the next `bun install`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'

const repo = join(import.meta.dir, '..', '..')
const SCOPE = '@oh-my-pi/'
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const VERSION = /^\d+\.\d+\.\d+$/

type Manifest = Record<string, unknown> & Partial<Record<(typeof FIELDS)[number], Record<string, string>>>

const manifests = () => ['package.json', ...new Glob('{packages,apps}/*/package.json').scanSync(repo)]
const read = (file: string): Manifest => JSON.parse(readFileSync(join(repo, file), 'utf8'))
// Two-space JSON with a final newline, as the repository writes package.json.
const write = (file: string, manifest: Manifest) =>
  writeFileSync(join(repo, file), `${JSON.stringify(manifest, null, 2)}\n`)

/** Every pin on an omp package, as `file: name@version`. */
function pins(): { file: string; name: string; version: string }[] {
  return manifests().flatMap((file) => {
    const manifest = read(file)
    return FIELDS.flatMap((field) =>
      Object.entries(manifest[field] ?? {})
        .filter(([name]) => name.startsWith(SCOPE))
        .map(([name, version]) => ({ file, name, version })),
    )
  })
}

function current(): string {
  const versions = new Set(pins().map((p) => p.version))
  if (versions.size !== 1)
    throw new Error(`omp packages are not pinned to one version: ${[...versions].join(', ')}`)
  const [version] = versions
  if (!version || !VERSION.test(version)) throw new Error(`omp is not pinned to an exact version: ${version}`)
  return version
}

function set(next: string): void {
  if (!VERSION.test(next)) throw new Error(`not an exact version: ${next}`)
  const from = current()
  for (const file of manifests()) {
    const manifest = read(file)
    let changed = false
    for (const field of FIELDS)
      for (const name of Object.keys(manifest[field] ?? {}))
        if (name.startsWith(SCOPE)) {
          ;(manifest[field] as Record<string, string>)[name] = next
          changed = true
        }
    const patched = (manifest.patchedDependencies ?? {}) as Record<string, string>
    for (const [key, patch] of Object.entries(patched)) {
      if (!key.startsWith(SCOPE) || !key.endsWith(`@${from}`)) continue
      const renamed = patch.replace(`@${from}.patch`, `@${next}.patch`)
      renameSync(join(repo, patch), join(repo, renamed))
      delete patched[key]
      patched[`${key.slice(0, -from.length)}${next}`] = renamed
      changed = true
    }
    if (changed) write(file, manifest)
  }
}

const parts = (v: string) => v.split('.').map(Number)
function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** Each installed omp package's CHANGELOG sections for releases after `from`, under the package's name. */
function changelog(from: string): string {
  const dir = join(repo, 'packages', 'runtime', 'node_modules', '@oh-my-pi')
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'CHANGELOG.md')
    if (!existsSync(file)) continue
    const sections = readFileSync(file, 'utf8')
      .split(/^(?=## \[)/m)
      .filter((s) => {
        const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(s)?.[1]
        return version !== undefined && newer(version, from)
      })
    // Headings move down two levels, to sit under the package's own heading in the pull request.
    const nested = sections.map((s) => s.replace(/^(#{2,4}) /gm, '$1## '))
    if (sections.length) out.push(`### ${SCOPE}${name}\n\n${nested.join('')}`)
  }
  return out.join('\n').trim() || `No changelog entries after ${from}.`
}

const [command, arg] = process.argv.slice(2)
if (command === 'current') console.log(current())
else if (command === 'set' && arg) set(arg)
else if (command === 'changelog' && arg) console.log(changelog(arg))
else {
  console.error('usage: omp-bump.ts current | set <version> | changelog <from-version>')
  process.exit(2)
}
