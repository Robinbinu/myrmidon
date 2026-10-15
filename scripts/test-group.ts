/**
 * Runs one group of the suite (tests/groups.ts), or `integration` for every integration group at once:
 *
 *   bun scripts/test-group.ts <group> [--list] [bun test arguments…]
 *
 * A group runs in parallel through scripts/test.ts (its wall clock included), except one marked serial (perf), which
 * runs in one process so its timings mean something. --list prints the group's files instead of running them.
 */
import { join } from 'node:path'
import { groupFiles, INTEGRATION, TEST_GROUPS, type TestGroupName } from '../tests/groups.ts'

const root = join(import.meta.dir, '..')
const [name, ...rest] = process.argv.slice(2)
const list = rest.includes('--list')
const passthrough = rest.filter((arg) => arg !== '--list')

const names: readonly TestGroupName[] | undefined =
  name === 'integration' ? INTEGRATION : name && name in TEST_GROUPS ? [name as TestGroupName] : undefined
if (!names) {
  console.error(`usage: bun scripts/test-group.ts <group> [--list] [bun test arguments…]\n\ngroups:`)
  for (const [group, { about }] of Object.entries(TEST_GROUPS))
    console.error(`  ${group.padEnd(12)} ${about}`)
  console.error(`  ${'integration'.padEnd(12)} ${INTEGRATION.join(' + ')}`)
  process.exit(2)
}

const groups = names.map((n) => TEST_GROUPS[n])
const files = [...new Set(groups.flatMap((g) => groupFiles(g, root)))].sort()
if (list) {
  for (const file of files) console.log(file)
  process.exit(0)
}
if (files.length === 0) {
  console.error(`test-group: ${name} names no test files`)
  process.exit(1)
}

const serial = groups.some((g) => 'serial' in g && g.serial)
const env = Object.assign({}, process.env, ...groups.map((g) => ('env' in g ? g.env : {})))
console.log(`test-group ${name}: ${files.length} files${serial ? ', one process' : ''}`)
// `./` makes each a path, not a filter matching every file whose name contains it.
const paths = files.map((f) => `./${f}`)
const argv = serial
  ? [process.execPath, 'test', '--timeout', '30000', ...passthrough, ...paths]
  : [process.execPath, join(import.meta.dir, 'test.ts'), ...passthrough, ...paths]
const run = Bun.spawn(argv, { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
process.exit(await run.exited)
