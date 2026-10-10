// The process table as children.test.ts and its stand-in Myrmidon read it, on every OS: Myrmidon's own listing.
import { type ProcessRow, processTable, processTableArgv } from '../../src/leash.ts'

const LISTING = processTableArgv(process.platform).at(-1) ?? ''
/**
 * The host of a console Windows opens for a console program started without one (conhost.exe, its child): whether
 * one opens depends on how each process was started, not on what the command started, so no tree counts it.
 */
const CONSOLE_HOST = /(^|[\\/])conhost\.exe\b/i

/**
 * Every running process (zombies are as good as gone) but console hosts and the listing itself, whose pid Windows soon
 * gives to another process: a test kills every pid it saw once it ends.
 */
export function runningProcesses(): ProcessRow[] {
  const rows = processTable()
  if (!rows) throw new Error('the processes could not be listed')
  return rows.filter((r) => !r.command.includes(LISTING) && !CONSOLE_HOST.test(r.command))
}
