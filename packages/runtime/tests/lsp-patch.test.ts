import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// A language server in a sandbox of its own cannot see Myrmidon's pid and exits at once when `initialize` names it;
// patches/@oh-my-pi%2Fpi-coding-agent@*.patch lets tools.ts send `null` there. bun applies a patch by its line numbers
// without checking the lines around them, so a patch left on an older omp lands on the wrong line: this fails first.
test("omp's LSP client sends the server config's processId in initialize, its own pid only when none is set", () => {
  const agent = dirname(require.resolve('@oh-my-pi/pi-coding-agent/package.json'))
  const client = readFileSync(join(agent, 'src/lsp/client.ts'), 'utf8')
  expect(client).toContain('processId: config.processId === undefined ? process.pid : config.processId,')
  expect(client).not.toContain('processId: process.pid,')
  const types = readFileSync(join(agent, 'src/lsp/types.ts'), 'utf8')
  expect(types).toContain('processId?: number | null;')
})
