import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MyrEvent } from '@myrmidon/protocol'
import {
  type AdapterIO,
  BUILT_IN_CHANNELS,
  type ButtonPress,
  type ChannelAdapter,
  type ChannelChat,
  type ChannelChats,
  ChannelHub,
  type ChannelPatch,
  chunk,
  type Inbound,
  type InboundFile,
  type OutMessage,
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
  can = { buttons: true, files: true, edit: true }
  io?: AdapterIO
  sent: { chat: string; text: string; id: string; buttons?: OutMessage['buttons'] }[] = []
  edits: { id: string; text: string }[] = []
  files: { chat: string; name: string; size: number }[] = []
  presses: { id: string; note?: string }[] = []
  /** Sends fail while this is above zero (counting down), to exercise the delivery ledger. */
  failing = 0
  private _n = 0
  async check() {
    return '@fakebot'
  }
  async start(io: AdapterIO) {
    this.io = io
    io.status({ state: 'on', account: '@fakebot' })
  }
  async stop() {}
  async send(to: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const chat = typeof to === 'string' ? to : to.id
    if (this.failing > 0) {
      this.failing--
      throw new Error('network down')
    }
    const id = String(++this._n)
    this.sent.push({ chat, text: message.text, id, ...(message.buttons ? { buttons: message.buttons } : {}) })
    return { chat, id }
  }
  async edit(ref: SentRef, message: OutMessage) {
    this.edits.push({ id: ref.id, text: message.text })
  }
  async typing() {}
  async sendFile(to: ChannelChat | string, file: { name: string; data: Uint8Array }): Promise<SentRef> {
    const chat = typeof to === 'string' ? to : to.id
    this.files.push({ chat, name: file.name, size: file.data.byteLength })
    return { chat, id: String(++this._n) }
  }
  async answerPress(press: ButtonPress, note?: string) {
    this.presses.push({ id: press.id, ...(note ? { note } : {}) })
  }
  to(chat: string) {
    return this.sent.filter((s) => s.chat === chat).map((s) => s.text)
  }
}

/** Myrmidon's chats, faked: sends are recorded, and a test appends a round's events. */
class FakeChats implements ChannelChats {
  sends: { text: string; chatId: string | undefined; files?: string[]; askAll?: boolean }[] = []
  renamed: Record<string, string> = {}
  stopped: string[] = []
  decided: { colonyId: string; id: string; approved: boolean }[] = []
  alwaysAllowed: string[] = []
  heard = 'please check the logs'
  /** Sends and transcriptions fail with this while it is set. */
  refuse?: string
  events = new Map<string, MyrEvent[]>()
  running = new Set<string>()
  private _listeners = new Set<(colonyId: string, events: readonly MyrEvent[]) => void>()
  private _streams = new Set<
    (colonyId: string, agent: string, text: string, done: boolean, plain: boolean) => void
  >()
  private _n = 0

  async send(
    text: string,
    chatId: string | undefined,
    options?: { attachments?: readonly { name: string }[]; askAll?: boolean },
  ) {
    if (this.refuse) throw new Error(this.refuse)
    this.sends.push({
      text,
      chatId,
      ...(options?.attachments ? { files: options.attachments.map((a) => a.name) } : {}),
      ...(options?.askAll ? { askAll: true } : {}),
    })
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
  onStream(listener: (colonyId: string, agent: string, text: string, done: boolean, plain: boolean) => void) {
    this._streams.add(listener)
    return () => this._streams.delete(listener)
  }
  async read(colonyId: string) {
    return this.events.get(colonyId) ?? []
  }
  async decideApproval(colonyId: string, id: string, approved: boolean) {
    this.decided.push({ colonyId, id, approved })
    this.emit(colonyId, 'approval/decided', { id, approved, by: 'person' })
  }
  async allowAlways(tool: string) {
    this.alwaysAllowed.push(tool)
  }
  async artifact(_colonyId: string, name: string) {
    return { data: new TextEncoder().encode(`contents of ${name}`), mediaType: 'text/markdown' }
  }
  async transcribe() {
    if (this.refuse) throw new Error(this.refuse)
    return this.heard
  }
  stream(colonyId: string, text: string) {
    for (const l of this._streams) l(colonyId, 'lead', text, false, false)
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

const codeIn = (text: string) => /approve telegram ([A-Z2-9]{8})/.exec(text)?.[1] ?? ''

async function setup(patch: ChannelPatch = {}, existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'myr-channels-'))
  if (!existingDir) dirs.push(dir)
  const adapter = new FakeAdapter()
  const chats = new FakeChats()
  const hub = new ChannelHub({
    dir,
    chats,
    kinds: () => ({
      telegram: {
        label: 'Telegram',
        fields: [{ key: 'token', label: 'Token', secret: true }],
        make: () => adapter,
      },
    }),
    log: (m) => console.error(m),
  })
  hubs.push(hub)
  if (existingDir) await hub.start()
  else await hub.configure('telegram', { values: { token: 'tok' }, ...patch })
  await until(() => adapter.io !== undefined)
  let n = 0
  const say = (
    from: { id: string; name: string; handle?: string },
    text: string,
    extra: Partial<Inbound['chat']> & { mentioned?: boolean; files?: InboundFile[]; press?: string } = {},
  ) =>
    adapter.io?.receive({
      messageId: String(++n),
      chat: {
        id: extra.id ?? from.id,
        kind: extra.kind ?? 'dm',
        ...(extra.title ? { title: extra.title } : {}),
      },
      sender: from,
      text,
      mentioned: extra.mentioned ?? true,
      ...(extra.files ? { files: extra.files } : {}),
      ...(extra.press ? { press: { id: `cb${n}`, data: extra.press } } : {}),
      time: new Date().toISOString(),
    })
  /** Approves `who` by the code the bot sent them. */
  const pair = async (who: { id: string; name: string }) => {
    await say(who, 'hi')
    await until(() => adapter.to(who.id).length >= 1)
    await hub.approve('telegram', { code: codeIn(adapter.to(who.id).at(-1) ?? '') })
  }
  return { dir, hub, adapter, chats, say, pair }
}

/** Approves a group by the code the bot sends it when an approved person mentions it there. */
async function hubApproveGroup(
  say: Awaited<ReturnType<typeof setup>>['say'],
  adapter: FakeAdapter,
  group: { id: string; kind: 'group'; title: string },
) {
  await say(ALICE, 'hello', group)
  await until(() => adapter.to(group.id).length === 1)
  await hubs.at(-1)?.approve('telegram', { code: codeIn(adapter.to(group.id)[0] ?? '') })
}

const ALICE = { id: '100', name: 'Alice' }
const BOB = { id: '200', name: 'Bob', handle: 'bobby' }

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
  expect(approved?.person).toMatchObject({ role: 'owner', dm: '100' })
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

test('approving takes the code the requester was sent: a request id alone, or another request’s code, is refused', async () => {
  const { hub, adapter, say } = await setup()
  // A stranger writes first, under the owner's name; the real owner writes next.
  await say({ id: '666', name: 'Alice' }, 'hi')
  await say(ALICE, 'hi')
  await until(() => adapter.to('666').length === 1 && adapter.to('100').length === 1)
  const [stranger, mine] = hub.store.get('telegram').pending
  const myCode = codeIn(adapter.to('100')[0] ?? '')
  // Without the stranger's code their request cannot be approved: not by its id, not with someone else's code.
  expect(await hub.approve('telegram', { code: '', request: stranger?.id ?? '' })).toBeUndefined()
  expect(await hub.approve('telegram', { code: myCode, request: stranger?.id ?? '' })).toBeUndefined()
  expect(hub.store.get('telegram').people).toEqual([])
  const approved = await hub.approve('telegram', { code: myCode, request: mine?.id ?? '' })
  expect(approved?.person).toMatchObject({ id: '100', role: 'owner' })
})

test('a damaged channels.json is refused loudly and never overwritten; each save keeps the version before it', async () => {
  const { hub, dir } = await setup()
  const file = join(dir, 'channels.json')
  const versions = [readFileSync(file, 'utf8')]
  for (const stream of ['partial', 'final', 'progress'] as const) {
    await hub.configure('telegram', { stream })
    versions.push(readFileSync(file, 'utf8'))
  }
  // The last three versions before the current one, newest first: a bad save does not take the good one with it.
  expect(readFileSync(`${file}.bak`, 'utf8')).toBe(versions[2] ?? '')
  expect(readFileSync(`${file}.bak.2`, 'utf8')).toBe(versions[1] ?? '')
  expect(readFileSync(`${file}.bak.3`, 'utf8')).toBe(versions[0] ?? '')
  expect(statSync(`${file}.bak`).mode & 0o777).toBe(0o600)

  writeFileSync(file, '{"telegram": {"values": {"token": "tok"}, "peop')
  expect(() => hub.list()).toThrow("Can't read channels.json")
  await expect(hub.configure('telegram', { mention: true })).rejects.toThrow("Can't read channels.json")
  expect(() => hub.revoke('telegram', 'person', '100')).toThrow("Can't read channels.json")
  expect(readFileSync(file, 'utf8')).toBe('{"telegram": {"values": {"token": "tok"}, "peop')
})

test('a flood is answered once with a "slow down", not dropped silently and not answered every time', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  for (let i = 0; i < 25; i++) await say(ALICE, `message ${i}`)
  await until(() => adapter.to('100').some((t) => t.startsWith("That's a lot of messages")))
  await Bun.sleep(30)
  expect(adapter.to('100').filter((t) => t.startsWith("That's a lot of messages"))).toHaveLength(1)
  expect(chats.sends.length).toBeLessThanOrEqual(20)
})

test('a channel’s settings are saved whole or not at all: a missing required one is named, nothing is kept', async () => {
  const { hub } = await setup()
  await expect(hub.configure('telegram', { values: { token: ' ' } })).rejects.toThrow('Still needed: Token')
  expect(hub.store.get('telegram').values).toEqual({ token: 'tok' })
})

test('"let in without a code" takes entries in the platform’s own form, so a typo is refused, not ignored', async () => {
  const { hub } = await setup()
  await expect(hub.configure('telegram', { allow: ['@alice bob'] })).rejects.toThrow(
    'Not a Telegram ID or username: @alice bob.',
  )
  await hub.configure('telegram', { allow: [' @alice ', '123456789'] })
  expect(hub.store.get('telegram').allow).toEqual(['@alice', '123456789'])
  const ok = (id: string, entry: string) => BUILT_IN_CHANNELS[id]?.allow?.pattern.test(entry)
  // On IRC only the full mask can match (a nick is anyone's to take).
  expect(ok('irc', 'alice')).toBe(false)
  expect(ok('irc', 'alice!~al@host.example')).toBe(true)
  expect(ok('telegram', '@alice')).toBe(true)
  expect(ok('sms', '5551234567')).toBe(false)
  expect(ok('sms', '+15551234567')).toBe(true)
  expect(ok('matrix', '@alice:matrix.org')).toBe(true)
  expect(hub.list()[0]?.allowExample).toBeUndefined()
  expect(BUILT_IN_CHANNELS.irc?.allow?.example).toBe('alice!~alice@host.example')
})

test('owners record how they became it, and entries saved before they were checked are flagged, not blocking', async () => {
  const { hub, pair } = await setup()
  await pair(ALICE)
  expect(hub.store.get('telegram').people[0]).toMatchObject({ role: 'owner', by: 'code' })
  await pair(BOB)
  hub.setOwner('telegram', '200')
  const [alice, bob] = hub.store.get('telegram').people
  expect(alice?.by).toBeUndefined()
  expect(bob).toMatchObject({ role: 'owner', by: 'settings' })

  // An entry saved before entries were checked: shown as never matching, and other edits still save.
  hub.store.update('telegram', (c) => {
    c.allow = ['bob smith']
  })
  expect(hub.list()[0]?.allowInvalid).toEqual(['bob smith'])
  await hub.configure('telegram', { allow: ['bob smith', '@carol'] })
  expect(hub.store.get('telegram').allow).toEqual(['bob smith', '@carol'])
  await expect(hub.configure('telegram', { allow: ['bob smith', 'dan jones'] })).rejects.toThrow('dan jones')
})

test('removing a channel stops it and forgets its settings, people, chats and private files', async () => {
  const { hub, adapter, chats, say, pair, dir } = await setup()
  await pair(ALICE)
  await say(ALICE, 'build me a calculator')
  await until(() => chats.sends.length === 1)
  await say(BOB, 'hi')
  await until(() => adapter.to('200').length === 1)
  adapter.io?.set('offset', '42')
  writeFileSync(join(dir, 'telegram', 'auth.json'), '{}')
  await until(() => Object.keys(hub.chatChannels()).length === 1)

  await hub.remove('telegram')
  const [info] = hub.list()
  expect(info).toMatchObject({
    enabled: false,
    secretsSet: [],
    people: [],
    pending: [],
    status: { state: 'off' },
  })
  expect(hub.store.exists('telegram')).toBe(false)
  expect(hub.chatChannels()).toEqual({})
  expect(hub.activity('telegram')).toEqual([])
  expect(existsSync(join(dir, 'telegram'))).toBe(false)
  // Set up again, it starts from nothing: no offset carried over, and a stranger gets a fresh code.
  await hub.configure('telegram', { values: { token: 'tok2' } })
  await until(() => adapter.io !== undefined)
  expect(adapter.io?.get('offset')).toBeUndefined()
  expect(hub.store.get('telegram').people).toEqual([])
})

test('access policies: an allowlist lets listed people in as members and ignores the rest silently', async () => {
  const { adapter, chats, say, hub } = await setup({ dm: 'allowlist', allow: ['@bobby'] })
  await say(ALICE, 'let me in')
  // A sender the platform gives no vouched handle is not matched by one (an IRC nick anyone can take).
  await say({ id: 'bobby!~x@elsewhere', name: 'bobby' }, 'me too')
  await Bun.sleep(30)
  expect(adapter.to('100')).toEqual([])
  expect(chats.sends).toEqual([])
  await say(BOB, 'hello from the list')
  await until(() => chats.sends.length === 1)
  // Being listed never makes the owner: only Settings does.
  expect(hub.store.get('telegram').people).toMatchObject([{ id: '200', role: 'member', dm: '200' }])
  expect(chats.sends[0]?.askAll).toBe(true)
  expect(hub.setOwner('telegram', '200')).toBe(true)
  expect(hub.store.get('telegram').people).toMatchObject([{ id: '200', role: 'owner' }])
  expect(hub.setOwner('telegram', 'nobody')).toBe(false)

  // `open` lets anyone in as a member, without keeping them.
  await hub.configure('telegram', { dm: 'open' })
  await say(ALICE, 'open door')
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]?.text).toContain('an approved Telegram member')
  expect(hub.store.get('telegram').people).toHaveLength(1)
})

test('groups need approval, a mention, and an approved sender; per-person conversations split them', async () => {
  const { hub, adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  const group = { id: '-5', kind: 'group' as const, title: 'Team' }

  await say(ALICE, 'not for the bot', { ...group, mentioned: false })
  await say(BOB, 'stranger asks', group)
  await Bun.sleep(30)
  expect(adapter.to('-5')).toEqual([])

  await say(ALICE, 'please help', group)
  await until(() => adapter.to('-5').length === 1)
  const pending = hub.store.get('telegram').pending.find((p) => p.kind === 'group')
  expect(pending?.chat.title).toBe('Team')
  await hub.approve('telegram', { code: codeIn(adapter.to('-5')[0] ?? ''), request: pending?.id ?? '' })

  await say(BOB, 'stranger again', group)
  await say(ALICE, 'now do it', group)
  await until(() => chats.sends.length === 1)
  await Bun.sleep(30)
  expect(chats.sends.map((s) => s.text)).toEqual(['now do it'])
  expect(chats.renamed['chat-1']).toBe('Telegram · Team')

  // Per person: Bob, once approved, gets his own conversation in the same group.
  await pair(BOB)
  await hub.configure('telegram', { perPerson: true })
  await say(BOB, 'mine', group)
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]?.chatId).toBeUndefined()
})

test('a round shows a status line that follows the work, then the answer and its files', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)
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
    name: 'out/files.md',
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
  await until(() => adapter.files.length === 1)
  expect(adapter.files[0]).toMatchObject({ chat: '100', name: 'files.md' })
  expect(adapter.edits.at(-1)?.text).toMatch(/^Done · \d+s$/)
  // The answer is longer than the platform's limit: it arrives in marked pieces.
  const pieces = adapter.to('100').filter((t) => /\(\d\/\d\)$/.test(t))
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces[0]).toStartWith('Here they are:')
})

test('approvals go to the owner with buttons; only the owner decides, and "always" changes the rule', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  await pair(BOB)
  await say(BOB, 'deploy it')
  await until(() => chats.sends.length === 1)
  chats.emit('col-chat-1', 'approval/requested', {
    id: 'ap-1',
    agent: 'lead',
    tool: 'shell',
    summary: 'run `rm -rf build`',
    review: {
      kind: 'command',
      title: 'Run',
      fields: [{ key: 'command', label: 'Command', value: 'rm -rf build', format: 'code', editable: false }],
    },
  })
  // A member's round asks for every step (whatever the owner allowed), and asks the owner, in the owner's own chat,
  // saying whose run it is; it says so where it started.
  expect(chats.sends[0]?.askAll).toBe(true)
  await until(() => adapter.sent.some((s) => s.chat === '100' && s.buttons))
  const ask = adapter.sent.find((s) => s.chat === '100' && s.buttons)
  expect(ask?.text).toContain('**lead** wants to run `rm -rf build`')
  expect(ask?.text).toContain('Bob (a member, not the owner)')
  await until(() => adapter.to('200').includes("Waiting for the owner's approval."))
  // No "always" from a member's run: it would widen the owner's own rules.
  const [once, deny] = (ask?.buttons ?? []).map((row) => row[0]?.data ?? '')
  expect(ask?.buttons).toHaveLength(2)
  expect(deny).toContain('a:d:')

  // Bob pressing Deny is refused.
  await say(BOB, '', { press: deny ?? '' })
  await until(() => adapter.presses.some((p) => p.note === 'Only the owner can approve this.'))
  expect(chats.decided).toEqual([])

  // An "always" pressed anyway counts once.
  await say(ALICE, '', { press: (once ?? '').replace('a:o:', 'a:a:') })
  await until(() => chats.decided.length === 1)
  expect(chats.decided[0]).toEqual({ colonyId: 'col-chat-1', id: 'ap-1', approved: true })
  expect(chats.alwaysAllowed).toEqual([])
  // The same button again: the request is closed.
  await say(ALICE, '', { press: once ?? '' })
  await until(() => adapter.presses.some((p) => p.note === 'This request is no longer open.'))

  // The owner's own round offers "always", which changes the rule.
  await say(ALICE, 'tidy up')
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]?.askAll).toBeUndefined()
  chats.emit('col-chat-2', 'approval/requested', {
    id: 'ap-2',
    agent: 'lead',
    tool: 'shell',
    summary: 'run ls',
  })
  await until(() => adapter.sent.filter((s) => s.chat === '100' && s.buttons).length === 2)
  const mine = adapter.sent.filter((s) => s.chat === '100' && s.buttons).at(-1)
  const always = mine?.buttons?.[1]?.[0]?.data ?? ''
  expect(always).toContain('a:a:')
  await say(ALICE, '', { press: always })
  await until(() => chats.decided.length === 2)
  expect(chats.alwaysAllowed).toEqual(['shell'])
  await until(() =>
    adapter.edits.some((e) => e.text.includes('✅ Allowed by Alice; shell is now always allowed')),
  )
})

test('without buttons, approvals and questions are answered by typing', async () => {
  const { adapter, chats, say, pair } = await setup()
  adapter.can = { buttons: false, files: false, edit: true }
  await pair(ALICE)
  await say(ALICE, 'go')
  await until(() => chats.sends.length === 1)
  chats.emit('col-chat-1', 'approval/requested', {
    id: 'ap-2',
    agent: 'lead',
    tool: 'fs_write',
    summary: 'write a.txt',
  })
  await until(() => adapter.to('100').some((t) => t.includes('/deny ')))
  await say(ALICE, '/status')
  await until(() => adapter.to('100').some((t) => t.endsWith('Waiting for your approval')))
  const k = /\/deny (\S+?)\./.exec(adapter.to('100').find((t) => t.includes('/deny')) ?? '')?.[1] ?? ''
  await say(ALICE, `/deny ${k}`)
  await until(() => chats.decided.length === 1)
  expect(chats.decided[0]?.approved).toBe(false)

  chats.emit('col-chat-1', 'chat/reply', {
    agent: 'lead',
    text: 'A quick question.',
    final: false,
    question: true,
    choices: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
  })
  await until(() => adapter.to('100').some((t) => t.startsWith('Which colour?\n1. Red\n2. Blue')))
  await say(ALICE, '2')
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]).toEqual({ text: 'Which colour? → Blue', chatId: 'chat-1' })
})

test('questions with options become buttons; the answers go back together in the app’s format', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  await say(ALICE, 'plan a trip')
  await until(() => chats.sends.length === 1)
  chats.emit('col-chat-1', 'chat/reply', {
    agent: 'lead',
    text: 'Before I start:',
    final: false,
    question: true,
    choices: [
      { question: 'Where?', options: [{ label: 'Lisbon' }, { label: 'Oslo' }] },
      { question: 'How long?', options: [{ label: 'A weekend' }, { label: 'A week' }] },
    ],
  })
  await until(() => adapter.sent.filter((s) => s.buttons).length === 2)
  const [where, long] = adapter.sent.filter((s) => s.buttons)
  await say(ALICE, '', { press: where?.buttons?.[1]?.[0]?.data ?? '' })
  await say(ALICE, '', { press: long?.buttons?.[2]?.[0]?.data ?? '' })
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]?.text).toBe('Where? → Oslo\nHow long? → (skipped: your call)')
  expect(adapter.edits.some((e) => e.text === 'Where?\n→ Oslo')).toBe(true)
})

test('answering a question keeps a member’s round asking, and in a group only its asker or the owner may answer', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  await pair(BOB)
  const ask = (colonyId: string) =>
    chats.emit(colonyId, 'chat/reply', {
      agent: 'lead',
      text: 'One thing first:',
      final: false,
      question: true,
      choices: [{ question: 'Which?', options: [{ label: 'This' }, { label: 'That' }] }],
    })
  const buttons = () => adapter.sent.filter((s) => s.buttons && s.text === 'Which?')

  // Bob's round asks; the answer starts the next round, which asks for every step too, even when the owner answers.
  await say(BOB, 'clean up the server')
  await until(() => chats.sends.length === 1)
  ask('col-chat-1')
  await until(() => buttons().length === 1)
  await say(ALICE, '', { press: buttons()[0]?.buttons?.[0]?.[0]?.data ?? '' })
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]).toMatchObject({ text: 'Which? → This', chatId: 'chat-1', askAll: true })

  // Alice's round in a group: Bob cannot answer her question; his own answer would come in marked as his.
  const group = { id: '-7', kind: 'group' as const, title: 'Ops' }
  await hubApproveGroup(say, adapter, group)
  await say(ALICE, 'deploy', group)
  await until(() => chats.sends.length === 3)
  ask('col-chat-2')
  await until(() => buttons().length === 2)
  const theirs = buttons()[1]?.buttons?.[1]?.[0]?.data ?? ''
  await say(BOB, '', { ...group, press: theirs })
  await until(() => adapter.presses.some((p) => p.note?.startsWith('This question is for')))
  await say(BOB, '2', group)
  await until(() => adapter.to('-7').some((t) => t.startsWith('This question is for')))
  expect(chats.sends).toHaveLength(3)
  await say(ALICE, '', { ...group, press: theirs })
  await until(() => chats.sends.length === 4)
  expect(chats.sends[3]).toEqual({ text: 'Which? → That', chatId: 'chat-2' })
})

test('voice notes are transcribed and echoed; photos and files become attachments', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  const voice: InboundFile = {
    kind: 'voice',
    name: 'voice.ogg',
    mimeType: 'audio/ogg',
    read: async () => new Uint8Array([1, 2, 3]),
  }
  await say(ALICE, '', { files: [voice] })
  await until(() => chats.sends.length === 1)
  expect(chats.sends[0]?.text).toBe('please check the logs')
  expect(adapter.to('100')).toContain('🎙️ “please check the logs”')

  const photo: InboundFile = {
    kind: 'image',
    name: 'screen.png',
    mimeType: 'image/png',
    read: async () => new Uint8Array([9, 9]),
  }
  await say(ALICE, 'what is wrong here?', { files: [photo] })
  await until(() => chats.sends.length === 2)
  expect(chats.sends[1]).toMatchObject({ text: 'what is wrong here?', files: ['screen.png'] })
})

test('a failure on a sender’s behalf tells them only that it failed; why goes to the owner’s Activity tab', async () => {
  const { hub, adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  chats.refuse = 'no default model: see /Users/robin/.myrmidon/agent/models.yml'
  await say(ALICE, 'do it')
  await until(() => adapter.to('100').includes("I couldn't do that. The owner can see why in Myrmidon."))
  await say(ALICE, '', {
    files: [{ kind: 'voice', name: 'v.ogg', mimeType: 'audio/ogg', read: async () => new Uint8Array([1]) }],
  })
  await until(() => adapter.to('100').some((text) => text.startsWith("I couldn't transcribe that")))
  expect(adapter.to('100').join('\n')).not.toContain('/Users/robin')
  expect(hub.activity('telegram').filter((e) => e.text.includes('/Users/robin'))).toHaveLength(2)
})

test('answers that fail to send are kept and resent when the channel comes back, marked as possibly repeated', async () => {
  const first = await setup()
  await first.pair(ALICE)
  await first.say(ALICE, 'tell me')
  await until(() => first.chats.sends.length === 1)
  // The network drops just as the answer goes out (and its retry is minutes away).
  first.adapter.failing = 5
  first.chats.emit('col-chat-1', 'chat/reply', { agent: 'lead', text: 'The answer is 42.', final: true })
  first.chats.emit('col-chat-1', 'colony/completed', {})
  await Bun.sleep(80)
  expect(first.adapter.to('100').some((t) => t.includes('42'))).toBe(false)
  await first.hub.stop()
  hubs.splice(hubs.indexOf(first.hub), 1)

  // A restart: the owed answer goes out once the channel is on again.
  const second = await setup({}, first.dir)
  await until(() => second.adapter.to('100').some((t) => t.includes('The answer is 42.')))
  expect(second.adapter.to('100').find((t) => t.includes('42'))).toStartWith('♻️ Recovered reply')
})

test('commands: /new starts a fresh chat, /stop stops the running round, and redeliveries are dropped', async () => {
  const { adapter, chats, say, pair } = await setup()
  await pair(ALICE)

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

test('streaming modes: partial writes the reply into one message; notify reaches the owner', async () => {
  const { adapter, chats, say, pair, hub } = await setup({ stream: 'partial' })
  await pair(ALICE)
  const before = adapter.sent.length
  await say(ALICE, 'write a haiku')
  await until(() => chats.sends.length === 1)
  chats.stream('col-chat-1', 'Autumn moonlight')
  await until(() => adapter.sent.length === before + 1)
  expect(adapter.sent.at(-1)?.text).toBe('Autumn moonlight ▉')
  chats.stream('col-chat-1', 'Autumn moonlight—\na worm digs silently')
  await until(() => adapter.edits.some((e) => e.text.includes('a worm digs')))
  chats.emit('col-chat-1', 'chat/reply', {
    agent: 'lead',
    text: 'Autumn moonlight—\na worm digs silently\ninto the chestnut.',
    final: true,
  })
  chats.emit('col-chat-1', 'colony/completed', {})
  await until(() => adapter.edits.some((e) => e.text.endsWith('into the chestnut.')))
  // No status line in this mode: the draft became the answer.
  expect(adapter.to('100').includes('Working…')).toBe(false)

  expect(await hub.notify('Long job finished.')).toBe('Telegram · Alice')
  await until(() => adapter.to('100').includes('Long job finished.'))
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

test('a platform that cannot edit is told how an approval ended in a new message', async () => {
  const { adapter, chats, say, pair } = await setup()
  adapter.can = { buttons: false, files: false, edit: false }
  await pair(ALICE)
  await say(ALICE, 'go')
  await until(() => chats.sends.length === 1)
  chats.emit('col-chat-1', 'approval/requested', {
    id: 'ap-3',
    agent: 'lead',
    tool: 'shell',
    summary: 'run ls',
  })
  await until(() => adapter.to('100').some((t) => t.includes('/deny ')))
  // Decided in the app: the chat cannot edit the request, so it gets the outcome on its own.
  chats.emit('col-chat-1', 'approval/decided', { id: 'ap-3', approved: true, by: 'person' })
  await until(() => adapter.to('100').includes('✅ Allowed in the app'))
  expect(adapter.edits.some((e) => e.text.includes('Allowed'))).toBe(false)
})

test('platforms set their own command prefix and starting rules; an owner without a private chat approves in the group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-channels-'))
  dirs.push(dir)
  const adapter = Object.assign(new FakeAdapter(), { commandPrefix: '!' })
  adapter.can = { buttons: false, files: false, edit: false }
  const chats = new FakeChats()
  const hub = new ChannelHub({
    dir,
    chats,
    kinds: () => ({
      twitch: {
        label: 'Twitch',
        fields: [{ key: 'token', label: 'Token', secret: true }],
        defaults: { groups: 'open' },
        make: () => adapter,
      },
    }),
  })
  hubs.push(hub)
  await hub.configure('twitch', { values: { token: 'tok' }, allow: ['@owner'] })
  // The platform's own starting rule applied, and only the first time.
  expect(hub.store.get('twitch').groups).toBe('open')
  await hub.configure('twitch', { groups: 'approve' })
  await hub.configure('twitch', { groups: 'open', mention: true })
  expect(hub.store.get('twitch').groups).toBe('open')

  const owner = { id: 'o1', name: 'Olive', handle: 'owner' }
  const say = (text: string) =>
    adapter.io?.receive({
      messageId: `${Math.random()}`,
      chat: { id: '#stream', kind: 'group', title: 'stream' },
      sender: owner,
      text,
      mentioned: true,
      time: new Date().toISOString(),
    })
  // The adapter turns `!help` into `/help` on the way in; the hub's answer writes commands the platform's way.
  await say('/help')
  await until(() => adapter.to('#stream').some((t) => t.includes('!new: start a fresh conversation')))
  // Listed, Olive came in as a member; Settings makes her the owner.
  hub.setOwner('twitch', 'o1')

  await say('play a song list')
  await until(() => chats.sends.length === 1)
  chats.emit('col-chat-1', 'approval/requested', {
    id: 'ap-9',
    agent: 'lead',
    tool: 'web_fetch',
    summary: 'read a page',
  })
  // No private chat on this platform: the approval is asked in the group, with `!` commands.
  await until(() => adapter.to('#stream').some((t) => t.includes('!approve ')))
  expect(adapter.to('#stream').some((t) => t.includes('no owner'))).toBe(false)
})

test('health and activity: last message in and out, events by name only, and which chat came from where', async () => {
  const { hub, adapter, chats, say, pair } = await setup()
  await pair(ALICE)
  await say(ALICE, 'a private question about my health records')
  await until(() => chats.sends.length === 1)
  chats.emit('col-chat-1', 'chat/reply', { agent: 'lead', text: 'Here you go.', final: true })
  chats.emit('col-chat-1', 'colony/completed', {})
  await until(() => adapter.to('100').includes('Here you go.'))
  const info = hub.list().find((c) => c.id === 'telegram')
  expect(info?.health).toMatchObject({ reconnects: 0, owed: 0 })
  expect(info?.health.lastIn).toBeDefined()
  expect(info?.health.lastOut).toBeDefined()
  const events = hub.activity('telegram').map((e) => e.text)
  expect(events).toContain('Message from Alice')
  expect(events).toContain('Answer delivered')
  expect(events).toContain('Approved Alice')
  // What people wrote never reaches the activity log.
  expect(JSON.stringify(hub.activity())).not.toContain('health records')
  expect(hub.chatChannels()).toEqual({ 'chat-1': 'telegram' })

  // Trouble is counted and named.
  adapter.io?.status({ state: 'retrying', error: 'network down' })
  expect(hub.list()[0]?.health).toMatchObject({ reconnects: 1, lastError: 'network down' })
})
