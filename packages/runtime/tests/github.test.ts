import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { decide, type PermissionCall, type PermissionLevels } from '@myrmidon/protocol'
import { bunShim } from '../../../tests/platform.ts'
import { forgetGhToken, posixLine } from '../src/github.ts'
import type { ColonyHost, ReviewDecision } from '../src/host.ts'
import { prompts } from '../src/prompts.ts'
import { unconfinedSandbox } from '../src/sandbox.ts'
import { TOOL_DEFS } from '../src/tools.ts'

const TOKEN = 'gho_FAKE_TOKEN_0123456789'

/**
 * A stand-in GitHub CLI: it logs every call, answers `auth token` (or says it is signed out), and echoes the token it
 * was given inside a pull request's body, so a test can see whether it leaks.
 */
const FAKE_GH = `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, token: process.env.GH_TOKEN ?? null }) + '\\n')
const [group, sub] = args
if (group === 'auth' && sub === 'token') {
  if (process.env.FAKE_GH_SIGNED_OUT) { console.error('no oauth token found for github.com'); process.exit(1) }
  console.log(${JSON.stringify(TOKEN)})
} else if (group === 'pr' && sub === 'view') {
  console.log(JSON.stringify({ number: 12, title: 'Fix the flaky test', state: 'OPEN', body: 'seen with ' + process.env.GH_TOKEN, url: 'https://github.com/o/r/pull/12' }))
} else if (group === 'pr' && sub === 'comment') {
  console.log('https://github.com/o/r/pull/12#issuecomment-1')
} else {
  console.error('unexpected: ' + args.join(' ')); process.exit(2)
}
`

let dir: string
let log: string
let path: string | undefined
const undo: (() => void)[] = []

const SIGN_IN_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_CONFIG_DIR',
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-gh-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'fake-gh.cjs'), FAKE_GH)
  bunShim(join(dir, 'bin', 'gh'), join(dir, 'fake-gh.cjs'))
  log = join(dir, 'gh.log')
  writeFileSync(log, '')
  path = process.env.PATH
  // Only the stand-in: the computer's own gh must not answer.
  process.env.PATH = [
    join(dir, 'bin'),
    ...(path ?? '').split(delimiter).filter((p) => !Bun.which('gh', { PATH: p })),
  ].join(delimiter)
  process.env.FAKE_GH_LOG = log
  // A second wall: were the real gh reached after all, it would find no sign-in, so nothing reaches GitHub.
  saved = Object.fromEntries(SIGN_IN_ENV.map((k) => [k, process.env[k]]))
  for (const k of SIGN_IN_ENV) delete process.env[k]
  process.env.GH_CONFIG_DIR = join(dir, 'gh-config')
  forgetGhToken()
})

afterEach(() => {
  process.env.PATH = path
  delete process.env.GH_CONFIG_DIR
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
  delete process.env.FAKE_GH_LOG
  delete process.env.FAKE_GH_SIGNED_OUT
  for (const u of undo.splice(0)) u()
  forgetGhToken()
  rmSync(dir, { recursive: true, force: true })
})

const calls = () =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; token: string | null })

/**
 * A host whose sandbox runs commands as the person would (the stand-in needs no confinement), under the Auto preset,
 * recording what the permission model was asked and answering cards with `answer`.
 */
function host(answer: ReviewDecision = { approved: false, note: 'not now' }) {
  const levels: PermissionLevels = { global: { preset: 'auto', rules: [] } }
  const asked: PermissionCall[] = []
  const cards: string[] = []
  const unconfined = unconfinedSandbox()
  const h = {
    // Confined, as most rounds are, so the person's token is handed to gh.
    sandbox: { kind: 'sandbox-exec', run: unconfined.run },
    unsafeNoSandbox: false,
    spec: { agents: [] },
    permit: (_agent: string, call: PermissionCall) => {
      asked.push(call)
      return decide(levels, call)
    },
    reviewChange: async (_agent: string, _tool: string, summary: string) => {
      cards.push(summary)
      return answer
    },
    state: () => ({ rounds: [], receipts: {}, approvals: {} }),
    workspace: {
      workdir: () => dir,
      scratch: () => dir,
      confinement: () => ({ readable: [], hidden: [] }),
    },
  } as unknown as ColonyHost
  return { h, asked, cards }
}

const github = TOOL_DEFS.find((d) => d.name === 'github')

test('a read runs gh where commands run, with the token in its environment and never in what the agent reads', async () => {
  const { h, asked, cards } = host()
  const out = await github?.run({ op: 'pr_view', pr: '12', repo: 'o/r', comments: false }, 'kai', h)
  expect(out).toContain('# Pull Request #12: Fix the flaky test')
  expect(out).toContain(prompts.github.tokenHidden)
  expect(out).not.toContain(TOKEN)
  const view = calls().find((c) => c.args[0] === 'pr')
  expect(view?.args.slice(0, 4)).toEqual(['pr', 'view', '12', '--repo=o/r'])
  expect(view?.token).toBe(TOKEN)
  // Decided as the read-only command it is: nobody was asked.
  expect(asked.map((c) => c.command)).toEqual([`gh ${posixLine(view?.args ?? [])}`])
  expect(cards).toEqual([])
})

test('fs_read of pr://owner/repo/N reads the pull request through the same gh read, decided as that command', async () => {
  const { h, asked, cards } = host()
  const fsRead = TOOL_DEFS.find((d) => d.name === 'fs_read')
  const out = await fsRead?.run({ path: 'pr://o/r/12' }, 'kai', h)
  expect(String(out)).toContain('# Pull Request #12: Fix the flaky test')
  expect(String(out)).not.toContain(TOKEN)
  const view = calls().find((c) => c.args[0] === 'pr')
  expect(view?.args.slice(0, 4)).toEqual(['pr', 'view', '12', '--repo=o/r'])
  expect(asked.map((c) => c.command)).toEqual([`gh ${posixLine(view?.args ?? [])}`])
  expect(cards).toEqual([])
  // Writing one is refused before anything runs.
  const fsWrite = TOOL_DEFS.find((d) => d.name === 'fs_write')
  await expect(
    fsWrite?.run({ path: 'issue://12', content: 'x' }, 'kai', h) ?? Promise.resolve(),
  ).rejects.toThrow('issue:// is read-only')
})

test('a write asks the person first, whatever the preset, and does not run when they decline', async () => {
  const declined = host()
  await expect(
    github?.run({ op: 'pr_comment', pr: '12', repo: 'o/r', body: 'Fixed in abc123' }, 'kai', declined.h),
  ).rejects.toThrow('not now')
  expect(declined.cards).toHaveLength(1)
  expect(declined.asked[0]).toMatchObject({
    tool: 'github',
    kind: 'command',
    command: "gh pr comment 12 --repo=o/r '--body=Fixed in abc123'",
    asks: true,
  })
  expect(calls().some((c) => c.args[1] === 'comment')).toBe(false)

  const approved = host({ approved: true })
  const out = await github?.run(
    { op: 'pr_comment', pr: '12', repo: 'o/r', body: 'Fixed in abc123' },
    'kai',
    approved.h,
  )
  expect(out).toContain('https://github.com/o/r/pull/12#issuecomment-1')
  expect(calls().find((c) => c.args[1] === 'comment')?.args).toEqual([
    'pr',
    'comment',
    '12',
    '--repo=o/r',
    '--body=Fixed in abc123',
  ])
})

test('an argument that would slip a flag into gh is refused before anything runs', async () => {
  const { h } = host({ approved: true })
  await expect(github?.run({ op: 'pr_view', pr: '--web' }, 'kai', h)).rejects.toThrow('must be one word')
  await expect(github?.run({ op: 'pr_merge', pr: '12', repo: '--admin' }, 'kai', h)).rejects.toThrow(
    'must be one word',
  )
  expect(calls()).toEqual([])
})

test('without gh, or with gh signed out, the agent is told so plainly', async () => {
  process.env.FAKE_GH_SIGNED_OUT = '1'
  await expect(github?.run({ op: 'pr_view', pr: '12' }, 'kai', host().h)).rejects.toThrow(
    prompts.github.signedOut,
  )
  process.env.PATH = join(dir, 'empty')
  await expect(github?.run({ op: 'pr_view', pr: '12' }, 'kai', host().h)).rejects.toThrow(
    prompts.github.missing,
  )
})
