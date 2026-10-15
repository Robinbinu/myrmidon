/**
 * The packaged macOS app, tried the way a person's Mac first meets it (docs/verification.md, tier 3). Catches what
 * the suite cannot see from the source tree: beta.1 and beta.2 shipped a bundle whose signature covered none of its
 * resources ("damaged" on other Macs), and beta.3 shipped an app that could not start its own server (leash.ts
 * missing beside the code) and then could not run a full-access command (the compiled leash). Neither showed on the
 * build machine, where a dev server was already running for the app to join.
 *
 *   bun scripts/smoke-desktop.ts [--skip-build] [--keep] [--strict-archive]
 *
 * It builds the release (`bun run desktop:build`) unless --skip-build, unpacks the update archive into a temporary
 * folder, launches it with an empty HOME (so no server, settings or login of this machine's can help it), waits for
 * the server it starts, runs a full-access command through the app's own compiled leash, checks the signatures of
 * the unpacked app and of the app inside the DMG, quits the app and checks its server went with it. --keep leaves the
 * temporary folder for a look; --strict-archive makes the update archive's signature block too (see SEAL_NOTE).
 * Exits 1 when a blocking check fails. macOS only; it opens the app's window for a few seconds.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { LEASH_COMMAND } from '../packages/runtime/src/config.ts'

/** The first start on a machine loads every model provider; the app itself waits 90 s (SERVER_START_TIMEOUT_MS). */
const START_TIMEOUT_MS = 120_000
/** How long the server may take to go once the app is asked to quit (the app gives it 10 s, then the leash). */
const STOP_TIMEOUT_MS = 20_000
const POLL_MS = 500
const LOG_TAIL_CHARS = 2_000

/**
 * Why the update archive's seal is advisory by default: Electrobun writes Resources/version.json into the app after
 * the build hook has signed it and before it packs the archive, so the app in the archive (the one the DMG's wrapper
 * unpacks, and the one an update installs) fails a strict check on that one file. It still starts, since a locally
 * unpacked app carries no quarantine; the DMG's own app, which Gatekeeper judges, is blocking.
 */
const SEAL_NOTE =
  'Electrobun rewrites Resources/version.json after the build hook signs the app (see SEAL_NOTE in this script)'

const { values } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'strict-archive': { type: 'boolean', default: false },
  },
})

if (process.platform !== 'darwin') {
  console.error('smoke-desktop: the packaged-app smoke test runs on macOS only')
  process.exit(2)
}

const repo = join(import.meta.dir, '..')
const desktop = join(repo, 'apps', 'desktop')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const archive = join(desktop, 'artifacts', `stable-macos-${arch}-Myrmidon.app.tar.zst`)
const dmg = join(desktop, 'artifacts', `macos-${arch}-Myrmidon.dmg`)

interface Check {
  name: string
  ok: boolean
  blocking: boolean
  detail?: string
}
const checks: Check[] = []
function record(name: string, ok: boolean, detail?: string, blocking = true) {
  checks.push({ name, ok, blocking, ...(detail ? { detail } : {}) })
  const mark = ok ? 'ok  ' : blocking ? 'FAIL' : 'warn'
  console.log(`${mark} ${name}${detail ? `\n       ${detail.replaceAll('\n', '\n       ')}` : ''}`)
}

function sh(argv: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const run = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', ...options })
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

const tail = (text: string) => text.trim().slice(-LOG_TAIL_CHARS)
/** codesign's verdict without its per-file "--prepared/--validated" progress lines. */
const verdict = (text: string) =>
  tail(
    text
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n'),
  )
const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(
  what: () => T | undefined | Promise<T | undefined>,
  ms: number,
): Promise<T | undefined> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const found = await what()
    if (found !== undefined) return found
    await Bun.sleep(POLL_MS)
  }
  return undefined
}

if (!values['skip-build']) {
  console.log('building the release (bun run desktop:build)…')
  const build = Bun.spawnSync([process.execPath, 'run', 'desktop:build'], {
    cwd: repo,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (build.exitCode !== 0) {
    console.error(`smoke-desktop: the build failed (exit ${build.exitCode})`)
    process.exit(1)
  }
}
for (const file of [archive, dmg])
  if (!existsSync(file)) {
    console.error(`smoke-desktop: no ${file}; build first, or drop --skip-build`)
    process.exit(1)
  }

// realpath: /var/folders is a symlink, and the server writes resolved paths.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-smoke-')))
const unpacked = join(root, 'unpacked')
const home = join(root, 'home')
const mount = join(root, 'dmg')
for (const dir of [unpacked, home, mount]) mkdirSync(dir)
const app = join(unpacked, 'Myrmidon.app')
const myrHome = join(home, '.myrmidon')
const serverFile = join(myrHome, 'server.json')
const serverLog = join(myrHome, 'logs', 'desktop-server.log')
const launcherLog = join(root, 'launcher.log')

let launcher: Bun.Subprocess | undefined
let serverPid: number | undefined
let mounted = false

try {
  // 1. Unpack the update archive, as the DMG's wrapper does on first launch.
  const untar = sh(['tar', '--zstd', '-xf', archive, '-C', unpacked])
  record('the update archive unpacks', untar.code === 0 && existsSync(app), untar.err.trim() || undefined)
  if (!existsSync(app)) throw new Error('nothing to launch')

  const leashFile = join(app, 'Contents', 'Resources', 'app', 'bun', 'leash.ts')
  const sidecar = join(app, 'Contents', 'Resources', 'app', 'sidecar', 'myrmidon')
  record('the app carries leash.ts beside its code', existsSync(leashFile), leashFile)
  record('the app carries the compiled server', existsSync(sidecar), sidecar)

  // 2. Signatures: the unpacked app, and the app in the DMG (what a person downloads and Gatekeeper judges).
  const seal = sh(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
  record(
    'codesign --verify --deep --strict: the app in the update archive',
    seal.code === 0,
    seal.code === 0 ? undefined : `${verdict(seal.err)}\n${SEAL_NOTE}`,
    values['strict-archive'],
  )
  const attach = sh(['hdiutil', 'attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
  mounted = attach.code === 0
  record('the DMG mounts', mounted, mounted ? undefined : tail(attach.err))
  if (mounted) {
    const inDmg = join(mount, 'Myrmidon.app')
    const dmgSeal = sh(['codesign', '--verify', '--deep', '--strict', '--verbose=2', inDmg])
    record(
      'codesign --verify --deep --strict: the app inside the DMG',
      existsSync(inDmg) && dmgSeal.code === 0,
      dmgSeal.code === 0 ? undefined : verdict(dmgSeal.err),
    )
  }

  // 3. Launch with an empty HOME: nothing of this machine's (a running server, settings, MYRMIDON_HOME) can help.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  for (const name of Object.keys(env)) if (name.startsWith('MYRMIDON_')) delete env[name]
  const out = Bun.file(launcherLog)
  launcher = Bun.spawn([join(app, 'Contents', 'MacOS', 'launcher')], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: out,
    stderr: out,
  })

  type ServerFile = { url: string; token: string; pid: number; launch?: string }
  const server = await waitFor<ServerFile>(async () => {
    if (launcher?.exitCode !== null) return undefined
    try {
      const file = JSON.parse(readFileSync(serverFile, 'utf8')) as ServerFile
      const res = await fetch(new URL('/api/whoami', file.url), {
        headers: { authorization: `Bearer ${file.token}` },
        signal: AbortSignal.timeout(2_000),
      })
      return res.ok ? file : undefined
    } catch {
      return undefined
    }
  }, START_TIMEOUT_MS)
  serverPid = server?.pid
  record(
    'the app starts its own server: server.json written and the API answers with its token',
    server !== undefined,
    server
      ? `${server.url} (pid ${server.pid})`
      : `launcher ${launcher.exitCode === null ? 'still running' : `exited ${launcher.exitCode}`}\n` +
          `desktop-server.log:\n${tail(readText(serverLog)) || '(empty)'}\nlauncher:\n${tail(readText(launcherLog))}`,
  )
  // Only a server the app started carries its launch ID: a server found already running would not.
  record('server.json names the app as its launcher', typeof server?.launch === 'string')
  record('the server logs to logs/desktop-server.log', existsSync(serverLog), serverLog)
  if (server) {
    const res = await fetch(new URL('/', server.url), { signal: AbortSignal.timeout(5_000) }).catch(
      () => undefined,
    )
    const page = res?.ok ? await res.text() : ''
    record('the dashboard page is served', page.includes('<html'), res ? `HTTP ${res.status}` : 'no answer')
  }

  // 4. A full-access command runs on a leash started from the server's own executable (sandbox.ts runLeashed):
  //    the same binary, from outside the repository, with no leash.ts of its own on disk.
  const marker = `smoke-${crypto.randomUUID()}`
  const leashed = sh([sidecar, LEASH_COMMAND, '--grace=200', '/bin/sh', '-c', `echo "$SMOKE_MARKER"; pwd`], {
    cwd: root,
    env: { ...env, SMOKE_MARKER: marker },
  })
  record(
    'a full-access command runs through the compiled leash',
    leashed.code === 0 && leashed.out.includes(marker) && !leashed.err.includes('Module not found'),
    leashed.code === 0 ? undefined : `exit ${leashed.code}\n${tail(leashed.err)}`,
  )

  // 5. Quit: the server the app started goes with it, and leaves no server.json behind.
  launcher.kill('SIGTERM')
  const quit = await waitFor(
    () => (launcher?.exitCode !== null || launcher?.signalCode ? true : undefined),
    10_000,
  )
  if (!quit) launcher.kill('SIGKILL')
  if (serverPid !== undefined) {
    const pid = serverPid
    const gone = await waitFor(() => (alive(pid) ? undefined : true), STOP_TIMEOUT_MS)
    record('quitting the app stops its server', gone === true, gone ? undefined : `pid ${pid} still running`)
    record('quitting the app removes server.json', !existsSync(serverFile), undefined, false)
  }
} catch (err) {
  record('the smoke test ran to the end', false, err instanceof Error ? err.message : String(err))
} finally {
  if (launcher && launcher.exitCode === null) launcher.kill('SIGKILL')
  if (serverPid !== undefined && alive(serverPid)) {
    process.kill(serverPid, 'SIGKILL')
    console.log(`killed the server it left running (pid ${serverPid})`)
  }
  if (mounted) sh(['hdiutil', 'detach', mount, '-force'])
  if (values.keep) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok && c.blocking)
const warned = checks.filter((c) => !c.ok && !c.blocking)
console.log(
  `\nsmoke-desktop: ${checks.length - failed.length - warned.length}/${checks.length} passed` +
    (warned.length ? `, ${warned.length} advisory warning(s)` : '') +
    (failed.length ? `, ${failed.length} FAILED` : ''),
)
if (process.env.GITHUB_ACTIONS)
  for (const c of [...failed, ...warned])
    console.log(`::${c.blocking ? 'error' : 'warning'}::smoke-desktop: ${c.name}`)
process.exit(failed.length ? 1 : 0)
