/**
 * Compiles the Myrmidon server (the CLI's `serve`) into one executable that a release build of the app ships in
 * Resources/app/sidecar (scripts/bundle-hook.ts copies it there). The dashboard's Tailwind CSS goes through the same
 * plugin bunfig.toml gives `bun run dev`. oh-my-pi loads its native addon from beside the executable, so that is
 * copied next to it.
 */
import { copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { desktopCopy } from '../src/copy.ts'

const repo = join(import.meta.dir, '..', '..', '..')
const dist = join(import.meta.dir, '..', 'dist')

const result = await Bun.build({
  entrypoints: [join(repo, 'apps/cli/src/main.ts')],
  target: 'bun',
  plugins: [tailwind],
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
console.log(dist)
