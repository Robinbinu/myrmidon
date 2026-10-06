import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
