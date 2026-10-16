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
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { BunPlugin } from 'bun'
import tailwind from 'bun-plugin-tailwind'
import { buildVisualLibs } from '../../web/src/visual-libs.ts'
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

// A large JSON file bundled as is becomes one huge object literal, slow to parse at every start; as a string handed to
// JSON.parse it parses fast. Only whole-file imports (`import X from './x.json'`) are rewritten, which is how oh-my-pi
// reads its model catalog (models.json, ~12 MB).
const LARGE_JSON_BYTES = 64 * 1024
const jsonAsString: BunPlugin = {
  name: 'large-json-as-string',
  setup(build) {
    build.onLoad({ filter: /\.json$/ }, async ({ path }) => {
      const file = Bun.file(path)
      if (file.size < LARGE_JSON_BYTES) return undefined
      return { contents: `export default JSON.parse(${JSON.stringify(await file.text())})`, loader: 'js' }
    })
  },
}

// The drawing libraries of visual answers, which the server bundles on first use when run from source, are bundled
// here and carried in the executable as text (apps/web/src/visual-libs.ts).
const visualLibs = await buildVisualLibs()
const visualLibsCarried: BunPlugin = {
  name: 'visual-libs-carried',
  setup(build) {
    build.onLoad({ filter: /[\\/]visual-libs-prebuilt\.ts$/ }, () => ({
      contents: `export const prebuiltVisualLibs = ${JSON.stringify(visualLibs)}`,
      loader: 'ts',
    }))
  },
}

// Minified, not bytecode: Bun stores bytecode beside the source for every module, which made the executable three
// times the size (~290 MB) for a start ~0.4 s quicker, and a slower first launch while macOS checks the larger file.
const result = await Bun.build({
  entrypoints: [join(repo, 'apps/desktop/src/sidecar.ts')],
  target: 'bun',
  minify: true,
  plugins: [tailwind, ortBesideExecutable, jsonAsString, visualLibsCarried],
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
// onnxruntime ships its macOS library with its local symbols (44 MB, 29 MB without). Stripping breaks its signature,
// which Apple silicon needs to load it, so it is signed again (ad hoc; a signed release signs it over). Only for a
// macOS target built on a Mac, where strip and codesign exist and know the format.
if (target.platform === 'darwin' && process.platform === 'darwin') {
  for (const name of onnxRuntimeLibraries(target.platform, readdirSync(folder)).filter((n) =>
    n.endsWith('.dylib'),
  )) {
    const library = join(dist, name)
    for (const command of [
      ['strip', '-x', library],
      ['codesign', '--force', '--sign', '-', library],
    ]) {
      const run = Bun.spawnSync(command, { stdout: 'inherit', stderr: 'inherit' })
      if (run.exitCode !== 0)
        throw new Error(desktopCopy.build.commandFailed(command.join(' '), run.exitCode))
    }
  }
}
// The agents' browser engine, chrome-devtools-mcp, goes beside the executable as its package's build, where
// packages/runtime/src/cdm.ts looks first; the server runs it on its own Bun (BUN_BE_BUN).
const cdm = dirname(Bun.resolveSync('chrome-devtools-mcp/package.json', join(repo, 'packages/runtime')))
rmSync(join(dist, 'chrome-devtools-mcp'), { recursive: true, force: true })
cpSync(join(cdm, 'build'), join(dist, 'chrome-devtools-mcp', 'build'), { recursive: true })
copyFileSync(join(cdm, 'package.json'), join(dist, 'chrome-devtools-mcp', 'package.json'))
console.log(dist)
