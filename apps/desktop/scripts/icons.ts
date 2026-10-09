/**
 * Renders the app icon (assets/icon.svg, the web favicon laid out on Apple's 824/1024 icon grid) into
 * assets/icon.iconset, the sizes macOS asks for, which Electrobun turns into the .icns. Run it again after changing
 * the SVG: `bun scripts/icons.ts`.
 *
 * Chrome draws it, as it is the one renderer here that keeps the background transparent (QuickLook paints it white);
 * headless Chrome writes the screenshot and then may not exit, so it is stopped once the file is there.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('..', import.meta.url).pathname
const svg = join(here, 'assets/icon.svg')
const set = join(here, 'assets/icon.iconset')
const chrome = process.env.MYR_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set MYR_CHROME`)

const work = mkdtempSync(join(tmpdir(), 'myr-icon-'))
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
  for (const scale of [1, 2]) {
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    const px = String(size * scale)
    const sips = Bun.spawnSync(['sips', '-z', px, px, full, '--out', join(set, name)], { stdout: 'ignore' })
    if (sips.exitCode !== 0) throw new Error(`sips failed for ${name}: ${sips.stderr}`)
  }
rmSync(work, { recursive: true, force: true })
console.log(`wrote ${set}`)
