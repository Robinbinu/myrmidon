/**
 * Renders the app icon (assets/icon.svg, the web favicon laid out on Apple's 824/1024 icon grid) into
 * assets/icon.iconset, the sizes macOS asks for, which Electrobun turns into the .icns, and packs those sizes (and
 * a 48 px one) into assets/icon.ico for Windows; Linux uses the iconset's 1024 px PNG. Run it again after changing
 * the SVG: `bun scripts/icons.ts`, or `bun scripts/icons.ts --ico` to repack only the .ico from the iconset. Both
 * outputs are committed, so building the app on Linux or Windows needs neither this script nor macOS.
 *
 * macOS only: Chrome draws it, as it is the one renderer here that keeps the background transparent (QuickLook
 * paints it white), and `sips` resizes it. Headless Chrome writes the screenshot and then may not exit, so it is
 * stopped once the file is there.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packIco } from '../src/ico.ts'

if (process.platform !== 'darwin')
  throw new Error(
    'scripts/icons.ts needs macOS (sips); the icons it makes are committed, so a build does not need it',
  )

const here = fileURLToPath(new URL('..', import.meta.url))
const svg = join(here, 'assets/icon.svg')
const set = join(here, 'assets/icon.iconset')
const ico = join(here, 'assets/icon.ico')
const work = mkdtempSync(join(tmpdir(), 'myr-icon-'))

/** Resizes a PNG with sips. */
function resize(from: string, px: number, to: string) {
  const sips = Bun.spawnSync(['sips', '-z', String(px), String(px), from, '--out', to], { stdout: 'ignore' })
  if (sips.exitCode !== 0) throw new Error(`sips failed for ${to}: ${sips.stderr}`)
}

if (!process.argv.includes('--ico')) await render()
// Windows shows 16, 32, 48 and 256 px; the iconset has all but 48, which comes from its largest image.
const icon48 = join(work, 'icon_48x48.png')
resize(join(set, 'icon_512x512@2x.png'), 48, icon48)
const images = [
  'icon_16x16.png',
  'icon_32x32.png',
  'icon_32x32@2x.png',
  'icon_128x128.png',
  'icon_256x256.png',
]
writeFileSync(ico, packIco([icon48, ...images.map((name) => join(set, name))].map((f) => readFileSync(f))))
rmSync(work, { recursive: true, force: true })
console.log(`wrote ${ico}`)

async function render() {
  const chrome = process.env.MYR_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set MYR_CHROME`)
  const full = join(work, 'icon-1024.png')
  const proc = Bun.spawn(
    [
      chrome,
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--force-device-scale-factor=1',
      '--window-size=1024,1024',
      `--user-data-dir=${join(work, 'profile')}`,
      `--screenshot=${full}`,
      `file://${svg}`,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(full)) {
      if (Date.now() > deadline) throw new Error('Chrome did not render the icon in 30s')
      await Bun.sleep(100)
    }
    // The file appears before Chrome finishes writing it.
    await Bun.sleep(500)
  } finally {
    proc.kill()
    await proc.exited
  }

  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      resize(full, size * scale, join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
  console.log(`wrote ${set}`)
}
