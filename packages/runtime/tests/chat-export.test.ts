import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldColony, type MyrEvent } from '@myrmidon/protocol'
import {
  bootRuntime,
  ChatService,
  ChatShelf,
  type Classify,
  exportDoc,
  ModelResolver,
  type Runtime,
  renderChatHtml,
  type TeamConfig,
} from '../src/index.ts'
import { createMockModel } from '../src/omp/mock.ts'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Two rounds of one chat colony: messages, crew mail and team chat, tool steps, files of each kind. */
function chatLog(): MyrEvent[] {
  let seq = 0
  const ev = (type: string, payload: Record<string, unknown>) =>
    ({
      id: `e${++seq}`,
      seq,
      colonyId: 'colony-x',
      time: new Date(Date.UTC(2026, 9, 10, 12, 0, seq)).toISOString(),
      type,
      actor: { kind: 'system', id: 'x' },
      trace: { traceId: 't', spanId: 's' },
      schema: 1,
      payload,
    }) as MyrEvent
  const created = (round: number, request: string) => ({
    name: 'Chat',
    mission: request,
    pattern: 'lead-workers',
    agents: [{ name: 'lead', role: 'lead', model: 'mock/lead', tools: [] }],
    acceptance: [],
    budget: { wallMs: 60_000 },
    unsafeNoSandbox: false,
    tier: 'solo',
    chat: { chatId: 'chat-x', round, request },
  })
  const artifact = (name: string, blob: string, size: number, mediaType: string, author = 'lead') =>
    ev('artifact/versioned', { name, version: 1, blob, size, author, mediaType })
  return [
    ev('colony/created', created(1, 'Fix the <script>alert(1)</script> page')),
    ev('chat/user', { text: `Fix the <script>alert(1)</script> page, my token is ${TOKEN}` }),
    ev('tool/call', { agent: 'lead', callId: 'c1', tool: 'read', args: { path: 'src/page.html' } }),
    ev('tool/result', { agent: 'lead', callId: 'c1', tool: 'read', ok: true, output: '' }),
    ev('tool/call', {
      agent: 'lead',
      callId: 'c2',
      tool: 'bash',
      args: { command: `curl -H "Bearer ${TOKEN}"` },
    }),
    ev('tool/result', { agent: 'lead', callId: 'c2', tool: 'bash', ok: false, output: 'exit 1' }),
    ev('tool/call', { agent: 'lead', callId: 'c3', tool: 'read', args: { path: 'README.md' } }),
    ev('mail/sent', { from: 'lead', to: 'coder', subject: 'Escape it', body: 'Use <b>textContent</b>' }),
    ev('board/posted', { agent: 'coder', text: 'On it', mentions: [] }),
    artifact('notes.md', 'blob-notes', 40, 'text/markdown'),
    artifact('shot.png', 'blob-png', PNG.length, 'image/png'),
    artifact('big.bin', 'blob-big', 9 * 1024 * 1024, 'application/octet-stream'),
    artifact('uploads/mine.txt', 'blob-mine', 4, 'text/plain', 'user'),
    ev('chat/reply', {
      agent: 'lead',
      text: 'Done: `textContent` now, see **notes**.\n\n```html\n<p>safe</p>\n```',
      final: true,
    }),
    ev('colony/completed', { verdicts: [] }),
    ev('round/started', created(2, 'Thanks')),
    ev('chat/user', { text: 'Thanks' }),
    ev('chat/reply', { agent: 'lead', text: 'You are welcome.', final: true }),
    ev('colony/completed', { verdicts: [] }),
  ]
}

const blobs: Record<string, Uint8Array> = {
  'blob-notes': new TextEncoder().encode(`DB_PASSWORD=hunter2hunter2\n<h1>notes</h1>`),
  'blob-png': PNG,
}

async function exported() {
  const events = chatLog()
  expect(foldColony('colony-x', events).rounds).toHaveLength(2)
  const doc = await exportDoc(
    {
      title: 'Fix <the> page',
      rounds: [
        { colonyId: 'colony-x', round: 1 },
        { colonyId: 'colony-x', round: 2 },
      ],
      project: 'site',
      forkOf: 'The first try',
    },
    {
      events: async () => events,
      blob: async (_colony, hash) => {
        const bytes = blobs[hash]
        if (!bytes) throw new Error(`no blob ${hash}`)
        return bytes
      },
    },
    new Date('2026-10-10T13:00:00Z'),
  )
  return { doc, html: renderChatHtml(doc) }
}

test('an export reads each run: its messages, crew messages, tool steps and the files it made', async () => {
  const { doc } = await exported()
  const [first, second] = doc.rounds
  expect(first?.messages.map((m) => m.from)).toEqual(['user', 'lead'])
  expect(first?.crew).toEqual([
    { from: 'lead', to: 'coder', text: 'Escape it\n\nUse <b>textContent</b>' },
    { from: 'coder', to: 'team chat', text: 'On it' },
  ])
  expect(first?.steps.map((s) => s.label)).toEqual([
    'read src/page.html',
    'bash curl -H "Bearer [github token redacted]"',
    'read README.md',
  ])
  expect(first?.steps[1]?.failed).toBe(true)
  // The person's own upload is theirs, not the run's work; the large file is named, not embedded.
  expect(first?.files.map((f) => [f.name, f.text !== undefined, f.image !== undefined])).toEqual([
    ['big.bin', false, false],
    ['notes.md', true, false],
    ['shot.png', false, true],
  ])
  expect(second?.messages.map((m) => m.text)).toEqual(['Thanks', 'You are welcome.'])
  expect(second?.steps).toEqual([])
})

test('the page is self-contained: nothing loads or runs, secrets are redacted and text is escaped', async () => {
  const { html } = await exported()
  expect(html.startsWith('<!doctype html>')).toBe(true)
  // Nothing from elsewhere: no scripts, stylesheets, fonts, frames or addresses to fetch.
  expect(html).not.toMatch(/<script|<link|<iframe|@import|url\(/i)
  expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:|\/\/)/i)
  expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;`)
  expect(html).toContain('<img src="data:image/png;base64,')
  // Secrets are gone wherever they were: a message, a step, a file.
  expect(html).not.toContain(TOKEN)
  expect(html).toContain('[github token redacted]')
  expect(html).toContain('DB_PASSWORD=[secret redacted]')
  expect(html).not.toContain('hunter2')
  // What a chat said is shown, never run.
  expect(html).toContain('Fix the &lt;script&gt;alert(1)&lt;/script&gt; page')
  expect(html).toContain('Use &lt;b&gt;textContent&lt;/b&gt;')
  expect(html).toContain('&lt;h1&gt;notes&lt;/h1&gt;')
  expect(html).toContain('<title>Fix &lt;the&gt; page</title>')
  // Light Markdown: inline code, bold and a code block, still escaped inside.
  expect(html).toContain('<code>textContent</code>')
  expect(html).toContain('<strong>notes</strong>')
  expect(html).toContain('<pre><code>&lt;p&gt;safe&lt;/p&gt;</code></pre>')
  // Crew messages and tool steps are folded; the steps say how many, which tools, and what failed.
  expect(html).toContain('<details class="fold"><summary>Crew messages (2)</summary>')
  expect(html).toContain('Tool steps: 3 (read ×2, bash ×1) · <span class="bad">1 failed</span>')
  expect(html).toContain('big.bin</code> · 9.0 MB, not included in this page')
  expect(html).toContain('Forked from “The first try”')
  expect(html).toContain('2 runs · in site')
})

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-export-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const answerOnly: Classify = async () => 'answer'
const solo = (leadModel: string): TeamConfig => ({
  mode: 'orchestrated',
  leadModel,
  roster: [],
  extraWorkers: 0,
  judgeModel: leadModel,
})

async function waitFor(chats: ChatService, chatId: string) {
  for (let i = 0; i < 200; i++) {
    const chat = (await chats.list()).find((c) => c.chatId === chatId)
    if (chat && chat.status !== 'running' && chat.status !== 'created') return
    await Bun.sleep(25)
  }
  throw new Error('round did not end')
}

test('a chat exports through the chat service, naming the chat it was forked from', async () => {
  const resolver = new ModelResolver()
  const mock = createMockModel({
    handler: () => ({ content: [`Use the key ${TOKEN} <img src=x onerror=alert(1)>`] }),
  })
  resolver.register('mock/lead', { model: mock.model, streamFn: mock.stream })
  const chats = new ChatService(runtime, { resolver, classify: answerOnly, shelf: new ChatShelf(home) })
  const first = await chats.send('What key?', solo('mock/lead'))
  await waitFor(chats, first.chatId)
  const fork = await chats.send('And again?', solo('mock/lead'), undefined, { forkOf: first.chatId })
  await waitFor(chats, fork.chatId)

  const { title, html } = await chats.exportHtml(fork.chatId)
  expect(title).toBe('And again?')
  expect(html).toContain('Forked from “What key?”')
  expect(html).not.toContain(TOKEN)
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  await expect(chats.exportHtml('chat-gone-1')).rejects.toThrow('no such chat')
})
