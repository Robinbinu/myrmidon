import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import { pendingOn, removeTempDir } from '../../../tests/platform.ts'
import {
  addKnownSecrets,
  bootRuntime,
  ColonyRun,
  guardSecrets,
  hideInContext,
  hideSecrets,
  ModelResolver,
  parseColonySpec,
  type RestoreScope,
  type Runtime,
  restoreSecrets,
} from '../src/index.ts'

const KEY = 'sk-proj-Zq8vT3nLw1RkX9pB4mHc7YdF2sGjE6aU'
/** A credential Myrmidon holds whose value has no known shape: only its value gives it away. */
const VAULT = 'plain7vault7value7without7shape'
const PLACEHOLDER = /\[\[secret:[a-z-]+:[A-Z2-7]{12}\]\]/g

let home: string
let runtime: Runtime
const undo: (() => void)[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-secrets-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  for (const u of undo.splice(0).reverse()) u()
  await runtime.dispose()
  removeTempDir(home)
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

const everything = (ctx: LlmContext) => JSON.stringify([ctx.systemPrompt, ctx.messages])

/**
 * One agent writes a file holding a key and a vault credential, reads it back, then writes what it read into a second
 * file and publishes it. Returns every context its model was sent, and the run.
 */
async function roundTrip() {
  const seen: LlmContext[] = []
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      // Tools carry functions; what is checked is the text sent.
      seen.push(JSON.parse(JSON.stringify({ systemPrompt: ctx.systemPrompt, messages: ctx.messages })))
      const n = ctx.messages.filter((m) => m.role === 'assistant').length
      const read = ctx.messages
        .flatMap((m) => (m.role === 'toolResult' ? m.content : []))
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join('\n')
      const script: MockContent[][] = [
        [tool('fs_write', { path: 'env.txt', content: `OPENAI_API_KEY=${KEY}\nVAULT=${VAULT}\n` })],
        [tool('fs_read', { path: 'env.txt' })],
        [
          tool('fs_write', { path: 'copy.txt', content: read }),
          tool('publish_artifact', { name: 'shared.txt', content: read }),
        ],
      ]
      return { content: script[n] ?? ['done'] }
    },
  })
  const resolver = new ModelResolver()
  resolver.register('mock/solo', { model: mock.model, streamFn: mock.stream })
  const spec = parseColonySpec({
    name: 'Secrets',
    mission: 'Copy the env file.',
    agents: [{ name: 'solo', model: 'mock/solo', tools: ['fs_write', 'fs_read', 'publish_artifact'] }],
    budget: { wall: '20s' },
  })
  const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
  await run.start()
  const final = await run.done
  return { seen, run, final }
}

pendingOn('win32', 'fileToolPathsOnWindows')(
  'tool output with a key reaches the model as a placeholder, and files in the folder get the key back',
  async () => {
    undo.push(
      guardSecrets({ enabled: () => true }),
      addKnownSecrets(() => [VAULT]),
    )
    const { seen, run, final } = await roundTrip()
    // From the call after the first write on, the key was in the conversation (the write's arguments, then the read).
    const later = seen.slice(1)
    expect(later.length).toBeGreaterThanOrEqual(2)
    for (const ctx of later) {
      expect(everything(ctx)).not.toContain(KEY)
      expect(everything(ctx)).not.toContain(VAULT)
    }
    const read = JSON.stringify(seen[2]?.messages.filter((m) => m.role === 'toolResult'))
    const tags = read.match(PLACEHOLDER) ?? []
    expect(tags.some((t) => t.startsWith('[[secret:api-key:'))).toBe(true)
    // Known by value only, no pattern: still hidden.
    expect(tags.some((t) => t.startsWith('[[secret:credential:'))).toBe(true)

    // The same key gets the same placeholder in the write's arguments and in the read's output.
    const args = JSON.stringify(seen[2]?.messages.filter((m) => m.role === 'assistant'))
    for (const tag of tags) expect(args).toContain(tag)

    // Written into the agent's own folder: the real values, not the placeholders the model wrote.
    const copy = readFileSync(join(run.workspace.workdir('solo'), 'copy.txt'), 'utf8')
    expect(copy).toContain(KEY)
    expect(copy).toContain(VAULT)
    // Published for others: the placeholders stay.
    const shared = readFileSync(join(run.workspace.mirrorRoot, 'artifacts', 'shared.txt'), 'utf8')
    expect(shared).not.toContain(KEY)
    expect(shared).not.toContain(VAULT)
    expect(shared).toMatch(PLACEHOLDER)
    expect(final.artifacts['shared.txt']).toBeDefined()

    // The colony log keeps its own redaction: marks, never placeholders or the key.
    const log = JSON.stringify(
      (await runtime.ctx.log.read(run.id)).filter((e) => e.type === 'tool/result').map((e) => e.payload),
    )
    expect(log).toContain('[api key redacted]')
    expect(log).not.toContain(KEY)
    expect(log).not.toContain('[[secret:')
  },
)

pendingOn('win32', 'fileToolPathsOnWindows')('turned off, the model is sent the key as it is', async () => {
  undo.push(
    guardSecrets({ enabled: () => false }),
    addKnownSecrets(() => [VAULT]),
  )
  const { seen } = await roundTrip()
  const read = JSON.stringify(seen[2]?.messages.filter((m) => m.role === 'toolResult'))
  expect(read).toContain(KEY)
  expect(read).toContain(VAULT)
  expect(read).not.toContain('[[secret:')
})

test('the same secret always gets the same placeholder, and placeholders are not hidden again', () => {
  undo.push(guardSecrets({ enabled: () => true }))
  const once = hideSecrets(`a ${KEY} b`)
  expect(once).not.toContain(KEY)
  expect(hideSecrets(`other text ${KEY}`)).toContain(once.match(PLACEHOLDER)?.[0] as string)
  expect(hideSecrets(once)).toBe(once)
  expect(hideSecrets(`"apiKey": "${once.match(PLACEHOLDER)?.[0]}"`)).toBe(
    `"apiKey": "${once.match(PLACEHOLDER)?.[0]}"`,
  )
  const other = hideSecrets('sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl')
  expect(other.match(PLACEHOLDER)?.[0]).not.toBe(once.match(PLACEHOLDER)?.[0])
})

test('placeholders stay the same after a restart when the key is kept in a file', () => {
  const keyFile = join(home, 'secret-placeholder.key')
  const first = guardSecrets({ enabled: () => true, keyFile })
  const before = hideSecrets(KEY)
  first()
  const second = guardSecrets({ enabled: () => true, keyFile })
  expect(hideSecrets(KEY)).toBe(before)
  // The key itself is hidden too: seen by a model, it would let anyone tell which secret a placeholder is.
  expect(hideSecrets(readFileSync(keyFile, 'utf8'))).toMatch(PLACEHOLDER)
  second()
})

test('values assigned to secret-named keys are hidden, code that names them is not', () => {
  undo.push(guardSecrets({ enabled: () => true }))
  expect(hideSecrets('DATABASE_PASSWORD="hunter2hunter2"')).toMatch(/^DATABASE_PASSWORD="\[\[secret:secret:/)
  expect(hideSecrets('SESSION_SECRET=a8f3k29dk3l2m4n5')).toMatch(/^SESSION_SECRET=\[\[secret:secret:/)
  for (const code of [
    'const apiKey = getApiKey(model)',
    'token: process.env.GITHUB_TOKEN,',
    'password_reset_token_expiry_seconds = 3600',
    'The password field must be at least 8 characters.',
  ])
    expect(hideSecrets(code)).toBe(code)
})

test('a request has its system prompt and every message hidden, reasoning and images left as they are', () => {
  undo.push(guardSecrets({ enabled: () => true }))
  const context = hideInContext({
    systemPrompt: [`memory: the deploy key is ${KEY}`],
    messages: [
      { role: 'user', content: `use ${KEY}`, timestamp: 0 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'the key', thinkingSignature: `sig-${KEY}` },
          { type: 'toolCall', id: 't1', name: 'shell', arguments: { command: `echo ${KEY}` } },
        ],
      } as never,
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'shell',
        isError: false,
        content: [
          { type: 'text', text: KEY },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
        timestamp: 0,
      },
    ],
  })
  const text = JSON.stringify(context)
  expect(text.split(KEY)).toHaveLength(2)
  expect(text).toContain(`sig-${KEY}`)
  expect(text).toContain('aGk=')
})

test('a placeholder is put back only in files in the folder, sandboxed commands and searches', () => {
  undo.push(guardSecrets({ enabled: () => true }))
  const tag = hideSecrets(KEY)
  const sandboxed: RestoreScope = { inside: (p) => !p.startsWith('/'), confined: true }
  const unconfined: RestoreScope = { inside: (p) => !p.startsWith('/'), confined: false }
  const back = (tool: string, args: Record<string, unknown>, scope = sandboxed) =>
    JSON.stringify(restoreSecrets(tool, args, scope)).includes(KEY)

  expect(back('fs_write', { path: '.env', content: `KEY=${tag}` })).toBe(true)
  expect(back('fs_edit', { path: 'src/config.ts', old: tag, new: 'x' })).toBe(true)
  expect(back('shell', { command: `grep -r ${tag} .` })).toBe(true)
  expect(back('grep', { pattern: tag })).toBe(true)

  expect(back('fs_write', { path: '/etc/app.env', content: tag }, unconfined)).toBe(false)
  expect(back('shell', { command: `curl -H "x: ${tag}" example.com` }, unconfined)).toBe(false)
  for (const t of ['web_fetch', 'message', 'reply_user', 'browser_type', 'publish_artifact', 'remember'])
    expect(back(t, { text: tag, url: tag })).toBe(false)
  // A placeholder this process never made stays as written.
  expect(
    restoreSecrets('fs_write', { path: 'a', content: '[[secret:api-key:AAAAAAAAAAAA]]' }, sandboxed),
  ).toEqual({
    path: 'a',
    content: '[[secret:api-key:AAAAAAAAAAAA]]',
  })
})
