import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseGitUrl } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/git-url'
import { readTar } from '@oh-my-pi/pi-coding-agent/skillshare/tar'
import { INSTALL_FETCH_TIMEOUT_MS, INSTALL_MAX_BYTES, INSTALL_REVIEW_MS, NPM_REGISTRY_URL } from './config.ts'
import { git } from './git.ts'
import { expandHome } from './read-access.ts'

/**
 * Fetching a plugin or skill from where the person pointed: a folder, a git repository, an npm package (or its
 * tarball). Nothing fetched here runs: git clones with no hooks, npm packages are unpacked from their tarball by
 * hand, and dependencies install with lifecycle scripts off. What was fetched is pinned (commit, version, integrity)
 * and recorded, so it can be shown and fetched again for an update.
 *
 * Git URLs are read with omp's parser (`@oh-my-pi/pi-coding-agent/extensibility/plugins/git-url`) and tarballs with
 * its reader (`skillshare/tar`), which refuses links, absolute paths and `..`.
 */

/** The `fetch` installs use; tests pass a stub, so nothing reaches the network. */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Where something installed came from: what to fetch again for an update. */
export type InstallOrigin =
  | { readonly kind: 'folder'; readonly path: string }
  | { readonly kind: 'git'; readonly url: string; readonly ref?: string; readonly subdir?: string }
  | { readonly kind: 'npm'; readonly spec: string; readonly registry?: string }
  | { readonly kind: 'marketplace'; readonly marketplace: string; readonly plugin: string }
  | { readonly kind: 'registry'; readonly spec: string }

/** What one fetch pinned: the exact version, commit and tarball hash that were installed. */
export interface InstallPin {
  readonly version?: string
  readonly commit?: string
  readonly integrity?: string
}

/** An install's record: where it came from and what exactly was installed, when. */
export interface InstalledFrom extends InstallPin {
  readonly origin: InstallOrigin
  /** The origin as the person reads it: a path, a URL, `npm:pkg@1.2`, `plugin@marketplace`. */
  readonly source: string
  readonly installedAt: string
}

/** The origin as one line for the person: the same text they could paste to install it again. */
export function describeOrigin(origin: InstallOrigin): string {
  switch (origin.kind) {
    case 'folder':
      return origin.path
    case 'git':
      return `${origin.url}${origin.ref ? `#${origin.ref}` : ''}${origin.subdir ? ` (${origin.subdir})` : ''}`
    case 'npm':
      return `npm:${origin.spec}`
    case 'marketplace':
      return `${origin.plugin}@${origin.marketplace}`
    case 'registry':
      return origin.spec
  }
}

const SHA = /^[0-9a-f]{7,40}$/i

/** Whether `path` is `root` or inside it, by their resolved paths: neither has to exist yet. */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Whether text is a git source this module fetches: a URL omp's parser knows, `file://`, or a path ending `.git`. */
export function gitSource(text: string): { url: string; ref?: string } | undefined {
  const s = text.trim()
  if (/^file:\/\//i.test(s)) return { url: s }
  const parsed = parseGitUrl(s)
  if (parsed) return { url: parsed.repo, ...(parsed.ref ? { ref: parsed.ref } : {}) }
  // A local repository (often bare) named like a remote one.
  if (/\.git\/?$/.test(s) && existsSync(resolve(expandHome(s)))) return { url: resolve(expandHome(s)) }
  return undefined
}

/**
 * Reads what the person typed: `npm:<package>[@version]`, a `.tgz` file, a git URL (`https://…`, `git@…`,
 * `github:owner/repo#ref`, `file://…`, a path ending `.git`), or else a folder.
 */
export function parseInstallSource(text: string): InstallOrigin {
  const s = text.trim()
  if (!s) throw new Error('give a folder, a git URL or npm:<package>')
  if (/^npm:/i.test(s)) {
    const spec = s.slice(4).trim()
    if (!spec) throw new Error('npm: needs a package name, e.g. npm:my-plugin@1.2.0')
    return { kind: 'npm', spec: /\.(tgz|tar\.gz)$/i.test(spec) ? resolve(expandHome(spec)) : spec }
  }
  if (/\.(tgz|tar\.gz)$/i.test(s)) return { kind: 'npm', spec: resolve(expandHome(s)) }
  const g = gitSource(s)
  if (g) return { kind: 'git', ...g }
  return { kind: 'folder', path: resolve(expandHome(s)) }
}

/** The name an origin suggests when the package itself names none. */
export function originName(origin: InstallOrigin): string {
  switch (origin.kind) {
    case 'folder':
      return basename(origin.path.replace(/[\\/]+$/, ''))
    case 'git':
      return basename((origin.subdir ?? origin.url).replace(/[\\/]+$/, '').replace(/\.git$/, ''))
    case 'npm':
      return isAbsolute(origin.spec)
        ? basename(origin.spec).replace(/(-\d+\.\d+\.\d+[^/]*)?\.(tgz|tar\.gz)$/i, '')
        : (splitNpmSpec(origin.spec).name.split('/').pop() ?? '')
    case 'marketplace':
      return origin.plugin
    case 'registry':
      return origin.spec.replace(/^@[^/]+\//, '').replace(/@.*$/, '')
  }
}

// ── git ──────────────────────────────────────────────────────────────

/**
 * Clones `url` into `dest` (which must not exist) at `ref` (a branch, tag or commit) and returns the commit. Git runs
 * hooks on checkout from the person's own config (`core.hooksPath`, the clone template): an install must run nothing,
 * so both point at an empty folder, and submodules are not fetched. The history is dropped; the commit is the pin.
 */
export async function fetchGit(
  origin: { url: string; ref?: string; subdir?: string },
  dest: string,
): Promise<InstallPin> {
  const parent = dirname(dest)
  const noHooks = join(parent, `.no-hooks-${randomUUID()}`)
  mkdirSync(noHooks, { recursive: true })
  const safe = ['-c', `core.hooksPath=${noHooks}`, '-c', 'protocol.ext.allow=never']
  const ref = origin.ref
  const shallow = !ref ? ['--depth', '1'] : SHA.test(ref) ? [] : ['--depth', '1', '--branch', ref]
  try {
    await git(parent, [
      ...safe,
      'clone',
      `--template=${noHooks}`,
      '--no-recurse-submodules',
      '--quiet',
      ...shallow,
      '--',
      origin.url,
      dest,
    ])
    if (ref && SHA.test(ref)) await git(dest, [...safe, 'checkout', '--quiet', '--detach', ref])
    const commit = (await git(dest, ['rev-parse', 'HEAD'])).trim()
    rmSync(join(dest, '.git'), { recursive: true, force: true })
    if (origin.subdir) keepSubdir(dest, origin.subdir)
    return { commit }
  } finally {
    rmSync(noHooks, { recursive: true, force: true })
  }
}

/** Makes `dest` hold only its `subdir`, refusing a path that leaves it. */
function keepSubdir(dest: string, subdir: string) {
  const inner = resolve(dest, subdir)
  if (inner === dest || !isWithin(dest, inner)) throw new Error(`"${subdir}" is outside the repository`)
  if (!existsSync(inner) || !statSync(inner).isDirectory())
    throw new Error(`the repository has no folder "${subdir}"`)
  const moved = `${dest}.sub`
  renameSync(inner, moved)
  rmSync(dest, { recursive: true, force: true })
  renameSync(moved, dest)
}

// ── folders ──────────────────────────────────────────────────────────

/** Copies a folder, without its git history or installed dependencies. */
export function fetchFolder(path: string, dest: string): InstallPin {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`no folder at ${path}`)
  const skip = [join(path, '.git'), join(path, 'node_modules')]
  cpSync(path, dest, {
    recursive: true,
    filter: (p) => !skip.some((s) => p === s || p.startsWith(s + sep)),
  })
  return {}
}

// ── npm ──────────────────────────────────────────────────────────────

/** omp's check on npm package names (`extensibility/plugins/installer.ts`), which also keeps names off the shell. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/** `name`, `name@range`, `@scope/name@range` → name and range. */
export function splitNpmSpec(spec: string): { name: string; range?: string } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  const name = at < 0 ? spec : spec.slice(0, at)
  const range = at < 0 ? undefined : spec.slice(at + 1)
  if (!NPM_NAME.test(name)) throw new Error(`not an npm package name: ${name}`)
  return { name, ...(range ? { range } : {}) }
}

interface Packument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>
}

/** An exact version, a dist-tag, or the highest version a range allows. */
export function pickNpmVersion(meta: Packument, request = 'latest'): string {
  const versions = Object.keys(meta.versions ?? {})
  if (versions.includes(request)) return request
  const tagged = meta['dist-tags']?.[request]
  if (tagged && versions.includes(tagged)) return tagged
  let best: string | undefined
  for (const v of versions)
    if (Bun.semver.satisfies(v, request) && (!best || Bun.semver.order(v, best) > 0)) best = v
  if (!best) throw new Error(`no version matches "${request}"`)
  return best
}

/** SRI `sha512-<base64>` of some bytes, as npm and the skills registry write it. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`
}

/** Checks bytes against an SRI string (any of its sha512 entries) or, for old packages, a sha1 hex sum. */
function checkIntegrity(bytes: Uint8Array, integrity?: string, shasum?: string) {
  if (integrity?.includes('sha512-')) {
    if (!integrity.split(/\s+/).includes(integrityOf(bytes)))
      throw new Error('the download does not match its published hash; nothing was installed')
    return
  }
  if (shasum) {
    if (new Bun.CryptoHasher('sha1').update(bytes).digest('hex') !== shasum.toLowerCase())
      throw new Error('the download does not match its published hash; nothing was installed')
    return
  }
  throw new Error('the package publishes no hash to check the download against')
}

/** GETs a URL with a timeout and a size cap; the error names what failed. */
export async function download(fetchFn: FetchFn, url: string, what: string): Promise<Uint8Array> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`${what} is not an http(s) URL: ${url}`)
  let res: Response
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(INSTALL_FETCH_TIMEOUT_MS), redirect: 'follow' })
  } catch (err) {
    throw new Error(`cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} from ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > INSTALL_MAX_BYTES) throw new Error(`${what} is larger than ${INSTALL_MAX_BYTES} bytes`)
  return bytes
}

/**
 * Unpacks a gzipped tarball into `dest`, dropping its one top folder (npm's `package/`). Only regular files come out:
 * omp's reader refuses links, devices, absolute paths and `..`.
 */
export function unpackTarball(tgz: Uint8Array, dest: string, stripTop = true): { files: string[] } {
  const entries = readTar(Bun.gunzipSync(new Uint8Array(tgz)))
  const tops = new Set(entries.map((e) => e.path.split('/')[0]))
  const strip = stripTop && tops.size === 1 && entries.every((e) => e.path.includes('/'))
  mkdirSync(dest, { recursive: true })
  const files: string[] = []
  for (const e of entries) {
    const rel = strip ? e.path.slice(e.path.indexOf('/') + 1) : e.path
    const target = resolve(dest, rel)
    if (!isWithin(dest, target)) throw new Error(`the archive has a path outside its folder: ${e.path}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, e.content, { flag: 'wx' })
    chmodSync(target, e.executable ? 0o755 : 0o644)
    files.push(rel)
  }
  return { files }
}

/**
 * Fetches an npm package into `dest` without npm: its tarball comes from the registry (or a local `.tgz`), is checked
 * against the published hash, and is unpacked by hand, so no lifecycle script (`preinstall`, `install`,
 * `postinstall`, `prepare`) gets a chance to run.
 */
export async function fetchNpm(
  origin: { spec: string; registry?: string },
  dest: string,
  fetchFn: FetchFn = (...a) => fetch(...a),
): Promise<InstallPin> {
  let tgz: Uint8Array
  let version: string | undefined
  if (isAbsolute(origin.spec)) {
    if (!existsSync(origin.spec)) throw new Error(`no file at ${origin.spec}`)
    tgz = new Uint8Array(readFileSync(origin.spec))
  } else {
    const { name, range } = splitNpmSpec(origin.spec)
    const registry = (origin.registry ?? NPM_REGISTRY_URL).replace(/\/+$/, '')
    const metaBytes = await download(
      fetchFn,
      `${registry}/${name.replace('/', '%2f')}`,
      `npm package ${name}`,
    )
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as Packument
    version = pickNpmVersion(meta, range)
    const dist = meta.versions?.[version]?.dist
    if (!dist?.tarball) throw new Error(`${name}@${version} has no tarball`)
    tgz = await download(fetchFn, dist.tarball, `${name}@${version}`)
    checkIntegrity(tgz, dist.integrity, dist.shasum)
  }
  unpackTarball(tgz, dest)
  const pkg = readPackageJson(dest)
  return {
    ...(version || pkg?.version ? { version: version ?? pkg?.version } : {}),
    integrity: integrityOf(tgz),
  }
}

// ── dependencies ─────────────────────────────────────────────────────

function readPackageJson(
  dir: string,
): { version?: string; dependencies?: Record<string, string> } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    return {
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
      ...(raw.dependencies && typeof raw.dependencies === 'object'
        ? { dependencies: raw.dependencies as Record<string, string> }
        : {}),
    }
  } catch {
    return undefined
  }
}

/** The packages a fetched folder's package.json depends on; installing them is part of installing it. */
export function dependenciesOf(dir: string): string[] {
  return Object.keys(readPackageJson(dir)?.dependencies ?? {}).sort()
}

/**
 * Installs a fetched package's dependencies with lifecycle scripts off (`--ignore-scripts`), the package's own
 * included: installing must not run its code, which runs only once the person switched it on.
 */
export async function installDependencies(dir: string): Promise<void> {
  if (!dependenciesOf(dir).length) return
  const proc = Bun.spawn(
    [process.execPath, 'install', '--ignore-scripts', '--production', '--no-save', '--no-progress'],
    {
      cwd: dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // A compiled Myrmidon runs as Bun only with BUN_BE_BUN set.
      env: { ...process.env, BUN_BE_BUN: '1' },
      windowsHide: true,
    },
  )
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`installing its dependencies failed: ${err.trim() || `exit ${code}`}`)
}

// ── reviews waiting for the person ───────────────────────────────────

const ID = /^[0-9a-f-]{36}$/

/**
 * Fetched installs waiting for the person's yes: each in its own folder under `root` until confirmed, cancelled or
 * expired (INSTALL_REVIEW_MS). Confirming needs the id the review returned, so nothing installs without one.
 */
export class PendingInstalls<T> {
  private readonly _held = new Map<string, { until: number; value: T }>()

  constructor(
    readonly root: string,
    private readonly ttl = INSTALL_REVIEW_MS,
  ) {}

  /** A fresh folder to fetch into. */
  stage(now = Date.now()): { id: string; dir: string } {
    this.sweep(now)
    const id = randomUUID()
    const dir = join(this.root, id)
    mkdirSync(dir, { recursive: true })
    return { id, dir }
  }

  /** Keeps a fetched install for review; returns when it expires. */
  hold(id: string, value: T, now = Date.now()): string {
    const until = now + this.ttl
    this._held.set(id, { until, value })
    return new Date(until).toISOString()
  }

  /** An install under review, without taking it. */
  peek(id: string, now = Date.now()): T | undefined {
    const held = this._held.get(id)
    return held && held.until >= now ? held.value : undefined
  }

  /** The install the person confirmed, taken out of review; the caller drops its folder when done. */
  take(id: string, now = Date.now()): T & { dir: string } {
    const held = this._held.get(id)
    if (!held || held.until < now) {
      this.drop(id)
      throw new Error('this install was not reviewed, or its review expired: review it again')
    }
    this._held.delete(id)
    return { ...held.value, dir: join(this.root, id) }
  }

  drop(id: string) {
    this._held.delete(id)
    if (ID.test(id)) rmSync(join(this.root, id), { recursive: true, force: true })
  }

  /** Drops expired reviews, and folders left by a fetch that never finished (or a server that stopped). */
  sweep(now = Date.now()) {
    for (const [id, held] of this._held) if (held.until < now) this.drop(id)
    if (!existsSync(this.root)) return
    for (const entry of readdirSync(this.root)) {
      if (this._held.has(entry) || !ID.test(entry)) continue
      const path = join(this.root, entry)
      if (now - statSync(path).mtimeMs > this.ttl) rmSync(path, { recursive: true, force: true })
    }
  }
}
