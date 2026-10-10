import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony } from '@myrmidon/protocol'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import { pendingOn } from '../../../tests/platform.ts'
import { SANDBOX_HIDDEN_ROOTS } from '../src/config.ts'
import {
  bootRuntime,
  bwrapMounts,
  ChatService,
  ColonyWorkspace,
  detectSandbox,
  grantCovers,
  keysAt,
  ModelResolver,
  macProfile,
  ProjectStore,
  type Runtime,
  reachable,
  realPath,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'

/** Keys only this system has; cross-platform.test.ts pins each system's whole list. */
const SYSTEM_SECRETS: readonly string[] =
  {
    darwin: [
      'Library/Containers/com.example.app/Data/x',
      'Library/Group Containers/group.example/x',
      '.dotnet/corefx/cryptography/x509stores/my/key.pfx',
    ],
    linux: [
      '.var/app/org.example.App/data/x',
      'snap/chromium/common/x',
      '.pki/nssdb/key4.db',
      '.dotnet/corefx/cryptography/x509stores/my/key.pfx',
    ],
    win32: ['AppData/Roaming/GitHub CLI/hosts.yml', 'AppData/Local/Packages/app/x', '_netrc'],
  }[process.platform as string] ?? []

/**
 * A stand-in home: shell config, keys, Myrmidon's data with this chat's colony and another chat's, a project and a
 * toolchain. The person's real home is never read; the sandbox is told this one is home.
 */
let root: string
let home: string
let data: string
let colony: string
let other: string
let scratch: string
let project: string
let toolchain: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'myr-reads-')))
  home = join(root, 'home')
  data = join(home, '.myrmidon')
  colony = join(data, 'colonies', 'mine')
  other = join(data, 'colonies', 'other')
  scratch = join(colony, 'scratch', 'lead')
  project = join(home, 'code', 'app')
  toolchain = join(home, '.bun', 'bin')
  for (const d of [scratch, other, project, toolchain, join(home, '.ssh'), join(home, 'notes')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export TOKEN=hidden')
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'private key')
  writeFileSync(join(home, 'notes', 'todo.md'), 'notes')
  writeFileSync(join(other, 'events.txt'), 'another chat')
  writeFileSync(join(colony, 'notes.md'), 'this chat')
  writeFileSync(join(project, 'README.md'), 'the project')
  writeFileSync(join(toolchain, 'tool'), 'a toolchain')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const confined = (extra: { readable?: string[]; hidden?: string[] } = {}) => ({
  cwd: project,
  writable: [project, scratch],
  readable: [colony, project, ...(extra.readable ?? [])],
  hidden: [data, join(home, '.ssh'), ...(extra.hidden ?? [])],
})

pendingOn(
  'linux',
  'bwrapHiddenFolders',
  detectSandbox().kind === 'none',
)(
  "a sandboxed command cannot read the home, other chats or keys, but reads its project, this chat's files and toolchains",
  async () => {
    const sandbox = detectSandbox({ home })
    const run = async (command: string) => sandbox.run({ ...confined(), command, timeoutMs: 10_000 })
    expect((await run(`cat "${home}/.zshrc"`)).code).not.toBe(0)
    expect((await run(`ls "${home}"`)).code).not.toBe(0)
    expect((await run(`ls "${data}/colonies"`)).code).not.toBe(0)
    expect((await run(`cat "${other}/events.txt"`)).code).not.toBe(0)
    expect((await run(`cat "${home}/.ssh/id_ed25519"`)).code).not.toBe(0)
    expect((await run(`cat "${home}/notes/todo.md"`)).code).not.toBe(0)
    const ok = await run(
      `cat README.md "${colony}/notes.md" "${toolchain}/tool" && echo x > "${scratch}/w" && cat "${scratch}/w"`,
    )
    expect(ok.stderr).toBe('')
    expect(ok.stdout).toBe('the projectthis chata toolchainx\n')
    // Writing stays where it was: the project and scratch, never a folder it may only read.
    expect((await run(`touch "${colony}/x"`)).code).not.toBe(0)
  },
)

test.skipIf(detectSandbox().kind === 'none')(
  'a folder the person opens is readable, not writable; keys inside it stay hidden unless named exactly',
  async () => {
    const sandbox = detectSandbox({ home })
    const run = async (command: string, extra: { readable?: string[] } = {}) =>
      sandbox.run({ ...confined(extra), command, timeoutMs: 10_000 })
    expect((await run(`cat "${home}/notes/todo.md"`, { readable: [join(home, 'notes')] })).stdout).toBe(
      'notes',
    )
    expect((await run(`touch "${home}/notes/x"`, { readable: [join(home, 'notes')] })).code).not.toBe(0)
    // "Everything in my home": notes are readable, keys and other chats are not.
    const everything = { readable: [home] }
    expect((await run(`cat "${home}/notes/todo.md"`, everything)).code).toBe(0)
    expect((await run(`cat "${home}/.ssh/id_ed25519"`, everything)).code).not.toBe(0)
    expect((await run(`cat "${other}/events.txt"`, everything)).code).not.toBe(0)
    expect((await run(`cat "${colony}/notes.md"`, everything)).stdout).toBe('this chat')
    // Named exactly (only Settings can), the keys' folder opens.
    expect((await run(`cat "${home}/.ssh/id_ed25519"`, { readable: [join(home, '.ssh')] })).stdout).toBe(
      'private key',
    )
  },
)

test('the deepest rule decides: a hidden folder inside a readable one stays hidden, a root inside it reopens', () => {
  expect(reachable('/h/a/b', ['/h/a'], ['/h'])).toBe(true)
  expect(reachable('/h/.ssh/k', ['/h'], ['/h', '/h/.ssh'])).toBe(false)
  expect(reachable('/h/.ssh/k', ['/h', '/h/.ssh'], ['/h', '/h/.ssh'])).toBe(true)
  expect(reachable('/h/data/c/x', ['/h/data/c'], ['/h/data'])).toBe(true)
  expect(reachable('/h/data/other', ['/h/data/c'], ['/h/data'])).toBe(false)
  expect(reachable('/elsewhere', ['/h'], [])).toBe(false)
})

test('the macOS profile hides the home, then opens what may be read, parents first', () => {
  const profile = macProfile(confined(), home)
  const at = (line: string) => profile.indexOf(line)
  expect(at(`(deny file-read* (subpath "${home}"))`)).toBeGreaterThan(0)
  expect(at(`(deny file-read* (subpath "${data}"))`)).toBeGreaterThan(
    at(`(deny file-read* (subpath "${home}"))`),
  )
  expect(at(`(allow file-read* (subpath "${colony}"))`)).toBeGreaterThan(
    at(`(deny file-read* (subpath "${data}"))`),
  )
  expect(at(`(allow file-read* (subpath "${realpathSync(join(home, '.bun'))}"))`)).toBeGreaterThan(0)
  expect(at(`(allow file-write* (subpath "${scratch}"))`)).toBeGreaterThan(at('(deny file-write*)'))
  // Folders above an open one can be looked up, not listed.
  expect(profile).toContain(`(literal "${home}")`)
  // Sockets follow the write rules: none in the data folder or a folder only read, the agent's scratch is fine.
  expect(at(`(deny network-outbound (remote unix-socket (subpath "${data}")))`)).toBeGreaterThan(0)
  expect(at(`(allow network-outbound (remote unix-socket (subpath "${scratch}")))`)).toBeGreaterThan(
    at(`(deny network-outbound (remote unix-socket (subpath "${data}")))`),
  )
  expect(profile).not.toContain(`(allow network-outbound (remote unix-socket (subpath "${colony}")))`)
  // This system's own roots (cross-platform.test.ts pins each system's list).
  for (const dir of SANDBOX_HIDDEN_ROOTS) expect(profile).toContain(`(deny file-read* (subpath "${dir}"))`)
  expect(profile).toContain('(deny network-outbound (remote unix-socket (regex #"^/private/tmp/myr-")))')
  expect(profile).toContain('(deny appleevent-send)')
  expect(profile).toContain(
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.windowserver") (global-name "com.apple.replayd"))',
  )
  expect(profile).toContain('(deny lsopen)')
  expect(profile).toContain('(deny mach-lookup (global-name-regex #"^com\\.apple\\.pasteboard\\."))')
  // The /tmp/myr-* rule comes after the reads, so no readable folder reopens it, and one regex covers them all.
  expect(at('(deny file-read* (regex #"^/private/tmp/myr-"))')).toBeGreaterThan(
    profile.lastIndexOf('(allow file-read* (subpath'),
  )
  if (process.platform === 'darwin') expect(profile).not.toContain('(subpath "/private/tmp/myr-')
})

test('bubblewrap gets the same rules as mounts: an empty home, then what may be read, then what may be written', () => {
  const mounts = bwrapMounts(confined(), home)
  const pairs: string[] = []
  for (let i = 0; i < mounts.length; i++) {
    const flag = mounts[i] as string
    if (flag === '--tmpfs') pairs.push(`tmpfs ${mounts[++i]}`)
    else {
      const from = mounts[++i]
      const to = mounts[++i]
      pairs.push(`${flag.slice(2)} ${from === '/dev/null' ? 'null ' : ''}${to}`)
    }
  }
  const index = (p: string) => pairs.indexOf(p)
  // Nothing inside the home comes before the home is emptied.
  expect(pairs.findIndex((p) => p.includes(home))).toBe(index(`tmpfs ${home}`))
  expect(index(`tmpfs ${data}`)).toBeGreaterThan(0)
  expect(index(`tmpfs ${join(home, '.ssh')}`)).toBeGreaterThan(0)
  expect(index(`ro-bind ${project}`)).toBeGreaterThan(0)
  expect(index(`bind ${project}`)).toBeGreaterThan(index(`ro-bind ${project}`))
  expect(index(`ro-bind ${colony}`)).toBeGreaterThan(index(`tmpfs ${data}`))
  expect(index(`bind ${scratch}`)).toBeGreaterThan(index(`ro-bind ${colony}`))
  expect(index(`ro-bind ${realpathSync(join(home, '.bun'))}`)).toBeGreaterThan(0)
  // A hidden file is covered with /dev/null, not a tmpfs.
  writeFileSync(join(home, '.netrc'), 'machine x password y')
  expect(bwrapMounts({ ...confined(), hidden: [join(home, '.netrc')], readable: [home] }, home)).toEqual(
    expect.arrayContaining(['--ro-bind', '/dev/null', join(home, '.netrc')]),
  )
})

test.skipIf(detectSandbox().kind === 'none')(
  ".NET's certificate store stays hidden inside its readable toolchain folder",
  async () => {
    const dotnet = join(home, '.dotnet')
    const store = join(dotnet, 'corefx', 'cryptography', 'x509stores', 'my')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(dotnet, 'dotnet'), 'the toolchain')
    writeFileSync(join(store, 'key.pfx'), 'a private key')
    const ws = new ColonyWorkspace(colony, project, () => false, { dataDir: data, home, reads: () => [] })
    const run = (command: string) =>
      detectSandbox({ home }).run({ ...confined(), ...ws.confinement(), command, timeoutMs: 10_000 })
    expect((await run(`cat "${dotnet}/dotnet"`)).stdout).toBe('the toolchain')
    expect((await run(`cat "${store}/key.pfx"`)).code).not.toBe(0)
  },
)

test('file tools refuse what the sandbox hides, open what the person allowed, and reach anything with full access', () => {
  let reads: string[] = []
  let unconfined = false
  const ws = new ColonyWorkspace(colony, project, () => unconfined, {
    dataDir: data,
    home,
    reads: () => reads,
  })
  const agent = 'lead'
  expect(ws.resolveForRead(agent, 'README.md')).toBe(join(project, 'README.md'))
  expect(() => ws.resolveForRead(agent, `${home}/.zshrc`)).toThrow('outside your project')
  expect(() => ws.resolveForRead(agent, '~/.zshrc')).toThrow('request_read')
  expect(() => ws.resolveForRead(agent, `${other}/events.txt`)).toThrow('outside your project')
  // A link in the project that points at the keys does not reach them.
  symlinkSync(join(home, '.ssh'), join(project, 'keys'))
  expect(() => ws.resolveForRead(agent, 'keys/id_ed25519')).toThrow('outside your project')

  reads = [join(home, 'notes')]
  expect(ws.resolveForRead(agent, '~/notes/todo.md')).toBe(join(home, 'notes', 'todo.md'))
  // Reading is not writing.
  expect(() => ws.resolveInWorkdir(agent, `${home}/notes/todo.md`)).toThrow('outside your project')

  reads = [home]
  expect(ws.mayRead(agent, join(home, 'notes', 'todo.md'))).toBe(true)
  expect(ws.mayRead(agent, join(home, '.ssh', 'id_ed25519'))).toBe(false)
  // Shell startup files, other agents' sign-ins and app data are keys too.
  for (const secret of [
    '.zshrc',
    '.zshenv',
    '.bashrc',
    '.bash_profile',
    '.profile',
    '.omp/agent/agent.db',
    '.claude/.credentials.json',
    '.claude.json',
    '.codex/auth.json',
    '.gemini/oauth_creds.json',
    '.terraform.d/credentials.tfrc.json',
    '.vault-token',
    '.pgpass',
    '.gem/credentials',
    '.m2/settings.xml',
    '.zsh_sessions/x.history',
    '.python_history',
    '.psql_history',
    '.yarnrc.yml',
    '.gradle/gradle.properties',
    '.composer/auth.json',
    ...SYSTEM_SECRETS,
  ])
    expect({ secret, read: ws.mayRead(agent, join(home, secret)) }).toEqual({ secret, read: false })
  expect(ws.mayRead(agent, join(home, '.m2', 'repository', 'x.jar'))).toBe(true)
  expect(ws.mayRead(agent, join(home, '.dotnet', 'dotnet'))).toBe(true)
  expect(ws.mayRead(agent, join(other, 'events.txt'))).toBe(false)
  expect(ws.confinement().hidden).toEqual(expect.arrayContaining([data, join(home, '.ssh')]))

  reads = []
  unconfined = true
  expect(ws.resolveForRead(agent, `${home}/.zshrc`)).toBe(join(home, '.zshrc'))
})

// --- The three levels, through real chats -------------------------------------------------------------------

let myr: string
let outside: string
/** A file no one has in their keys folder. */
const absent = 'myr-test-absent-file'
let runtime: Runtime

const setUpChats = async () => {
  myr = mkdtempSync(join(tmpdir(), 'myr-reads-home-'))
  // A folder that is no project and no scratch: file tools reach it only when the person allows it.
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'myr-reads-outside-')))
  writeFileSync(join(outside, 'spec.md'), 'the spec')
  runtime = await bootRuntime(myr)
}

const tearDownChats = async () => {
  await runtime.dispose()
  rmSync(myr, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

function models(script: MockContent[][]) {
  const resolver = new ModelResolver()
  let call = 0
  const prompts: string[] = []
  const lead = createMockModel({
    handler: (ctx) => {
      prompts.push([ctx.systemPrompt ?? []].flat().join('\n'))
      return { content: script[call++] ?? ['ok'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  return Object.assign(resolver, { prompts })
}

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
}

async function waitFor(
  colonyId: string,
  until = (s: ColonyState) => s.status !== 'running' && s.status !== 'created',
) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

const results = async (colonyId: string) =>
  (await runtime.ctx.log.read(colonyId as never))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])

const readSpec = () => [
  [tool('fs_read', { path: join(outside, 'spec.md') })],
  [tool('reply_user', { text: 'Done.', final: true })],
]

test('a folder listed in Settings opens for every chat of the person, never for a channel member', async () => {
  await setUpChats()
  try {
    const settings = new SettingsStore(myr)
    const before = new ChatService(runtime, { resolver: models(readSpec()), settings })
    const one = await before.send('Read the spec', config)
    await waitFor(one.colonyId)
    expect((await results(one.colonyId))[0]?.ok).toBe(false)
    await before.stopAll()

    settings.set({ ...settings.get(), sandbox: { enabled: true, read: [outside, '~/.ssh'] } })
    const told = models(readSpec())
    const after = new ChatService(runtime, { resolver: told, settings })
    const two = await after.send('Read the spec', config)
    await waitFor(two.colonyId)
    const [read] = await results(two.colonyId)
    expect(read?.ok).toBe(true)
    expect(read?.output).toContain('the spec')
    // The agent is told which folders it may read, and how to ask for more.
    expect(told.prompts[0]).toContain(outside)
    expect(told.prompts[0]).toContain('request_read')
    // Settings alone can open the keys' folder, by naming it (the test never reads it).
    expect(told.prompts[0]).toContain(join(homedir(), '.ssh'))
    await after.stopAll()

    const member = models(readSpec())
    const members = new ChatService(runtime, { resolver: member, settings })
    const three = await members.send('Read the spec', config, undefined, { askAll: true })
    await waitFor(three.colonyId)
    expect((await results(three.colonyId))[0]?.ok).toBe(false)
    expect(member.prompts[0]).not.toContain(outside)
    await members.stopAll()
  } finally {
    await tearDownChats()
  }
})

test("a project's readable folders open for its chats only, and it can never name keys or other chats", async () => {
  await setUpChats()
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'myr-reads-project-')))
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'myr-reads-plain-')))
  try {
    const settings = new SettingsStore(myr)
    const projects = new ProjectStore(myr)
    const opened = projects.setPermissions(projects.add(folder).id, {
      mode: 'auto',
      allow: [],
      read: [outside],
    })
    const other = projects.add(plain)
    expect(opened.permissions?.read).toEqual([outside])
    expect(() =>
      projects.setPermissions(opened.id, { mode: 'auto', allow: [], read: [join(homedir(), '.ssh')] }),
    ).toThrow('Settings')
    expect(() =>
      projects.setPermissions(opened.id, { mode: 'auto', allow: [], read: [join(myr, 'colonies')] }),
    ).toThrow('Settings')
    expect(() => projects.setPermissions(opened.id, { mode: 'auto', allow: [], read: ['notes'] })).toThrow(
      'full path',
    )

    const inside = new ChatService(runtime, { resolver: models(readSpec()), settings, projects })
    const a = await inside.send('Read the spec', config, undefined, { project: opened.id })
    await waitFor(a.colonyId)
    expect((await results(a.colonyId))[0]?.output).toContain('the spec')
    await inside.stopAll()

    const elsewhere = new ChatService(runtime, { resolver: models(readSpec()), settings, projects })
    const b = await elsewhere.send('Read the spec', config, undefined, { project: other.id })
    await waitFor(b.colonyId)
    expect((await results(b.colonyId))[0]?.ok).toBe(false)
    await elsewhere.stopAll()
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
    await tearDownChats()
  }
})

test('an agent asks to read a folder; allowed for the chat it stays open across runs until the person removes it', async () => {
  await setUpChats()
  try {
    const settings = new SettingsStore(myr)
    const resolver = models([
      [tool('request_read', { path: outside, reason: 'the spec is there' })],
      [tool('fs_read', { path: join(outside, 'spec.md') })],
      [tool('reply_user', { text: 'Read it.', final: true })],
    ])
    const chats = new ChatService(runtime, { resolver, settings })
    const { chatId, colonyId } = await chats.send('Read the spec', config)
    const waiting = await waitFor(colonyId, (s) => Object.values(s.approvals).some((a) => !a.decided))
    const ask = Object.values(waiting.approvals).find((a) => !a.decided)
    expect(ask).toMatchObject({ tool: 'request_read', read: outside })
    expect(ask?.summary).toContain('the spec is there')
    expect(await chats.allowReadInChat(chatId, outside, true)).toEqual([outside])
    const done = await waitFor(colonyId)
    expect(done.chatReads).toEqual([outside])
    const [asked, read] = await results(colonyId)
    expect(asked?.ok).toBe(true)
    expect(read?.output).toContain('the spec')
    expect((await chats.list()).find((c) => c.chatId === chatId)?.reads).toEqual([outside])

    expect(await chats.allowReadInChat(chatId, outside, false)).toEqual([])
    // A key folder no agent asked for is never opened for a chat; other chats' data never.
    await expect(chats.allowReadInChat(chatId, '~/.ssh', true)).rejects.toThrow('keys or sign-ins')
    await expect(chats.allowReadInChat(chatId, join(myr, 'colonies'), true)).rejects.toThrow('Settings')
    await chats.stopAll()

    // The next run, once the person took the folder back.
    const later = new ChatService(runtime, { resolver: models(readSpec()), settings })
    const next = await later.send('Read it again', config, chatId)
    const fsReads = async () => (await results(next.colonyId)).filter((r) => r.tool === 'fs_read')
    for (let i = 0; i < 200 && (await fsReads()).length < 2; i++) await Bun.sleep(50)
    const again = (await fsReads()).at(-1)
    expect(again?.ok).toBe(false)
    expect(again?.output).toContain('request_read')
    await later.stopAll()
  } finally {
    await tearDownChats()
  }
})

test('a key folder opens for a chat only on the card of the request asking for exactly it', async () => {
  await setUpChats()
  try {
    const settings = new SettingsStore(myr)
    const resolver = models([
      [tool('request_read', { path: '~/.ssh', reason: 'to list the keys' })],
      [tool('reply_user', { text: 'Listed.', final: true })],
    ])
    const chats = new ChatService(runtime, { resolver, settings })
    const { chatId, colonyId } = await chats.send('List my keys', config)
    await waitFor(colonyId, (s) => Object.values(s.approvals).some((a) => !a.decided))
    const keys = realPath(join(homedir(), '.ssh'))
    // Not the folder asked for: refused, and the request keeps waiting.
    await expect(chats.allowReadInChat(chatId, '~/.aws', true)).rejects.toThrow('keys or sign-ins')
    expect(await chats.allowReadInChat(chatId, '~/.ssh', true)).toEqual([keys])
    const done = await waitFor(colonyId)
    expect(Object.values(done.approvals).map((a) => a.decided?.approved)).toEqual([true])
    // Answered, the request no longer opens it: taken back, it stays shut until an agent asks again.
    expect(await chats.allowReadInChat(chatId, '~/.ssh', false)).toEqual([])
    await expect(chats.allowReadInChat(chatId, '~/.ssh', true)).rejects.toThrow('keys or sign-ins')
    await chats.stopAll()
  } finally {
    await tearDownChats()
  }
})

test('allowed once, a folder stays open for that run only; a key folder asks with a warning', async () => {
  await setUpChats()
  try {
    const settings = new SettingsStore(myr)
    // Never reads a real key: only a file that does not exist, to tell "out of reach" from "not there".
    const resolver = models([
      [tool('request_read', { path: '~/.ssh', reason: 'to list the keys' })],
      [tool('fs_read', { path: `~/.ssh/${absent}` })],
      [tool('request_read', { path: outside })],
      [tool('fs_read', { path: join(outside, 'spec.md') })],
      [tool('reply_user', { text: 'Read it.', final: true })],
    ])
    const chats = new ChatService(runtime, { resolver, settings })
    const { colonyId } = await chats.send('Read the spec', config)
    const keys = await waitFor(colonyId, (s) => Object.values(s.approvals).some((a) => !a.decided))
    const ask = Object.values(keys.approvals).find((a) => !a.decided)
    expect(ask).toMatchObject({
      tool: 'request_read',
      read: realPath(join(homedir(), '.ssh')),
      sensitive: true,
    })
    await chats.decideApproval(colonyId, ask?.id ?? '', true)
    const plain = await waitFor(
      colonyId,
      (s) =>
        Object.values(s.approvals).filter((a) => !a.decided).length > 0 &&
        Object.keys(s.approvals).length === 2,
    )
    const second = Object.values(plain.approvals).find((a) => !a.decided)
    expect(second?.read).toBe(outside)
    expect(second?.sensitive).toBeUndefined()
    await chats.decideApproval(colonyId, second?.id ?? '', true)
    const done = await waitFor(colonyId)
    expect(done.chatReads).toBeUndefined()
    const [allowedKeys, inKeys, asked, read] = await results(colonyId)
    expect(allowedKeys?.ok).toBe(true)
    expect(allowedKeys?.output).toContain('Never print private key contents')
    // Opened: the file is simply not there, rather than out of reach.
    expect(inKeys?.ok).toBe(false)
    expect(inKeys?.output).toContain('ENOENT')
    expect(asked?.ok).toBe(true)
    expect(read?.output).toContain('the spec')
    await chats.stopAll()
  } finally {
    await tearDownChats()
  }
})

test('a grant of the whole home keeps keys hidden, and asking for them still asks', async () => {
  await setUpChats()
  try {
    const settings = new SettingsStore(myr)
    const resolver = models([
      [tool('request_read', { path: '~', reason: 'to look around' })],
      [tool('fs_read', { path: `~/.ssh/${absent}` })],
      [tool('request_read', { path: '~/.ssh' })],
      [tool('reply_user', { text: 'Could not.', final: true })],
    ])
    const chats = new ChatService(runtime, { resolver, settings })
    const { chatId, colonyId } = await chats.send('Look around', config)
    await waitFor(colonyId, (s) => Object.values(s.approvals).some((a) => !a.decided))
    expect(await chats.allowReadInChat(chatId, '~', true)).toEqual([realPath(homedir())])
    const waiting = await waitFor(
      colonyId,
      (s) =>
        Object.values(s.approvals).filter((a) => !a.decided).length > 0 &&
        Object.keys(s.approvals).length === 2,
    )
    // The home allowed for the chat does not answer a request for the keys inside it.
    const keys = Object.values(waiting.approvals).find((a) => !a.decided)
    expect(keys).toMatchObject({ read: realPath(join(homedir(), '.ssh')), sensitive: true })
    await chats.decideApproval(colonyId, keys?.id ?? '', false)
    await waitFor(colonyId)
    const [, hidden, denied] = await results(colonyId)
    expect(hidden?.ok).toBe(false)
    expect(hidden?.output).toContain('outside your')
    expect(denied?.ok).toBe(false)
    await chats.stopAll()
  } finally {
    await tearDownChats()
  }
})

test("a channel member's round refuses key folders outright, without asking", async () => {
  await setUpChats()
  try {
    const settings = new SettingsStore(myr)
    const resolver = models([
      [tool('request_read', { path: '~/.ssh' })],
      [tool('reply_user', { text: 'Could not.', final: true })],
    ])
    const chats = new ChatService(runtime, { resolver, settings })
    const { colonyId } = await chats.send('List the keys', config, undefined, { askAll: true })
    const done = await waitFor(colonyId)
    expect(Object.keys(done.approvals)).toEqual([])
    const [refused] = await results(colonyId)
    expect(refused?.ok).toBe(false)
    expect(refused?.output).toContain('someone other than the person')
    await chats.stopAll()
  } finally {
    await tearDownChats()
  }
})

test('a grant opens exactly the key folder it names; a broader one never opens keys inside it', () => {
  const ssh = join(home, '.ssh')
  expect(grantCovers(ssh, join(ssh, 'id_ed25519.pub'), home)).toBe(true)
  expect(grantCovers(home, join(ssh, 'id_ed25519'), home)).toBe(false)
  expect(grantCovers(home, join(home, 'notes', 'todo.md'), home)).toBe(true)
  expect(grantCovers(join(home, '.aws'), join(ssh, 'id_ed25519'), home)).toBe(false)
  expect(keysAt(join(ssh, 'config'), home)).toBe(ssh)
  expect(keysAt(join(home, 'notes'), home)).toBeUndefined()
  const ws = new ColonyWorkspace(colony, project, () => false, { dataDir: data, home, reads: () => [ssh] })
  expect(ws.mayRead('lead', join(ssh, 'id_ed25519'))).toBe(true)
  expect(ws.mayRead('lead', join(home, '.zshrc'))).toBe(false)
})
