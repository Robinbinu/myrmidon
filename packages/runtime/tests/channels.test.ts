import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MyrEvent } from '@myrmidon/protocol'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChats,
  ChannelHub,
  chunk,
  type Inbound,
  type SentRef,
  telegramHtml,
} from '../src/channels/index.ts'

const dirs: string[] = []
const hubs: ChannelHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Waits for a condition the hub reaches asynchronously. */
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

/** A platform that records what the hub sends, and delivers what a test says. */
class FakeAdapter implements ChannelAdapter {
  readonly id = 'fake'
  readonly label = 'Telegram'
  readonly limits = { text: 300, editMs: 20 }
  io?: AdapterIO
  sent: { chat: string; text: string; id: string }[] = []
  edits: { id: string; text: string }[] = []
  private _n = 0
  async check() {
    return '@fakebot'
  }
  async start(io: AdapterIO) {
    this.io = io
    io.status({ state: 'on', account: '@fakebot' })
  }
  async stop() {}
  async send(chat: string, message: { text: string }): Promise<SentRef> {
    const id = String(++this._n)
    this.sent.push({ chat, text: message.text, id })
    return { chat, id }
  }
  async edit(ref: SentRef, message: { text: string }) {
    this.edits.push({ id: ref.id, text: message.text })
  }
  async typing() {}
  to(chat: string) {
    return this.sent.filter((s) => s.chat === chat).map((s) => s.text)
  }
}

/** Myrmidon's chats, faked: sends are recorded, and a test appends a round's events. */
class FakeChats implements ChannelChats {
  sends: { text: string; chatId: string | undefined }[] = []
  renamed: Record<string, string> = {}
  stopped: string[] = []
  events = new Map<string, MyrEvent[]>()
  running = new Set<string>()
  private _listeners = new Set<(colonyId: string, events: readonly MyrEvent[]) => void>()
  private _n = 0

  async send(text: string, chatId: string | undefined) {
    this.sends.push({ text, chatId })
    const id = chatId ?? `chat-${++this._n}`
    const colonyId = `col-${id}`
    const started = !this.running.has(colonyId)
    if (started) {
      this.running.add(colonyId)
      this.emit(colonyId, 'colony/created', {
        name: 'x',
        mission: text,
        pattern: 'lead-workers',
        agents: [{ name: 'lead', role: 'lead', model: 'm/x', tools: [] }],
        acceptance: [],
        budget: { wallMs: 60_000 },
        unsafeNoSandbox: false,
        tier: 'solo',
        chat: { id, round: 1 },
      })
    }
    return { chatId: id, colonyId, started }
  }
  async rename(chatId: string, title: string) {
    this.renamed[chatId] = title
  }
  async stop(chatId: string) {
    this.stopped.push(chatId)
  }
  onEvents(listener: (colonyId: string, events: readonly MyrEvent[]) => void) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }
  async read(colonyId: string) {
    return this.events.get(colonyId) ?? []
  }
  emit(colonyId: string, type: string, payload: Record<string, unknown>) {
    const list = this.events.get(colonyId) ?? []
    const seq = list.length + 1
    const event = {
      id: `${colonyId}-${seq}`,
      seq,
      colonyId,
      time: new Date().toISOString(),
      type,
      actor: { kind: 'system', id: 'x' },
      trace: { traceId: 't', spanId: 's' },
      schema: 1,
      payload,
    } as unknown as MyrEvent
    list.push(event)
    this.events.set(colonyId, list)
    if (type === 'colony/completed' || type === 'colony/failed') this.running.delete(colonyId)
    for (const l of this._listeners) l(colonyId, [event])
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'myr-channels-'))
  dirs.push(dir)
  const adapter = new FakeAdapter()
  const chats = new FakeChats()
  const hub = new ChannelHub({
    dir,
    chats,
    kinds: { telegram: { label: 'Telegram', make: () => adapter } },
    log: (m) => console.error(m),
  })
  hubs.push(hub)
  await hub.configure('telegram', { token: 'tok' })
  await until(() => adapter.io !== undefined)
  let n = 0
  const say = (
    from: { id: string; name: string },
    text: string,
    chat?: Partial<Inbound['chat']> & { mentioned?: boolean },
  ) =>
    adapter.io?.receive({
      messageId: String(++n),
      chat: {
        id: chat?.id ?? from.id,
        kind: chat?.kind ?? 'dm',
        ...(chat?.title ? { title: chat.title } : {}),
      },
      sender: from,
      text,
      mentioned: chat?.mentioned ?? true,
      time: new Date().toISOString(),
    })
  return { dir, hub, adapter, chats, say }
}

const ALICE = { id: '100', name: 'Alice' }
const BOB = { id: '200', name: 'Bob' }
const codeIn = (text: string) => /approve telegram ([A-Z2-9]{8})/.exec(text)?.[1] ?? ''

test('a stranger gets a code and nothing they say is acted on; the first approved is the owner', async () => {
  const { hub, adapter, chats, say, dir } = await setup()
  await say(ALICE, 'delete everything')
  await until(() => adapter.to('100').length === 1)
  expect(chats.sends).toEqual([])
  const code = codeIn(adapter.to('100')[0] ?? '')
  expect(code).toHaveLength(8)
  // Asking again within the window gets no second code.
  await say(ALICE, 'hello?')
  await Bun.sleep(30)
  expect(adapter.to('100')).toHaveLength(1)
  // The code is kept only as a hash, in a file only this user can read.
  expect(JSON.stringify(hub.store.get('telegram'))).not.toContain(code)
  expect(statSync(join(dir, 'channels.json')).mode & 0o777).toBe(0o600)

  const approved = await hub.approve('telegram', { code: code.toLowerCase() })
  expect(approved?.person?.role).toBe('owner')
  expect(adapter.to('100').at(-1)).toContain('owner')

  await say(ALICE, 'build me a calculator')
  await until(() => chats.sends.length === 1)
  expect(chats.sends[0]).toEqual({ text: 'build me a calculator', chatId: undefined })
  await until(() => chats.renamed['chat-1'] !== undefined)
  expect(chats.renamed['chat-1']).toBe('Telegram · Alice')

  // A second person approved is a member, and agents see their message marked as not the owner's.
  await say(BOB, 'hi')
  await until(() => adapter.to('200').length === 1)
  await hub.approve('telegram', { code: codeIn(adapter.to('200')[0] ?? '') })
  await say(BOB, 'summarize the news')
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]?.text).toContain('"Bob", an approved Telegram member (not the owner')
  expect(chats.sends[1]?.text).toEndWith('summarize the news')
})

test('groups need approval, a mention, and an approved sender', async () => {
  const { hub, adapter, chats, say } = await setup()
  await say(ALICE, 'hi')
  await until(() => adapter.to('100').length === 1)
  await hub.approve('telegram', { code: codeIn(adapter.to('100')[0] ?? '') })
  const group = { id: '-5', kind: 'group' as const, title: 'Team' }

  await say(ALICE, 'not for the bot', { ...group, mentioned: false })
  await say(BOB, 'stranger asks', group)
  await Bun.sleep(30)
  expect(adapter.to('-5')).toEqual([])

  await say(ALICE, 'please help', group)
  await until(() => adapter.to('-5').length === 1)
  const pending = hub.store.get('telegram').pending.find((p) => p.kind === 'group')
  expect(pending?.chat.title).toBe('Team')
  await hub.approve('telegram', { request: pending?.id ?? '' })

  await say(BOB, 'stranger again', group)
  await say(ALICE, 'now do it', group)
  await until(() => chats.sends.length === 1)
  await Bun.sleep(30)
  expect(chats.sends.map((s) => s.text)).toEqual(['now do it'])
  expect(chats.renamed['chat-1']).toBe('Telegram · Team')
})

test('a round shows a status line that follows the work, then the answer as a new message', async () => {
  const { hub, adapter, chats, say } = await setup()
  await say(ALICE, 'hi')
  await until(() => adapter.to('100').length === 1)
  await hub.approve('telegram', { code: codeIn(adapter.to('100')[0] ?? '') })
  const before = adapter.sent.length

  await say(ALICE, 'list the files')
  await until(() => adapter.sent.length === before + 1)
  const status = adapter.sent.at(-1)
  expect(status?.text).toBe('Working…')

  chats.emit('col-chat-1', 'agent/status', { agent: 'lead', status: 'working' })
  chats.emit('col-chat-1', 'tool/call', {
    agent: 'lead',
    callId: 'c1',
    tool: 'shell',
    args: { command: 'ls -la' },
  })
  await until(() => adapter.edits.some((e) => e.text.includes('lead: running `ls -la`')))
  expect(adapter.edits.every((e) => e.id === status?.id)).toBe(true)

  chats.emit('col-chat-1', 'artifact/versioned', {
    name: 'files.md',
    version: 1,
    blob: 'b',
    size: 1,
    author: 'lead',
    mediaType: 'text/markdown',
  })
  chats.emit('col-chat-1', 'chat/reply', {
    agent: 'lead',
    text: `Here they are:\n\n${'- a file\n'.repeat(40)}`,
    final: true,
  })
  chats.emit('col-chat-1', 'colony/completed', {})
  await until(() => adapter.sent.some((s) => s.text.startsWith('Files: files.md')))
  expect(adapter.edits.at(-1)?.text).toMatch(/^Done · \d+s$/)
  // The answer is longer than the platform's limit: it arrives in marked pieces.
  const pieces = adapter.to('100').filter((t) => /\(\d\/\d\)$/.test(t))
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces[0]).toStartWith('Here they are:')
})

test('commands: /new starts a fresh chat, /stop stops the running round, and redeliveries are dropped', async () => {
  const { hub, adapter, chats, say } = await setup()
  await say(ALICE, 'hi')
  await until(() => adapter.to('100').length === 1)
  await hub.approve('telegram', { code: codeIn(adapter.to('100')[0] ?? '') })

  await say(ALICE, 'first')
  await until(() => chats.sends.length === 1)
  await say(ALICE, '/stop')
  await until(() => chats.stopped.length === 1)
  expect(chats.stopped).toEqual(['chat-1'])

  // The same message delivered twice is handled once.
  const message = {
    messageId: 'dup-1',
    chat: { id: '100', kind: 'dm' as const },
    sender: ALICE,
    text: 'steer this',
    mentioned: true,
    time: new Date().toISOString(),
  }
  await adapter.io?.receive(message)
  await adapter.io?.receive(message)
  await until(() => chats.sends.length === 2)
  await Bun.sleep(30)
  expect(chats.sends).toHaveLength(2)
  expect(chats.sends[1]?.chatId).toBe('chat-1')

  await say(ALICE, '/new')
  await until(() => adapter.to('100').some((t) => t.startsWith('Fresh start')))
  await say(ALICE, 'second topic')
  await until(() => chats.sends.length === 3)
  expect(chats.sends[2]?.chatId).toBeUndefined()
})

test('chunking keeps code blocks whole in each piece, and Telegram HTML is escaped and balanced', () => {
  const code = `\`\`\`ts\n${'const x = 1 < 2 && true\n'.repeat(30)}\`\`\``
  const pieces = chunk(`Intro\n\n${code}\n\nOutro`, 300)
  expect(pieces.length).toBeGreaterThan(1)
  for (const p of pieces) {
    const fences = (p.match(/^```/gm) ?? []).length
    expect(fences % 2).toBe(0)
    expect(p.length).toBeLessThanOrEqual(300)
  }
  expect(telegramHtml('**bold** and _it_ and `a<b` and [x](https://e.com/?a=1&b=2)')).toBe(
    '<b>bold</b> and <i>it</i> and <code>a&lt;b</code> and <a href="https://e.com/?a=1&amp;b=2">x</a>',
  )
  expect(telegramHtml('# Title\n- item\n```js\nif (a < b) {}\n```')).toBe(
    '<b>Title</b>\n• item\n<pre><code class="language-js">if (a &lt; b) {}</code></pre>',
  )
  // Arithmetic is not mistaken for italics.
  expect(telegramHtml('2*3*4 = 24')).toBe('2*3*4 = 24')
})
