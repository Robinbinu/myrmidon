/**
 * Electrobun build hook (postBuild and postWrap in electrobun.config.ts) for what its config cannot say:
 * - macOS asks for the microphone (voice calls) with NSMicrophoneUsageDescription, which a dev build lacks and a
 *   release build has only in a generic wording;
 * - a release build carries the compiled Myrmidon server (scripts/build-sidecar.ts) in Resources/app/sidecar, on
 *   every platform (src/platform.ts appBundle says where Resources is);
 * - with no Developer ID (`mac.codesign` off), a macOS release bundle is signed ad hoc as a whole after those edits.
 *   Electrobun only leaves its launcher linker-signed, so the bundle's signature covers none of its resources, and a
 *   Mac that downloaded it calls it damaged; sealed, it is an unidentified developer's app that can be allowed.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import config from '../electrobun.config.ts'
import { desktopCopy } from '../src/copy.ts'
import {
  appBundle,
  asArch,
  type ElectrobunOs,
  executableName,
  platformOf,
  sidecarDist,
  sidecarFiles,
} from '../src/platform.ts'
import { setPlistString } from '../src/plist.ts'

const env = process.env
const os = (env.ELECTROBUN_OS ?? '') as ElectrobunOs
const platform = platformOf(os)
const arch = asArch(env.ELECTROBUN_ARCH ?? process.arch)
const channel = env.ELECTROBUN_BUILD_ENV ?? 'dev'
const buildDir = env.ELECTROBUN_BUILD_DIR ?? '.'
const wrapper = env.ELECTROBUN_WRAPPER_BUNDLE_PATH
const app = appBundle(os, config.app.name, channel)
const bundle = join(buildDir, app.name)
/** Folders the sidecar runs from besides its own files: the agents' browser engine. */
const SIDECAR_FOLDERS = ['chrome-devtools-mcp']

if (os === 'macos')
  for (const each of [bundle, ...(wrapper ? [wrapper] : [])]) {
    const plist = join(each, 'Contents', 'Info.plist')
    if (!existsSync(plist)) continue
    const before = readFileSync(plist, 'utf8')
    const after = setPlistString(before, 'NSMicrophoneUsageDescription', desktopCopy.microphoneUsage)
    if (after !== before) {
      writeFileSync(plist, after)
      console.log(desktopCopy.build.patched(plist))
    }
  }

// The leash that stops the server with the app (packages/runtime/src/leashed.ts) is read beside the app's code.
// Electrobun's bundler leaves leashed.ts's text import of it as a file to load at run time, so without this copy an
// app that has to start its own server fails with "Module not found …/app/bun/leash.ts".
if (!wrapper) {
  if (!existsSync(bundle)) throw new Error(desktopCopy.build.bundleMissing(bundle))
  const code = join(app.resources(bundle), 'app', 'bun')
  mkdirSync(code, { recursive: true })
  copyFileSync(
    join(import.meta.dir, '..', '..', '..', 'packages', 'runtime', 'src', 'leash.ts'),
    join(code, 'leash.ts'),
  )
}

// Into the app itself, before it is wrapped (a stable build's self-extracting wrapper carries it inside).
if (channel !== 'dev' && !wrapper) {
  if (!existsSync(bundle)) throw new Error(desktopCopy.build.bundleMissing(bundle))
  copySidecar(app.resources(bundle))
}

// Last, so the signature covers every edit above: the app before it is packed, then the wrapper that carries it.
if (os === 'macos' && channel !== 'dev' && !(config.build.mac as { codesign?: boolean }).codesign)
  signAdHoc(wrapper ?? bundle)

function signAdHoc(path: string) {
  for (const args of [
    ['--force', '--deep', '--sign', '-', path],
    ['--verify', '--deep', '--strict', path],
  ]) {
    const run = spawnSync('codesign', args, { stdio: 'inherit' })
    if (run.status !== 0)
      throw new Error(desktopCopy.build.commandFailed(`codesign ${args.join(' ')}`, run.status))
  }
  console.log(desktopCopy.build.signed(path))
}

function copySidecar(resources: string) {
  const dist = sidecarDist(join(import.meta.dir, '..'), platform, arch)
  const executable = executableName('myrmidon', platform)
  const files = existsSync(dist) ? sidecarFiles(platform, readdirSync(dist)) : []
  if (!files.includes(executable)) {
    const bunOs = platform === 'win32' ? 'windows' : platform
    throw new Error(desktopCopy.build.sidecarMissing(join(dist, executable), `bun-${bunOs}-${arch}`))
  }
  const target = join(resources, 'app', 'sidecar')
  mkdirSync(target, { recursive: true })
  for (const name of files) copyFileSync(join(dist, name), join(target, name))
  // The agents' browser engine (build-sidecar.ts), as a folder beside the executable.
  for (const folder of SIDECAR_FOLDERS) {
    if (!existsSync(join(dist, folder)))
      throw new Error(desktopCopy.build.sidecarMissing(join(dist, folder), platform))
    cpSync(join(dist, folder), join(target, folder), { recursive: true })
  }
  console.log(desktopCopy.build.copied(target))
}
