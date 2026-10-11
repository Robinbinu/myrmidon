// Renders review stills of a composition: `node scripts/review.mjs <composition> <scale> <frame> [frame...]`,
// or every Nth frame with `--every N`. Stills land in out/review/<composition>-<frame>.png.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer'

const [id = 'Film', scaleArg = '0.5', ...rest] = process.argv.slice(2)
const scale = Number(scaleArg)
const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'out/review')
mkdirSync(out, { recursive: true })

const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') })
const browser = await openBrowser('chrome')
const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser })

let frames = rest.map(Number)
if (rest[0] === '--every') {
  const every = Number(rest[1])
  frames = []
  for (let f = 0; f < composition.durationInFrames; f += every) frames.push(f)
}
for (const frame of frames) {
  const output = path.join(out, `${id}-${String(frame).padStart(4, '0')}.png`)
  await renderStill({ composition, serveUrl, output, frame, scale, puppeteerInstance: browser, overwrite: true })
  process.stdout.write(`${frame} `)
}
await browser.close({ silent: true })
console.log('\ndone')
