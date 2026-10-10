import { expect, test } from 'bun:test'
import { plugins, skills } from '../src/installs.ts'
import type { Call, Terminal } from '../src/setup.ts'

const plain = (s: string) => s
const style = { dim: plain, bold: plain, green: plain, red: plain, yellow: plain, cyan: plain }

function scripted(answers: string[], interactive = true) {
  const out: string[] = []
  const term: Terminal = {
    print: (line = '') => out.push(line),
    ask: async (question) => {
      const next = answers.shift()
      if (next === undefined) throw new Error(`unexpected question: ${question}`)
      return next
    },
    piped: async () => undefined,
    interactive,
    headless: true,
    onInterrupt: () => () => {},
    style,
  }
  return { term, out }
}

function api(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { route: string; body: unknown }[] = []
  const call: Call = async <T>(method: string, path: string, body?: unknown) => {
    const route = `${method} ${path}`
    calls.push({ route, body })
    const handler = routes[route]
    if (!handler) throw new Error(`no route ${route}`)
    return handler(body) as T
  }
  return { call, calls }
}

const PREVIEW = {
  id: 'r1',
  name: 'lint-kit',
  source: 'https://github.com/acme/lint-kit',
  commit: 'abcdef1234567',
  server: 'server/index.ts',
  hooks: 1,
  mcpServers: ['linter'],
  dependencies: [],
}

test('a plugin installs from the terminal only on a typed yes, after its review', async () => {
  const { call, calls } = api({
    'POST /api/plugins': () => ({ preview: PREVIEW }),
    'POST /api/plugin-installs/r1': () => ({ plugin: { name: 'lint-kit' } }),
    'DELETE /api/plugin-installs/r1': () => ({ ok: true }),
  })
  const no = scripted([''])
  await plugins(call, no.term, ['add', 'https://github.com/acme/lint-kit'])
  expect(no.out.join('\n')).toContain('server code server/index.ts; 1 hook; MCP servers linter')
  expect(calls.map((c) => c.route)).toEqual(['POST /api/plugins', 'DELETE /api/plugin-installs/r1'])

  calls.length = 0
  const yes = scripted(['yes'])
  await plugins(call, yes.term, ['add', 'lint-kit@acme'])
  expect(calls).toEqual([
    { route: 'POST /api/plugins', body: { plugin: 'lint-kit', marketplace: 'acme' } },
    { route: 'POST /api/plugin-installs/r1', body: {} },
  ])
})

test('with nobody at the terminal, nothing is fetched or installed', async () => {
  const { call, calls } = api({})
  await expect(skills(call, scripted([], false).term, ['add', '@ada/pdf-tools'])).rejects.toThrow(
    'confirm what it shows',
  )
  expect(calls).toEqual([])
})
