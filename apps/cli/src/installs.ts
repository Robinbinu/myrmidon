import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type SkillScan, scanSkill } from '@myrmidon/runtime'
import { setupCopy } from './copy.ts'
import type { Call, Terminal } from './setup.ts'

const t = setupCopy.installs

/** What the server says a fetch holds (packages/runtime PluginPreview and SkillPreview, the fields shown here). */
interface Preview {
  id: string
  name?: string
  skills?: string[] | { name: string; description: string }[]
  source: string
  version?: string
  commit?: string
  integrity?: string
  server?: string
  ui?: string
  hooks?: number
  mcpServers?: string[]
  commands?: string[]
  dependencies?: string[]
  scripts?: string[]
  warnings?: string[]
  scan?: SkillScan
  replaces?: { version?: string; commit?: string }
}

/** `--force`: install what the skill scan blocks, after the same typed yes. */
export interface InstallOptions {
  force?: boolean
}

/** A scan's findings, worst first, each with where it is and why it matters. */
function printScan(term: Terminal, scan: SkillScan, indent = '  ') {
  const s = term.style
  const tone = { critical: s.red, high: s.yellow, medium: s.dim, low: s.dim } as const
  for (const f of scan.findings) {
    term.print(
      `${indent}${tone[f.severity](f.severity.padEnd(8))} ${f.line ? `${f.file}:${f.line}` : f.file}  ${f.why}`,
    )
    if (f.excerpt) term.print(`${indent}         ${s.dim(f.excerpt)}`)
  }
  if (scan.skippedFiles) term.print(`${indent}${s.dim(t.scanSkipped(scan.skippedFiles))}`)
}

/** `plugin@marketplace`, as Claude Code names a marketplace plugin. */
const MARKET_PLUGIN = /^([a-z0-9][a-z0-9.-]*)@([a-z0-9][a-z0-9.-]*)$/i

/**
 * Shows what a fetch holds and asks for a typed yes, as Settings shows its review: an install never happens from a
 * pipe or a script, only from a person at the terminal. A no drops the fetched copy.
 */
async function confirmInstall(
  call: Call,
  term: Terminal,
  kind: 'plugin' | 'skill',
  p: Preview,
  opts: InstallOptions = {},
) {
  const s = term.style
  const names =
    kind === 'plugin'
      ? (p.name ?? '')
      : (p.skills ?? []).map((x) => (typeof x === 'string' ? x : x.name)).join(', ')
  term.print(s.bold(p.replaces ? t.reviewUpdate : t.review))
  term.print(`  ${s.bold(names)}`)
  term.print(`  ${s.dim(t.from)} ${p.source}`)
  if (p.version) term.print(`  ${s.dim(t.version)} ${p.version}`)
  if (p.commit || p.integrity) term.print(`  ${s.dim(t.pinned)} ${p.commit ?? p.integrity}`)
  if (p.replaces)
    term.print(
      `  ${s.dim(t.replaces)} ${[p.replaces.version, p.replaces.commit?.slice(0, 7)].filter(Boolean).join(' ')}`,
    )
  const runs = [
    p.server && t.code(p.server),
    p.ui && t.ui,
    p.hooks && t.hooks(p.hooks),
    p.mcpServers?.length && t.servers(p.mcpServers),
    p.scripts?.length && t.scripts(p.scripts),
  ].filter((x): x is string => typeof x === 'string')
  term.print(`  ${s.dim(t.runs)} ${runs.length ? s.yellow(runs.join('; ')) : t.nothingRuns}`)
  if (p.dependencies?.length) term.print(`  ${t.dependencies(p.dependencies)}`)
  for (const w of p.warnings ?? []) term.print(`  ${s.yellow(w)}`)
  const blocked = p.scan?.verdict === 'block'
  if (p.scan) {
    term.print(`  ${s.dim(t.scan)} ${t.verdict[p.scan.verdict]}`)
    printScan(term, p.scan, '    ')
    term.print(`  ${s.dim(t.advisory)}`)
  }
  if (blocked && !opts.force) {
    await call('DELETE', `/api/${kind}-installs/${p.id}`).catch(() => {})
    term.print(s.red(t.blocked))
    return
  }
  const answer = (await term.ask(`${blocked ? t.confirmAnyway : t.confirm}: `)).trim().toLowerCase()
  if (answer !== 'yes' && answer !== 'y') {
    await call('DELETE', `/api/${kind}-installs/${p.id}`).catch(() => {})
    term.print(t.cancelled)
    return
  }
  await call('POST', `/api/${kind}-installs/${p.id}`, blocked ? { override: true } : {})
  term.print(s.green(t.installed(names)))
}

function needsPerson(term: Terminal) {
  if (!term.interactive) throw new Error(t.notInteractive)
}

/** `myrmidon plugins …`: list, install (after the review), update, remove, and the marketplaces they come from. */
export async function plugins(
  call: Call,
  term: Terminal,
  args: string[],
  opts: InstallOptions = {},
): Promise<void> {
  const [verb, arg, extra] = args
  const s = term.style
  if (!verb || verb === 'ls') {
    const { plugins } = await call<{
      plugins: {
        name: string
        version?: string
        enabled: boolean
        installed?: { source: string; commit?: string }
      }[]
    }>('GET', '/api/plugins')
    if (!plugins.length) return term.print(t.noPlugins)
    for (const p of plugins)
      term.print(
        `${p.enabled ? s.green('●') : s.dim('○')} ${s.bold(p.name)}${p.version ? ` v${p.version}` : ''}${
          p.installed
            ? s.dim(
                `  ${p.installed.source}${p.installed.commit ? ` @${p.installed.commit.slice(0, 7)}` : ''}`,
              )
            : ''
        }`,
      )
    return
  }
  if (verb === 'add' && arg) {
    needsPerson(term)
    term.print(s.dim(t.fetching(arg)))
    const market = MARKET_PLUGIN.exec(arg)
    const body = market ? { plugin: market[1], marketplace: market[2] } : { source: arg }
    const { preview } = await call<{ preview: Preview }>('POST', '/api/plugins', body)
    return confirmInstall(call, term, 'plugin', preview, opts)
  }
  if (verb === 'update' && arg) {
    needsPerson(term)
    term.print(s.dim(t.fetching(arg)))
    const { preview } = await call<{ preview: Preview }>(
      'POST',
      `/api/plugins/${encodeURIComponent(arg)}/update`,
      {},
    )
    return confirmInstall(call, term, 'plugin', preview, opts)
  }
  if (verb === 'remove' && arg) {
    await call('DELETE', `/api/plugins/${encodeURIComponent(arg)}`)
    return term.print(t.removed(arg))
  }
  if (verb === 'marketplaces') {
    if (!arg) {
      const { marketplaces } = await call<{
        marketplaces: { name: string; source: string; plugins: { name: string; description?: string }[] }[]
      }>('GET', '/api/plugin-marketplaces')
      if (!marketplaces.length) return term.print(t.noMarketplaces)
      for (const m of marketplaces) {
        term.print(`${s.bold(m.name)} ${s.dim(m.source)}`)
        for (const p of m.plugins)
          term.print(`  ${p.name}@${m.name}${p.description ? s.dim(`  ${p.description}`) : ''}`)
      }
      return
    }
    if (arg === 'add' && extra) {
      const { marketplace } = await call<{ marketplace: { name: string; plugins: unknown[] } }>(
        'POST',
        '/api/plugin-marketplaces',
        { source: extra },
      )
      return term.print(s.green(t.added(marketplace.name, marketplace.plugins.length)))
    }
    if (arg === 'refresh' && extra) {
      await call('POST', `/api/plugin-marketplaces/${encodeURIComponent(extra)}`, {})
      return term.print(t.refreshed(extra))
    }
    if (arg === 'remove' && extra) {
      await call('DELETE', `/api/plugin-marketplaces/${encodeURIComponent(extra)}`)
      return term.print(t.removed(extra))
    }
  }
  throw new Error(t.pluginsUsage)
}

/**
 * `myrmidon skills scan [name|folder]`: the skill scanner's findings for a folder on disk (read here, no server
 * needed), one skill by name, or every skill. The exit code is 1 when a scan blocks, so a script can stop on it.
 */
async function scanSkills(call: Call, term: Terminal, arg: string) {
  const s = term.style
  const scans: { name: string; scan?: SkillScan; held?: boolean }[] = []
  if (arg && existsSync(arg)) scans.push({ name: arg, scan: scanSkill(resolve(arg)) })
  else {
    const { skills } = await call<{ skills: { name: string; scan?: SkillScan; held?: boolean }[] }>(
      'GET',
      '/api/skills',
    )
    const chosen = arg ? skills.filter((x) => x.name === arg) : skills
    if (arg && !chosen.length) throw new Error(t.noSuchSkill(arg))
    scans.push(...chosen)
  }
  for (const { name, scan, held } of scans) {
    if (!scan) {
      term.print(`${s.bold(name)} ${s.dim(t.notScanned)}`)
      continue
    }
    const verdict = scan.verdict === 'block' ? s.red : scan.verdict === 'warn' ? s.yellow : s.green
    term.print(`${s.bold(name)} ${verdict(t.verdict[scan.verdict])}${held ? ` ${s.red(t.held)}` : ''}`)
    printScan(term, scan)
  }
  term.print(s.dim(t.advisory))
  if (scans.some((x) => x.scan?.verdict === 'block')) process.exitCode = 1
}

/** `myrmidon skills …`: search omp's skills registry, install (after the review), update, remove and scan. */
export async function skills(
  call: Call,
  term: Terminal,
  args: string[],
  opts: InstallOptions = {},
): Promise<void> {
  const [verb, ...rest] = args
  const arg = rest.join(' ')
  const s = term.style
  if (!verb || verb === 'ls') {
    const { skills } = await call<{
      skills: { name: string; installed?: { source: string; version?: string } }[]
    }>('GET', '/api/skills')
    const installed = skills.filter((x) => x.installed)
    if (!installed.length) return term.print(t.noSkills)
    for (const x of installed)
      term.print(
        `${s.bold(x.name)} ${s.dim(`${x.installed?.source}${x.installed?.version ? ` ${x.installed.version}` : ''}`)}`,
      )
    return
  }
  if (verb === 'search') {
    const { hits } = await call<{
      hits: { scope: string; name: string; version: string; description: string }[]
    }>('GET', `/api/skill-registry?q=${encodeURIComponent(arg)}`)
    if (!hits.length) return term.print(t.noHits)
    for (const h of hits)
      term.print(`${s.bold(`@${h.scope}/${h.name}`)} ${s.dim(h.version)}  ${h.description}`)
    return
  }
  if (verb === 'add' && arg) {
    needsPerson(term)
    term.print(s.dim(t.fetching(arg)))
    const { preview } = await call<{ preview: Preview }>('POST', '/api/skill-installs', { source: arg })
    return confirmInstall(call, term, 'skill', preview, opts)
  }
  if (verb === 'update' && arg) {
    needsPerson(term)
    term.print(s.dim(t.fetching(arg)))
    const { preview } = await call<{ preview: Preview }>(
      'POST',
      `/api/skills/${encodeURIComponent(arg)}/update`,
      {},
    )
    return confirmInstall(call, term, 'skill', preview, opts)
  }
  if (verb === 'remove' && arg) {
    await call('DELETE', `/api/skills/${encodeURIComponent(arg)}`)
    return term.print(t.removed(arg))
  }
  if (verb === 'scan') return scanSkills(call, term, arg)
  throw new Error(t.skillsUsage)
}
