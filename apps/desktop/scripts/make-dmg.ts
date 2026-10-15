/**
 * Makes the macOS disk image from the stable build (Electrobun's own is off: mac.createDmg in electrobun.config.ts).
 * hdiutil sizes an image from its source folder by itself, and on current macOS that leaves too little room for the
 * app ("No space left on device"), so the size is given: the app's size with headroom.
 */
import { spawnSync } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import config from '../electrobun.config.ts'
import { DMG_HEADROOM, DMG_SLACK_MB } from '../src/config.ts'
import { desktopCopy } from '../src/copy.ts'

const root = join(import.meta.dir, '..')
const app = join(root, 'build', 'stable-macos-arm64', `${config.app.name}.app`)
const dmg = join(root, 'artifacts', 'macos-arm64-Myrmidon.dmg')

const run = (command: string, args: string[], quiet = false) => {
  const done = spawnSync(command, args, { stdio: quiet ? 'pipe' : 'inherit' })
  if (done.status !== 0)
    throw new Error(desktopCopy.build.commandFailed(`${command} ${args.join(' ')}`, done.status))
  return done.stdout?.toString() ?? ''
}

if (process.platform !== 'darwin' || !statSync(app, { throwIfNoEntry: false })) process.exit(0)
const kb = Number(run('du', ['-sk', app], true).split('\t')[0])
const mb = Math.ceil((kb / 1024) * DMG_HEADROOM) + DMG_SLACK_MB
rmSync(dmg, { force: true })
run('hdiutil', [
  'create',
  '-size',
  `${mb}m`,
  '-volname',
  config.app.name,
  '-srcfolder',
  app,
  '-format',
  'UDZO',
  dmg,
])
console.log(desktopCopy.build.dmg(dmg))
