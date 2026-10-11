import type { ImportableSkill, SkillImportResult } from '@myrmidon/runtime'
import { setupCopy } from './copy.ts'
import type { Call, Terminal } from './setup.ts'

const t = setupCopy.importSkills

/** Which tools' skills `--from` keeps. */
const FROM: Record<string, readonly ImportableSkill['origin'][]> = {
  claude: ['claude', 'claude-plugin'],
  codex: ['agents', 'codex', 'codex-plugin', 'project'],
}

export interface ImportSkillsOptions {
  /** `claude`, `codex` or `all` (the default). */
  from?: string
  /** Every skill not already here. */
  all?: boolean
  /** Also those the skill scan blocks, after a typed yes. */
  force?: boolean
}

/**
 * `myrmidon import-skills`: lists the person's Claude Code and Codex skills with their scan's verdict, or copies the
 * named ones (or `--all`) into Myrmidon, where each stays off until they switch it on. One the scan blocks comes in
 * only with `--force` and a typed yes, as `skills add` asks.
 */
export async function importSkills(
  call: Call,
  term: Terminal,
  names: readonly string[],
  opts: ImportSkillsOptions = {},
): Promise<void> {
  const s = term.style
  const from = opts.from ?? 'all'
  if (from !== 'all' && !FROM[from]) throw new Error(t.usage)
  const { skills } = await call<{ skills: ImportableSkill[] }>('GET', '/api/skill-imports')
  const shown = skills.filter((x) => from === 'all' || FROM[from]?.includes(x.origin))
  if (!names.length && !opts.all) {
    if (!shown.length) return term.print(t.none)
    for (const x of shown) {
      const verdict = x.scan.verdict === 'block' ? s.red : x.scan.verdict === 'warn' ? s.yellow : s.green
      const notes = [
        x.plugin && t.plugin(x.plugin),
        x.alreadyImported && t.already(x.importedAs ?? x.name),
        !x.alreadyImported && x.importAs !== x.name && t.renamed(x.importAs),
        x.disabledThere && t.offThere,
      ].filter((n): n is string => typeof n === 'string')
      term.print(
        `${t.origins[x.origin].padEnd(14)} ${s.bold(x.name)} ${verdict(t.verdict[x.scan.verdict])}${notes.length ? s.dim(`  ${notes.join(' · ')}`) : ''}`,
      )
    }
    return term.print(s.dim(t.hint))
  }
  const chosen = opts.all
    ? shown.filter((x) => !x.alreadyImported)
    : names.flatMap((name) => {
        const found = shown.filter((x) => x.name === name || x.importAs === name)
        if (!found.length) throw new Error(t.noSuchSkill(name))
        return found
      })
  const blocked = chosen.filter((x) => x.scan.verdict === 'block' && !x.alreadyImported)
  const override = opts.force ? blocked.map((x) => x.id) : []
  if (override.length) {
    if (!term.interactive) throw new Error(t.notInteractive)
    term.print(s.red(t.blockedList(blocked.map((x) => x.name))))
    const answer = (await term.ask(`${t.confirmAnyway}: `)).trim().toLowerCase()
    if (answer !== 'yes' && answer !== 'y') return term.print(t.cancelled)
  }
  if (!chosen.length) return term.print(t.nothingToImport)
  const result = await call<SkillImportResult>('POST', '/api/skill-imports', {
    ids: chosen.map((x) => x.id),
    ...(override.length ? { override } : {}),
  })
  if (result.imported.length) term.print(s.green(t.imported(result.imported.map((x) => x.name))))
  for (const x of result.skipped)
    term.print(
      x.reason === 'blocked'
        ? s.red(t.skippedBlocked(x.name ?? x.id))
        : x.reason === 'already'
          ? s.dim(t.already(x.name ?? x.id))
          : s.yellow(t.failed(x.name ?? x.id, x.error ?? x.reason)),
    )
  if (result.skipped.some((x) => x.reason === 'blocked' || x.reason === 'failed')) process.exitCode = 1
}
