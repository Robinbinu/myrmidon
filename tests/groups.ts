/**
 * Test groups (docs/verification.md): a name for each slice of the suite that can be run on its own, as test files
 * (paths from the repository root, or globs). A file may be in several groups; every file is in the whole suite
 * (`bun run test`) whatever its groups. `bun run test:group <name>` runs one; `tests/groups.test.ts` fails on an entry
 * that names no file, so a renamed or deleted test cannot drop out of its group unnoticed.
 *
 * Add a test file to the groups it exercises when you write it.
 */
export interface TestGroup {
  readonly about: string
  readonly files: readonly string[]
  /** One process, one file after another: for timings that mean something (perf). */
  readonly serial?: true
  /** Environment for the run, e.g. MYR_PERF_REPORT to print each timing beside its budget. */
  readonly env?: Readonly<Record<string, string>>
}

const runtime = (name: string) => `packages/runtime/tests/${name}.test.ts`
const web = (name: string) => `apps/web/tests/${name}`

export const TEST_GROUPS = {
  runtime: {
    about:
      'the runtime end to end with scripted models: chats, colonies, crews, tools, workers, cells, hooks',
    files: [
      'chat',
      'colony',
      'crew-sync',
      'children',
      'cells',
      'compaction',
      'checkpoints',
      'goal',
      'briefs',
      'hooks',
      'mcp',
      'plugin-host',
      'tools',
      'shell',
      'stream-rules',
      'verifier',
      'worktrees',
    ].map(runtime),
  },
  server: {
    about: "the dashboard's HTTP server and the CLI, over real loopback requests",
    files: [web('server-*.test.ts'), 'apps/cli/tests/*.test.ts'],
  },
  ui: {
    about: 'UI interactions: client components rendered in a DOM, clicked and typed into',
    files: [web('*.test.tsx')],
  },
  permissions: {
    about: 'the permission model: presets, rules, approvals, full access, read access, who may use what',
    files: [
      'packages/protocol/tests/permissions.test.ts',
      ...['full-access', 'read-access', 'role-access', 'rule-files', 'security-boundaries'].map(runtime),
      ...[
        'permissions-ui.test.tsx',
        'full-access.test.tsx',
        'read-access.test.tsx',
        'held-deletes.test.tsx',
        'approvals.test.ts',
        'server-chat-permissions.test.ts',
        'server-full-access.test.ts',
      ].map(web),
    ],
  },
  lifecycle: {
    about:
      'process lifecycle: leashes, children, the server lock, ports, terminals, the desktop app starting its server',
    files: [
      ...['processes', 'children', 'server-lock', 'ports', 'keep-awake', 'person-terminal'].map(runtime),
      'apps/desktop/tests/server.test.ts',
      'apps/desktop/tests/sidecar.test.ts',
      'apps/desktop/tests/extraction.test.ts',
      'apps/cli/tests/shutdown.test.ts',
      web('server-terminal.test.ts'),
      web('terminal-foreground.test.ts'),
    ],
  },
  security: {
    about: 'permission and sandbox boundaries: escapes, links, keys, channel members, auth, shares, scans',
    files: [
      'packages/protocol/tests/permissions.test.ts',
      ...[
        'security-boundaries',
        'full-access',
        'read-access',
        'role-access',
        'sandbox',
        'projects',
        'rule-files',
        'secrets',
        'provider-secrets',
        'security-scan',
        'skill-scan',
        'channels',
      ].map(runtime),
      ...[
        'server-auth.test.ts',
        'server-chat-permissions.test.ts',
        'server-full-access.test.ts',
        'server-project-file.test.ts',
        'server-chat-share.test.ts',
        'share-seal.test.ts',
      ].map(web),
    ],
  },
  perf: {
    about:
      'performance budgets (tests/perf-budgets.ts): long histories, streaming, long sessions, concurrent agents',
    // The colony-UI stress test on branch fix-colony-perf (apps/web/tests/colony-clock.test.tsx) joins this group
    // when that branch lands.
    files: ['{packages,apps}/*/tests/perf-*.test.{ts,tsx}'],
    serial: true,
    env: { MYR_PERF_REPORT: '1' },
  },
} as const satisfies Record<string, TestGroup>

export type TestGroupName = keyof typeof TEST_GROUPS

/** The integration groups (tier 2), which `bun run test:integration` runs together. */
export const INTEGRATION: readonly TestGroupName[] = ['runtime', 'server', 'ui', 'permissions', 'lifecycle']

/** The test files a group names, sorted, relative to `root`; a glob that matches nothing contributes nothing. */
export function groupFiles(group: TestGroup, root: string): string[] {
  const files = new Set<string>()
  for (const pattern of group.files)
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }))
      if (!file.includes('node_modules/')) files.add(file)
  return [...files].sort()
}
