/**
 * Compiles the Myrmidon server (the CLI's `serve`, through src/sidecar.ts) into one executable that a release build
 * of the app ships in Resources/app/sidecar (scripts/bundle-hook.ts copies it there). The dashboard's Tailwind CSS
 * goes through the same plugin bunfig.toml gives `bun run dev`. oh-my-pi loads its native addon from beside the
 * executable, so that is copied next to it, and so is onnxruntime's (below). Into apps/desktop/dist, or the folder
 * given as the first argument.
 */
import { copyFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BunPlugin } from 'bun'
import tailwind from 'bun-plugin-tailwind'
import { desktopCopy } from '../src/copy.ts'

const repo = join(import.meta.dir, '..', '..', '..')
const dist = process.argv[2] ? resolve(process.argv[2]) : join(import.meta.dir, '..', 'dist')

// onnxruntime-node (the voice engines) requires its addon from inside its package, which a compiled build carries
// and unpacks to a temporary folder, but the addon links to a library beside it (@loader_path) that is not carried.
// Both go beside the executable instead, and the addon is required from there.
const ORT_REQUIRE =
  /require\(`\.\.\/bin\/napi-v\d+\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/
const ORT_LIBRARY = process.platform === 'darwin' ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1'
const ortBesideExecutable: BunPlugin = {
  name: 'onnxruntime-beside-executable',
  setup(build) {
    build.onLoad({ filter: /[\\/]onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const contents = source.replace(
        ORT_REQUIRE,
        "require(require('node:path').join(require('node:path').dirname(process.execPath), 'onnxruntime_binding.node'))",
      )
      if (contents === source) throw new Error(desktopCopy.build.ortChanged(path))
      return { contents, loader: 'js' }
    })
  },
}

const result = await Bun.build({
  entrypoints: [join(repo, 'apps/desktop/src/sidecar.ts')],
  target: 'bun',
  plugins: [tailwind, ortBesideExecutable],
  // An optional import oh-my-pi makes only for legacy pi plugins, which Myrmidon does not use.
  external: ['omp-legacy-pi-modules'],
  compile: { outfile: join(dist, 'myrmidon') },
})
for (const log of result.logs) console.error(log)
if (!result.success) process.exit(1)

const addon = `pi_natives.${process.platform}-${process.arch}.node`
const [found] = new Bun.Glob(
  `node_modules/.bun/@oh-my-pi+pi-natives-*/node_modules/@oh-my-pi/*/${addon}`,
).scanSync({ cwd: repo, dot: true })
if (!found) throw new Error(desktopCopy.build.addonMissing(addon))
copyFileSync(join(repo, found), join(dist, basename(found)))

const ort = dirname(dirname(Bun.resolveSync('onnxruntime-node', join(repo, 'packages/runtime'))))
const [binding] = new Bun.Glob(
  `bin/napi-v*/${process.platform}/${process.arch}/onnxruntime_binding.node`,
).scanSync({ cwd: ort })
if (!binding) throw new Error(desktopCopy.build.addonMissing('onnxruntime_binding.node'))
for (const name of [basename(binding), ORT_LIBRARY])
  copyFileSync(join(ort, dirname(binding), name), join(dist, name))
console.log(dist)
