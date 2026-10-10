/**
 * Electrobun build hook (postBuild and postWrap in electrobun.config.ts) for what its config cannot say:
 * - macOS asks for the microphone (voice calls) with NSMicrophoneUsageDescription, which a dev build lacks and a
 *   release build has only in a generic wording;
 * - a release build carries the compiled Myrmidon server (scripts/build-sidecar.ts) in Resources/app/sidecar, on
 *   every platform (src/platform.ts appBundle says where Resources is).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// Into the app itself, before it is wrapped (a stable build's self-extracting wrapper carries it inside).
if (channel !== 'dev' && !wrapper) {
  if (!existsSync(bundle)) throw new Error(desktopCopy.build.bundleMissing(bundle))
  copySidecar(app.resources(bundle))
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
  console.log(desktopCopy.build.copied(target))
}
