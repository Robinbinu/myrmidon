/**
 * Compiles the Myrmidon server (the CLI's `serve`, through src/sidecar.ts) into one executable that a release build
 * of the app ships in Resources/app/sidecar (scripts/bundle-hook.ts copies it there). The dashboard's Tailwind CSS
 * goes through the same plugin bunfig.toml gives `bun run dev`. oh-my-pi loads its native addon from beside the
 * executable, so that is copied next to it, and so is onnxruntime's (below).
 *
 *   bun scripts/build-sidecar.ts [out folder] [--target=bun-linux-x64]
 *
 * For the host by default; `--target` names another platform Bun compiles for (src/platform.ts SIDECAR_TARGETS),
 * which needs that platform's oh-my-pi addon installed: `bun install --os='*' --cpu='*'` installs them all. Into
 * apps/desktop/dist/<platform>-<arch> (where the build hook looks), or the folder given.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { BunPlugin } from 'bun'
import tailwind from 'bun-plugin-tailwind'
import { desktopCopy } from '../src/copy.ts'
import { executableName, onnxRuntimeLibraries, sidecarDist, sidecarTarget } from '../src/platform.ts'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: 'string' } },
  allowPositionals: true,
})
const target = sidecarTarget(values.target, process)
const desktop = join(import.meta.dir, '..')
const repo = join(desktop, '..', '..')
const dist = positionals[0] ? resolve(positionals[0]) : sidecarDist(desktop, target.platform, target.arch)
mkdirSync(dist, { recursive: true })

// onnxruntime-node (the voice engines) requires its addon from inside its package, which a compiled build carries
// and unpacks to a temporary folder, but the addon links to a library beside it (@loader_path, $ORIGIN) that is not
// carried. Both go beside the executable instead, and the addon is required from there.
const ORT_REQUIRE =
  /require\(`\.\.\/bin\/napi-v\d+\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/
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
  compile: { target: target.bun, outfile: join(dist, executableName('myrmidon', target.platform)) },
})
for (const log of result.logs) console.error(log)
if (!result.success) process.exit(1)

// The addon's package for each platform is an optional dependency; on x64 it may come as -modern and -baseline
// builds, which its loader picks between at runtime, so every one of them goes.
const tag = `${target.platform}-${target.arch}`
const addons = [
  ...new Bun.Glob(
    `node_modules/.bun/@oh-my-pi+pi-natives-${tag}@*/node_modules/@oh-my-pi/*/pi_natives.${tag}*.node`,
  ).scanSync({ cwd: repo, dot: true }),
]
if (!addons.length) throw new Error(desktopCopy.build.addonMissing(`pi_natives.${tag}.node`))
for (const found of addons) copyFileSync(join(repo, found), join(dist, basename(found)))

const ort = dirname(dirname(Bun.resolveSync('onnxruntime-node', join(repo, 'packages/runtime'))))
const [binding] = new Bun.Glob(
  `bin/napi-v*/${target.platform}/${target.arch}/onnxruntime_binding.node`,
).scanSync({
  cwd: ort,
})
if (!binding) throw new Error(desktopCopy.build.ortMissing(tag))
const folder = join(ort, dirname(binding))
for (const name of [basename(binding), ...onnxRuntimeLibraries(target.platform, readdirSync(folder))])
  copyFileSync(join(folder, name), join(dist, name))
console.log(dist)
