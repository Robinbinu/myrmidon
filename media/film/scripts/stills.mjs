// Renders the README banner and feature posters (src/stills/) to PNG masters in out/stills/, then encodes each to
// ../../docs/assets/<id>.webp. `node scripts/stills.mjs` does all of them; pass ids to do some, and --png to stop at
// the masters (for review). FFMPEG can point at a specific ffmpeg build (it needs libwebp).
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { getCompositions, openBrowser, renderStill } from '@remotion/renderer'

const args = process.argv.slice(2)
const pngOnly = args.includes('--png')
const wanted = args.filter((a) => !a.startsWith('--'))
const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'out/stills')
const assets = path.resolve(root, '../../docs/assets')
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
// WebP quality: high enough that the hairlines and small type stay crisp.
const QUALITY = process.env.WEBP_QUALITY ?? '88'
mkdirSync(out, { recursive: true })
mkdirSync(assets, { recursive: true })

const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') })
const browser = await openBrowser('chrome')
const stills = (await getCompositions(serveUrl, { puppeteerInstance: browser })).filter(
  (c) => (c.id === 'banner' || c.id.startsWith('feature-')) && (wanted.length === 0 || wanted.includes(c.id)),
)
if (stills.length === 0) throw new Error(`No stills match ${wanted.join(', ') || 'banner / feature-*'}`)

for (const composition of stills) {
  const png = path.join(out, `${composition.id}.png`)
  await renderStill({ composition, serveUrl, output: png, imageFormat: 'png', puppeteerInstance: browser, overwrite: true })
  if (pngOnly) {
    console.log(png)
    continue
  }
  const webp = path.join(assets, `${composition.id}.webp`)
  execFileSync(ffmpeg, [
    '-y', '-v', 'error', '-i', png,
    '-c:v', 'libwebp', '-quality', QUALITY, '-compression_level', '6', '-preset', 'picture',
    webp,
  ])
  console.log(`${path.relative(process.cwd(), webp)}  ${Math.round(statSync(webp).size / 1024)} KB`)
}
await browser.close({ silent: true })
