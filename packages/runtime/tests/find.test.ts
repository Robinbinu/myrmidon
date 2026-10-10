import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { Judge, JudgmentRequest, Questions } from '@oh-my-pi/pi-ai'
import { removeTempDir } from '../../../tests/platform.ts'
import { find } from '../src/find.ts'
import type { ColonyHost } from '../src/host.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let dir: string

const RETRY = `export async function withRetry<T>(work: () => Promise<T>, attempts = 5): Promise<T> {
  let delay = 100
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      if (attempt >= attempts) throw err
      // Back off exponentially after a 429 or a timeout.
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay *= 2
    }
  }
}
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-find-'))
  mkdirSync(join(dir, 'src', 'net'), { recursive: true })
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true })
  mkdirSync(join(dir, 'private'), { recursive: true })
  writeFileSync(join(dir, 'src', 'net', 'retry.ts'), RETRY)
  writeFileSync(
    join(dir, 'src', 'net', 'client.ts'),
    "import { withRetry } from './retry'\nexport const get = (u: string) => withRetry(() => fetch(u))\n",
  )
  writeFileSync(
    join(dir, 'src', 'ui', 'button.tsx'),
    'export const Button = () => <button type="button">Save</button>\n',
  )
  writeFileSync(join(dir, 'README.md'), '# Demo\nA small client.\n')
  // Readable to the walk, but not to the agent: neither its name nor its words may reach the judge or the result.
  writeFileSync(
    join(dir, 'private', 'backoff-notes.ts'),
    'retry backoff retry backoff exponential retry attempts setTimeout delay SECRET_MARKER\n',
  )
})

afterAll(() => removeTempDir(dir))

const mayRead = (path: string) => !path.startsWith(join(dir, 'private') + sep)
const scope = () => ({ root: dir, target: dir, isFile: false, mayRead })

test('without a judge, find ranks readable files by the query words and gives their line ranges', async () => {
  const out = await find(scope(), {
    query: 'retry with exponential backoff after a 429',
    keywords: ['setTimeout'],
  })
  const lines = out.split('\n')
  expect(lines[0]).toContain("ranked by the query's words only")
  // The implementation comes first, with the lines that hold it.
  expect(lines[2]).toStartWith('src/net/retry.ts  1.00')
  expect(out).toMatch(/src\/net\/retry\.ts:1-\d+ {2}1\.00 {2}export async function withRetry/)
  expect(out).not.toContain('button.tsx')
  expect(out).not.toContain('private')
})

test('with a judge, only passages it verifies are hits, and nothing the agent may not read is sent to it', async () => {
  const sent: string[] = []
  const judge: Judge = {
    label: 'stub/judge',
    async judge<Q extends Questions>(request: JudgmentRequest<Q>) {
      sent.push(JSON.stringify(request.state))
      const state = request.state as { passages?: Record<string, unknown> }
      const answers: Record<string, { type: 'noul'; noul: number }> = {}
      for (const key of Object.keys(request.questions)) {
        // Names all look plausible; a passage is a yes only when it really waits between attempts.
        const passage = JSON.stringify(state.passages?.[key] ?? '')
        answers[key] = {
          type: 'noul',
          noul: key.startsWith('e') ? 0.6 : passage.includes('setTimeout') ? 0.9 : 0.05,
        }
      }
      return {
        api: 'stub',
        provider: 'stub',
        model: 'judge',
        answers: answers as never,
        usage: {
          input: 10,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 11,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }
    },
  }
  const out = await find({ ...scope(), judge }, { query: 'where failed requests wait before trying again' })
  expect(out).toContain('1 hit for "where failed requests wait before trying again" (judged')
  expect(out).toContain('src/net/retry.ts  0.90')
  expect(out).not.toContain('client.ts  ')
  expect(sent.length).toBeGreaterThan(0)
  for (const state of sent) {
    expect(state).not.toContain('backoff-notes')
    expect(state).not.toContain('SECRET_MARKER')
  }
})

test('the find tool searches what the agent may read, from the folder it names', async () => {
  const host = {
    workspace: {
      workdir: () => dir,
      resolveForRead: (_: string, p: string) => join(dir, p),
      mayRead: (_: string, p: string) => mayRead(p),
    },
  } as unknown as ColonyHost
  const tool = TOOL_DEFS.find((d) => d.name === 'find')
  const out = String(await tool?.run({ query: 'retry backoff', path: 'src' }, 'kai', host))
  expect(out).toContain(' in src')
  expect(out).toContain('src/net/retry.ts')
  expect(out).not.toContain('private')
  await expect(tool?.run({ query: 'x', path: 'nowhere' }, 'kai', host)).rejects.toThrow(
    'no such file or folder',
  )
})
