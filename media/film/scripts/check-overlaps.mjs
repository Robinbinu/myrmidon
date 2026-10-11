// Proves the film's text never collides: `node scripts/check-overlaps.mjs [composition] [--every N] [--from F] [--to F]`.
// Renders frames with the composition's debug probe on (src/components/Debug.tsx), which measures every text element
// and everything laid over the scene, and reports:
//   - text that overlaps other text,
//   - text that leaves its container (or overflows its own box),
//   - a caption that lands on UI,
//   - something laid over the scene (mail, a cursor's tag, a card or bubble in flight, the stamp) covering text.
// It samples every 6 frames, and every 2 through the moments things fly. Something laid over the scene may sweep
// across text on its way (it moved more than MOVING px a frame since the last sample); resting on text fails.
// Exits 1 with a list of problems, or 0 when the film is clean.
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const id = args[0] && !args[0].startsWith('--') ? args[0] : 'Film'
const every = opt('every', 6)
const MOVING = 2.5
/** Where things fly in Film: the throw, the question's dots, the bubble, the spawn, the mail, the fold, the stamp,
 * the bars becoming chips, the burst. Sampled every 2 frames. */
const DENSE = [
  [330, 430],
  [560, 680],
  [1110, 1220],
  [1400, 1490],
  [1700, 1820],
  [1900, 2050],
  [2240, 2420],
  [2520, 2720],
  [2900, 3060],
  [3600, 3720],
  [3990, 4120],
]
const root = path.resolve(import.meta.dirname, '..')

const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') })
const browser = await openBrowser('chrome')
const inputProps = { debug: true }
const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser, inputProps })
const from = opt('from', 0)
const to = opt('to', composition.durationInFrames - 1)

const wanted = new Set()
for (let f = from; f <= to; f += every) wanted.add(f)
if (id === 'Film' && !args.includes('--every'))
  for (const [a, b] of DENSE) for (let f = Math.max(a, from); f <= Math.min(b, to); f += 2) wanted.add(f)
const frames = [...wanted].sort((a, b) => a - b)

const reports = []
for (const frame of frames) {
  let report = null
  await renderStill({
    composition,
    serveUrl,
    output: path.join(root, 'out/check-overlaps.png'),
    frame,
    scale: 0.25,
    inputProps,
    puppeteerInstance: browser,
    overwrite: true,
    logLevel: 'error',
    onBrowserLog: (log) => {
      if (log.text.startsWith('OVERLAP ')) report = JSON.parse(log.text.slice('OVERLAP '.length))
    },
  })
  if (!report) throw new Error(`frame ${frame}: the debug probe reported nothing`)
  reports.push(report)
  if (reports.length % 50 === 0) process.stdout.write(`${frame} `)
}
await browser.close({ silent: true })
console.log()

/** How fast a cover moved, in px a frame, since the sample before (0 when it was not there yet: arriving counts as resting). */
function speed(i, cover) {
  const now = reports[i]?.covers.find((c) => c.id === cover)
  const before = reports[i - 1]?.covers.find((c) => c.id === cover)
  if (!now?.at || !before?.at) return 0
  const dt = (reports[i]?.frame ?? 0) - (reports[i - 1]?.frame ?? 0)
  const dx = now.at.x + now.at.w / 2 - (before.at.x + before.at.w / 2)
  const dy = now.at.y + now.at.h / 2 - (before.at.y + before.at.h / 2)
  return Math.hypot(dx, dy) / Math.max(1, dt)
}

const failures = []
reports.forEach((r, i) => {
  for (const p of r.problems) if (!p.cover || speed(i, p.cover) <= MOVING) failures.push({ frame: r.frame, ...p })
})

const texts = reports.reduce((n, r) => n + r.texts, 0)
console.log(`${reports.length} frames, ${texts} text boxes measured`)
if (failures.length === 0) {
  console.log('No overlaps: no text on text, no text outside its box, no caption on UI, nothing resting on text.')
  process.exit(0)
}
for (const p of failures)
  console.log(
    `frame ${String(p.frame).padStart(4)}  ${p.kind}: "${p.a}"${p.b ? ` × "${p.b}"` : ''}${p.at ? ` at ${Math.round(p.at.x)},${Math.round(p.at.y)} ${Math.round(p.at.w)}×${Math.round(p.at.h)}` : ''}`,
  )
console.log(`${failures.length} problems`)
process.exit(1)
