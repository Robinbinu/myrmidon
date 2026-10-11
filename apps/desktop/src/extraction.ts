import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Removes the archives Electrobun keeps after the app unpacks itself (`<userData>/self-extraction/<hash>.tar`, over
 * 400 MB). Electrobun keeps one only as the base for delta updates through its own updater, which Myrmidon does not
 * use: new versions come as full downloads from GitHub releases. Its updater and uninstaller both find the app's
 * folder by `.electrobun-uninstall.json` when the archive is gone, and a missing archive makes an update a full
 * download, never a failure. Returns how many bytes were freed.
 */
export function removeRetainedArchives(userData: string): number {
  const folder = join(userData, 'self-extraction')
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return 0
  }
  let freed = 0
  for (const name of names) {
    if (!name.endsWith('.tar')) continue
    const path = join(folder, name)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    // Only the archive files themselves: never follow a link out of the folder.
    if (!stat?.isFile()) continue
    rmSync(path)
    freed += stat.size
  }
  return freed
}
