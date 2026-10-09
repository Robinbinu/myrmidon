/**
 * Electrobun build hook (postBuild and postWrap in electrobun.config.ts) for what its config cannot say:
 * - macOS asks for the microphone (voice calls) with NSMicrophoneUsageDescription, which a dev build lacks and a
 *   release build has only in a generic wording;
 * - a release build carries the compiled Myrmidon server (scripts/build-sidecar.ts) in Resources/app/sidecar.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopCopy } from '../src/copy.ts'
import { setPlistString } from '../src/plist.ts'

const env = process.env
if (env.ELECTROBUN_OS === 'macos') {
  const bundles = [
    ...readdirSync(env.ELECTROBUN_BUILD_DIR ?? '.')
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(env.ELECTROBUN_BUILD_DIR ?? '.', name)),
    ...(env.ELECTROBUN_WRAPPER_BUNDLE_PATH ? [env.ELECTROBUN_WRAPPER_BUNDLE_PATH] : []),
  ]
  for (const bundle of bundles) {
    const plist = join(bundle, 'Contents', 'Info.plist')
    if (!existsSync(plist)) continue
    const before = readFileSync(plist, 'utf8')
    const after = setPlistString(before, 'NSMicrophoneUsageDescription', desktopCopy.microphoneUsage)
    if (after !== before) {
      writeFileSync(plist, after)
      console.log(desktopCopy.build.patched(plist))
    }
    if (env.ELECTROBUN_BUILD_ENV !== 'dev' && !env.ELECTROBUN_WRAPPER_BUNDLE_PATH) copySidecar(bundle)
  }
}

function copySidecar(bundle: string) {
  const dist = join(import.meta.dir, '..', 'dist')
  const target = join(bundle, 'Contents', 'Resources', 'app', 'sidecar')
  mkdirSync(target, { recursive: true })
  const files = existsSync(dist)
    ? readdirSync(dist).filter((name) => name === 'myrmidon' || /\.(node|dylib)$/.test(name))
    : []
  if (!files.includes('myrmidon')) throw new Error(desktopCopy.build.sidecarMissing(join(dist, 'myrmidon')))
  for (const name of files) copyFileSync(join(dist, name), join(target, name))
  console.log(desktopCopy.build.copied(target))
}
