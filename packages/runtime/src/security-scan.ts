import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { OSV, SCAN_FINDINGS, SCAN_MAX_FILE_BYTES, SCAN_MAX_FILES } from './config.ts'
import * as natives from './omp/natives.ts'
import { CREDENTIAL_PATTERNS } from './omp/security.ts'
import { prompts } from './prompts.ts'
import { SKIP_DIRS } from './workspace.ts'

/**
 * The security_scan tool: leaked secrets and dependencies with known vulnerabilities, in the agent's working
 * directory or scratch. Secrets are found with omp's credential shapes (the vendor-prefixed patterns its secret
 * obfuscator hides from providers), plus quoted values given to a secret-named key. Dependencies are read from
 * lockfiles and looked up in OSV.dev. omp's own security_scan is a model-driven review (and Codex Security's cloud),
 * which needs a sub-session and an OpenAI sign-in; this is the deterministic part a scan can do on its own. Nothing
 * here knows the colony: what may be read, and whether the web may be reached, comes in as a scope.
 */

const say = prompts.securityScan

export const SCAN_CHECKS = ['all', 'secrets', 'dependencies'] as const
export type ScanCheck = (typeof SCAN_CHECKS)[number]

export interface ScanScope {
  /** The working directory: findings name files relative to it. */
  readonly root: string
  /** The folder or file to scan, already resolved and allowed for reading. */
  readonly target: string
  /** Whether a file found inside the target may be read (the person's keys and other chats' data may not). */
  mayRead(path: string): boolean
  /** Reaches OSV.dev; absent when the agent may not use the web, and then dependencies are not looked up. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

export interface ScanArgs {
  readonly checks?: ScanCheck
}

export async function securityScan(scope: ScanScope, args: ScanArgs): Promise<string> {
  const checks = args.checks ?? 'all'
  const files = await listFiles(scope)
  const parts: string[] = []
  if (checks !== 'dependencies') parts.push(scanSecrets(scope, files))
  if (checks !== 'secrets') parts.push(await scanDependencies(scope, files))
  return parts.join('\n\n')
}

interface Listing {
  readonly paths: readonly string[]
  /** Files left out because the agent may not read them. */
  readonly hidden: number
  /** Whether the listing stopped at SCAN_MAX_FILES. */
  readonly capped: boolean
}

/** Files git would keep in the target (ignored ones skipped, dotfiles included), without dependency and build folders. */
async function listFiles(scope: ScanScope): Promise<Listing> {
  if (statSync(scope.target).isFile())
    return scope.mayRead(scope.target)
      ? { paths: [scope.target], hidden: 0, capped: false }
      : { paths: [], hidden: 1, capped: false }
  const result = await natives.glob({
    pattern: '**/*',
    path: scope.target,
    fileType: natives.FileType.File,
    gitignore: true,
    hidden: true,
    maxResults: SCAN_MAX_FILES + 1,
    timeoutMs: 60_000,
  })
  const all = result.matches
    .map((m) => resolve(scope.target, m.path))
    .filter(
      (p) =>
        !relative(scope.target, p)
          .split(sep)
          .some((part) => SKIP_DIRS.has(part)),
    )
  const capped = all.length > SCAN_MAX_FILES
  const listed = all.slice(0, SCAN_MAX_FILES)
  const paths = listed.filter((p) => scope.mayRead(p))
  return { paths, hidden: listed.length - paths.length, capped }
}

const shownIn = (root: string) => (path: string) => {
  const rel = relative(root, path)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
    ? rel.split(sep).join('/')
    : path
}

// --- Secrets ---------------------------------------------------------------------------------------------------------

interface Shape {
  readonly kind: string
  readonly re: RegExp
  readonly prefixes?: readonly string[]
  readonly caseless: boolean
}

/** omp's credential shapes, each as a global regex with its literal prefixes for a quick skip. */
const SHAPES: readonly Shape[] = CREDENTIAL_PATTERNS.map((p) => ({
  kind: p.name,
  re: new RegExp(p.source, `${(p.flags ?? '').replace('g', '')}g`),
  ...(p.literalPrefixes ? { prefixes: p.literalPrefixes } : {}),
  caseless: (p.flags ?? '').includes('i'),
}))

/**
 * A quoted literal of 12 or more characters given to a key whose name says it holds a secret: `apiKey = "…"`,
 * `"password": "…"`. omp keeps keyword rules out of its redaction because code must stay readable; here only quoted
 * literals count, so `token: process.env.TOKEN` is not one.
 */
const ASSIGNED =
  /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*(["'])([^"'\s]{12,})\2/gi
/** Values that are clearly a placeholder or a reference, not a secret. */
export const PLACEHOLDER =
  /x{4,}|\*{3,}|\.{3}|your|example|sample|dummy|changeme|placeholder|redacted|<[^>]*>|\$\{|\{\{|%\(|^env:|process\.env/i

/** A secret shown without its value: its first characters and its length. */
export function masked(value: string): string {
  if (value.startsWith('-----BEGIN')) return value.split('\n')[0] ?? value
  return `${value.slice(0, 4)}… (${value.length} chars)`
}

interface Finding {
  readonly file: string
  readonly line: number
  readonly kind: string
  readonly value: string
}

/** The secrets in one file's text, with their 1-based lines. */
export function secretsIn(text: string): { line: number; kind: string; value: string }[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  const lineAt = (index: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const found: { line: number; kind: string; value: string; at: number }[] = []
  const lower = text.toLowerCase()
  for (const shape of SHAPES) {
    if (
      shape.prefixes &&
      !shape.prefixes.some((p) => (shape.caseless ? lower.includes(p.toLowerCase()) : text.includes(p)))
    )
      continue
    for (const m of text.matchAll(shape.re))
      found.push({ line: lineAt(m.index), kind: shape.kind, value: m[0], at: m.index })
  }
  for (const m of text.matchAll(ASSIGNED)) {
    const value = m[3] ?? ''
    const at = m.index + m[0].lastIndexOf(value)
    if (PLACEHOLDER.test(value) || !/\d/.test(value) || !/[A-Za-z]/.test(value)) continue
    // A credential shape already found there says more than "a secret-named key".
    if (found.some((f) => f.at <= at && at < f.at + f.value.length)) continue
    found.push({ line: lineAt(at), kind: say.assignedKind(m[1] ?? ''), value, at })
  }
  return found.sort((a, b) => a.at - b.at).map(({ line, kind, value }) => ({ line, kind, value }))
}

/** Whether a file's first bytes look like binary data, which holds no text to scan. */
const binary = (bytes: Uint8Array) => bytes.subarray(0, 8_192).includes(0)

function scanSecrets(scope: ScanScope, files: Listing): string {
  const shown = shownIn(scope.root)
  const findings: Finding[] = []
  let read = 0
  let large = 0
  for (const path of files.paths) {
    let bytes: Uint8Array
    try {
      if (statSync(path).size > SCAN_MAX_FILE_BYTES) {
        large += 1
        continue
      }
      bytes = readFileSync(path)
    } catch {
      continue
    }
    if (binary(bytes)) continue
    read += 1
    for (const f of secretsIn(Buffer.from(bytes).toString('utf8'))) findings.push({ file: shown(path), ...f })
  }
  const notes = [
    ...(files.hidden ? [say.hiddenFiles(files.hidden)] : []),
    ...(large ? [say.largeFiles(large, SCAN_MAX_FILE_BYTES)] : []),
    ...(files.capped ? [say.capped(SCAN_MAX_FILES)] : []),
  ]
  const head = findings.length ? say.secretsFound(findings.length, read) : say.noSecrets(read)
  const lines = findings
    .slice(0, SCAN_FINDINGS)
    .map((f) => `- ${f.file}:${f.line} ${f.kind}: ${masked(f.value)}`)
  if (findings.length > SCAN_FINDINGS) lines.push(say.more(findings.length - SCAN_FINDINGS))
  return [head, ...lines, ...notes].join('\n')
}

// --- Dependencies ----------------------------------------------------------------------------------------------------

/** OSV's names for the ecosystems the lockfiles below belong to. */
export type Ecosystem = 'npm' | 'PyPI' | 'crates.io' | 'Go'

export interface Dependency {
  readonly ecosystem: Ecosystem
  readonly name: string
  readonly version: string
}

const semverish = (v: string) => /^\d+(\.\d+)*([-+.][0-9A-Za-z.+-]*)?$/.test(v)

/** `name@1.2.3` or `@scope/name@1.2.3` split at the version's `@`. */
function atVersion(spec: string): [string, string] | undefined {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return undefined
  return [spec.slice(0, at), spec.slice(at + 1)]
}

/** `[[package]]` tables with `name` and `version` keys (Cargo.lock, poetry.lock, uv.lock). */
function tomlPackages(text: string, ecosystem: Ecosystem): Dependency[] {
  return text
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .flatMap((block) => {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1]
      const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1]
      return name && version ? [{ ecosystem, name, version }] : []
    })
}

function npmLock(text: string): Dependency[] {
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: string; link?: boolean }>
    dependencies?: Record<string, { version?: string; dependencies?: unknown }>
  }
  if (lock.packages)
    return Object.entries(lock.packages).flatMap(([key, p]) => {
      const name = key.split('node_modules/').at(-1)
      return key && name && p.version && !p.link
        ? [{ ecosystem: 'npm' as const, name, version: p.version }]
        : []
    })
  // lockfileVersion 1: dependencies nested by what requires them.
  const walk = (
    deps: Record<string, { version?: string; dependencies?: unknown }> | undefined,
  ): Dependency[] =>
    Object.entries(deps ?? {}).flatMap(([name, d]) => [
      ...(d.version ? [{ ecosystem: 'npm' as const, name, version: d.version }] : []),
      ...walk(d.dependencies as typeof deps),
    ])
  return walk(lock.dependencies)
}

function bunLock(text: string): Dependency[] {
  return [...text.matchAll(/^\s*"[^"]+":\s*\["((?:@[^@"/]+\/)?[^@"]+@[^"]+)"/gm)].flatMap((m) => {
    const split = atVersion(m[1] ?? '')
    return split ? [{ ecosystem: 'npm' as const, name: split[0], version: split[1] }] : []
  })
}

function pnpmLock(text: string): Dependency[] {
  const section = text.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  return [...section.matchAll(/^ {2}'?\/?((?:@[^@/\s']+\/)?[^@/\s']+)[@/](\d[^:('\s]*)/gm)].map((m) => ({
    ecosystem: 'npm' as const,
    name: m[1] ?? '',
    version: m[2] ?? '',
  }))
}

function yarnLock(text: string): Dependency[] {
  return text.split(/\n(?=\S)/).flatMap((block) => {
    const header = block.split('\n')[0] ?? ''
    if (header.startsWith('#') || !header.endsWith(':')) return []
    const spec = header.slice(0, -1).split(',')[0]?.trim().replace(/^"|"$/g, '') ?? ''
    const name = atVersion(spec)?.[0]
    const version = /^\s+version:? "?([^"\s]+)"?/m.exec(block)?.[1]
    return name && version ? [{ ecosystem: 'npm' as const, name, version }] : []
  })
}

function requirements(text: string): Dependency[] {
  return [...text.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;#,]+)/gm)].map(
    (m) => ({
      ecosystem: 'PyPI' as const,
      name: m[1] ?? '',
      version: m[2] ?? '',
    }),
  )
}

function goSum(text: string): Dependency[] {
  return [...text.matchAll(/^(\S+) v([^\s/]+)(?:\/go\.mod)? /gm)].map((m) => ({
    ecosystem: 'Go' as const,
    name: m[1] ?? '',
    // OSV's Go versions carry no "v" (as osv-scanner sends them).
    version: (m[2] ?? '').replace(/\+incompatible$/, ''),
  }))
}

/** The lockfiles read, by file name, with the ecosystem each belongs to. */
const LOCKFILES: readonly {
  readonly match: (name: string) => boolean
  readonly parse: (text: string) => Dependency[]
}[] = [
  { match: (n) => n === 'package-lock.json' || n === 'npm-shrinkwrap.json', parse: npmLock },
  { match: (n) => n === 'bun.lock', parse: bunLock },
  { match: (n) => n === 'pnpm-lock.yaml', parse: pnpmLock },
  { match: (n) => n === 'yarn.lock', parse: yarnLock },
  { match: (n) => /^requirements.*\.txt$/.test(n), parse: requirements },
  { match: (n) => n === 'poetry.lock' || n === 'uv.lock', parse: (t) => tomlPackages(t, 'PyPI') },
  { match: (n) => n === 'Cargo.lock', parse: (t) => tomlPackages(t, 'crates.io') },
  { match: (n) => n === 'go.sum', parse: goSum },
]

/** The dependencies a lockfile pins, by its file name; none for a file that is not one. */
export function lockfileDependencies(fileName: string, text: string): Dependency[] {
  const kind = LOCKFILES.find((l) => l.match(fileName))
  if (!kind) return []
  const seen = new Set<string>()
  return kind.parse(text).filter((d) => {
    const key = `${d.ecosystem}\0${d.name}\0${d.version}`
    if (!d.name || !semverish(d.version) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface OsvVuln {
  id: string
  summary?: string
  aliases?: string[]
  database_specific?: { severity?: string }
  affected?: {
    package?: { name?: string; ecosystem?: string }
    ranges?: { events?: { fixed?: string }[] }[]
  }[]
}

async function osvJson<T>(scope: ScanScope, url: string, body?: unknown): Promise<T> {
  const fetcher = scope.fetch
  if (!fetcher) throw new Error(say.noWeb)
  const res = await fetcher(url, {
    ...(body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(OSV.timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

/** For each dependency, the ids of the OSV vulnerabilities that affect its version. */
async function osvIds(scope: ScanScope, deps: readonly Dependency[]): Promise<string[][]> {
  const ids: string[][] = []
  for (let i = 0; i < deps.length; i += OSV.batch) {
    const batch = deps.slice(i, i + OSV.batch)
    const res = await osvJson<{ results?: { vulns?: { id?: string }[] }[] }>(scope, OSV.batchUrl, {
      queries: batch.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
    })
    for (let j = 0; j < batch.length; j++)
      ids.push((res.results?.[j]?.vulns ?? []).flatMap((v) => (v.id ? [v.id] : [])))
  }
  return ids
}

/** One vulnerability as the agent reads it: its id and aliases, severity, summary, and the versions that fix it. */
function vulnLine(dep: Dependency, v: OsvVuln | undefined, id: string): string {
  if (!v) return `  ${id}`
  const cve = (v.aliases ?? []).filter((a) => a.startsWith('CVE-'))
  const fixed = [
    ...new Set(
      (v.affected ?? [])
        .filter((a) => a.package?.name === dep.name)
        .flatMap((a) =>
          (a.ranges ?? []).flatMap((r) => (r.events ?? []).flatMap((e) => (e.fixed ? [e.fixed] : []))),
        ),
    ),
  ]
  const severity = v.database_specific?.severity
  return `  ${[id, ...cve].join(' / ')}${severity ? ` [${severity.toLowerCase()}]` : ''}: ${v.summary ?? say.noSummary}${fixed.length ? ` (${say.fixedIn(fixed)})` : ''}`
}

async function scanDependencies(scope: ScanScope, files: Listing): Promise<string> {
  const shown = shownIn(scope.root)
  const locks = files.paths.filter((p) => LOCKFILES.some((l) => l.match(basename(p))))
  if (locks.length === 0) return say.noLockfiles
  const deps: (Dependency & { file: string })[] = []
  const unread: string[] = []
  for (const path of locks)
    try {
      for (const d of lockfileDependencies(basename(path), readFileSync(path, 'utf8')))
        deps.push({ ...d, file: shown(path) })
    } catch {
      unread.push(shown(path))
    }
  const where = locks.map(shown)
  if (!scope.fetch) return say.dependenciesOffline(deps.length, where)
  if (deps.length === 0) return say.noDependencies(where)
  let ids: string[][]
  try {
    ids = await osvIds(scope, deps)
  } catch (err) {
    return say.osvFailed(err instanceof Error ? err.message : String(err))
  }
  const hit = deps.map((d, i) => ({ dep: d, ids: ids[i] ?? [] })).filter((x) => x.ids.length > 0)
  const listed = hit.slice(0, SCAN_FINDINGS)
  // Details only for what is shown: an old framework release can have dozens of advisories.
  const shownIds = [...new Set(listed.flatMap((x) => x.ids.slice(0, OSV.perPackage)))]
  const details = new Map<string, OsvVuln>()
  await Promise.all(
    shownIds.slice(0, OSV.details).map(async (id) => {
      try {
        details.set(id, await osvJson<OsvVuln>(scope, `${OSV.vulnUrl}${encodeURIComponent(id)}`))
      } catch {
        // The id alone is still reported.
      }
    }),
  )
  const notes = unread.length ? [say.unreadLockfiles(unread)] : []
  if (hit.length === 0) return [say.noVulnerabilities(deps.length, where), ...notes].join('\n')
  const lines = listed.flatMap((x) => [
    `- ${x.dep.name}@${x.dep.version} (${x.dep.ecosystem}, ${x.dep.file})`,
    ...x.ids.slice(0, OSV.perPackage).map((id) => vulnLine(x.dep, details.get(id), id)),
    ...(x.ids.length > OSV.perPackage ? [`  ${say.more(x.ids.length - OSV.perPackage)}`] : []),
  ])
  if (hit.length > SCAN_FINDINGS) lines.push(say.more(hit.length - SCAN_FINDINGS))
  if (shownIds.length > OSV.details) lines.push(say.detailsCut(OSV.details))
  return [say.vulnerable(hit.length, deps.length, where), ...lines, ...notes].join('\n')
}
