import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

// Imported for its side effect before anything else: the embedded omp libraries read their data directory from the
// environment when first loaded, so it must point inside the Myrmidon home by then.
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  strict: false,
  options: { home: { type: 'string' } },
})

const home = resolve(
  (typeof values.home === 'string' ? values.home : undefined) ??
    process.env.MYRMIDON_HOME ??
    join(homedir(), '.myrmidon'),
)
const agentDir = join(home, 'agent')
mkdirSync(agentDir, { recursive: true, mode: 0o700 })
process.env.MYRMIDON_HOME = home
process.env.PI_CODING_AGENT_DIR = agentDir
// omp's own root (its logs, rejected-request dumps, caches) is ~/.omp unless PI_CONFIG_DIR names another folder,
// which omp reads relative to the home directory.
process.env.PI_CONFIG_DIR = relative(homedir(), join(home, 'omp'))
