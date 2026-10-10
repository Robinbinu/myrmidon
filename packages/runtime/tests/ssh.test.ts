import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decide,
  offersFor,
  type PermissionCall,
  type PermissionLevels,
  type PermissionRule,
  toolHidden,
} from '@myrmidon/protocol'
import { bunShim } from '../../../tests/platform.ts'
import type { ColonyHost } from '../src/host.ts'
import { toolsFor } from '../src/patterns.ts'
import { SettingsStore } from '../src/settings.ts'
import type { ColonySpec } from '../src/spec.ts'
import { parseSshConfig, readSshConfig, type SshHost, SshHub } from '../src/ssh.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let dir: string
let fakeSsh: string
let calls: string

/**
 * A stand-in for OpenSSH: it logs its arguments, answers the control-socket check and start, and runs the remote
 * command (its last argument) with sh on this machine, as the remote's login shell would.
 */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-ssh-'))
  calls = join(dir, 'calls.log')
  const script = join(dir, 'fake-ssh.ts')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n')
if (args.includes('-O') || args.includes('-M')) process.exit(0)
const r = Bun.spawnSync(['sh', '-c', args.at(-1) ?? ''], { stdout: 'inherit', stderr: 'inherit' })
process.exit(r.exitCode ?? 1)
`,
  )
  fakeSsh = bunShim(join(dir, 'ssh'), script)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const box: SshHost = { name: 'box', host: 'build.example.com', user: 'deploy', port: 2222 }

test('~/.ssh/config: aliases with what each block says, patterns and Match blocks left out, includes read', () => {
  const hosts = parseSshConfig(
    [
      '# my hosts',
      'Host build prod-*',
      '  HostName 10.0.0.5',
      '  User deploy',
      '  Port 2200',
      'Host *',
      '  User nobody',
      'Match host x',
      '  User ignored',
      'Host pi',
      '  HostName=pi.local # trailing comment',
      'Include config.d/*',
    ].join('\n'),
    (pattern) => (pattern === 'config.d/*' ? ['Host extra\n  HostName extra.example.com'] : []),
  )
  expect(hosts).toEqual([
    { name: 'build', hostName: '10.0.0.5', user: 'deploy', port: 2200 },
    { name: 'pi', hostName: 'pi.local' },
    { name: 'extra', hostName: 'extra.example.com' },
  ])
  // A home with no ssh config has no hosts to offer.
  expect(readSshConfig(dir)).toEqual([])
  mkdirSync(join(dir, '.ssh', 'more'), { recursive: true })
  writeFileSync(join(dir, '.ssh', 'config'), 'Host gpu\n  HostName gpu.lan\nInclude more/*.conf\n')
  writeFileSync(join(dir, '.ssh', 'more', 'a.conf'), 'Host nas\n  User admin\n')
  expect(readSshConfig(dir)).toEqual([
    { name: 'gpu', hostName: 'gpu.lan' },
    { name: 'nas', user: 'admin' },
  ])
})

describe('through ssh', () => {
  test('a command runs through ssh with BatchMode and the host, user and port, never a key of its own', async () => {
    const hub = new SshHub({ controlDir: join(dir, 'control'), binary: fakeSsh })
    expect(hub.available()).toBe(true)
    const r = await hub.run(box, 'echo hello; echo oops >&2; exit 3', 5_000)
    expect(r).toEqual({ code: 3, stdout: 'hello\n', stderr: 'oops\n', timedOut: false })
    const lines = readFileSync(calls, 'utf8').trim().split('\n')
    const run = lines.at(-1) ?? ''
    expect(run).toContain('-o BatchMode=yes')
    expect(run).toContain('-o StrictHostKeyChecking=accept-new')
    expect(run).toContain('-p 2222 deploy@build.example.com echo hello')
    expect(run).not.toContain(' -i ')
    // One shared connection per host where OpenSSH has them: checked, then started, before the first command.
    if (process.platform !== 'win32') {
      expect(lines.some((l) => l.startsWith('-O check'))).toBe(true)
      expect(run).toContain('ControlMaster=auto')
    } else expect(run).not.toContain('ControlMaster')
    // A command past its time is stopped and says so.
    const slow = await hub.run(box, 'sleep 5', 300)
    expect(slow.timedOut).toBe(true)
  })

  test('a file is read with head, cut at the limit, and a missing one fails with its error', async () => {
    const hub = new SshHub({ controlDir: join(dir, 'control'), binary: fakeSsh })
    const file = join(dir, 'remote.txt')
    writeFileSync(file, 'abcdefghij')
    expect(await hub.read(box, file, 100, 5_000)).toEqual({ text: 'abcdefghij', truncated: false })
    expect(await hub.read(box, file, 4, 5_000)).toEqual({ text: 'abcd', truncated: true })
    await expect(hub.read(box, join(dir, 'nope.txt'), 100, 5_000)).rejects.toThrow('nope.txt')
    expect(await hub.test(box)).toEqual({ ok: true })
  })

  test('a host or user that ssh would read as an option is refused before ssh runs', async () => {
    const hub = new SshHub({ controlDir: join(dir, 'control'), binary: fakeSsh })
    await expect(
      hub.run({ name: 'evil', host: '-oProxyCommand=touch /tmp/x' }, 'true', 1_000),
    ).rejects.toThrow('argument-injection guard')
    await expect(hub.run({ name: 'evil', host: 'ok', user: '-oX' }, 'true', 1_000)).rejects.toThrow(
      'argument-injection guard',
    )
  })

  test('the ssh tool: each call is decided by the host’s rules, asks by default, and never reaches an unlisted host', async () => {
    const ssh = TOOL_DEFS.find((d) => d.name === 'ssh')
    if (!ssh) throw new Error('no ssh tool')
    const hub = new SshHub({ controlDir: join(dir, 'control'), binary: fakeSsh })
    const reviewed: string[] = []
    const fake = (levels: PermissionLevels, approve = true, askAll = false) =>
      ({
        remotes: () => (askAll ? undefined : { hub, hosts: [box] }),
        permit: (_agent: string, call: PermissionCall) => decide(levels, call, askAll ? { askAll } : {}),
        reviewChange: async (_agent: string, _tool: string, summary: string) => {
          reviewed.push(summary)
          return { approved: approve, ...(approve ? {} : { note: 'not now' }) }
        },
      }) as unknown as ColonyHost
    const rule = (decision: PermissionRule['decision'], target = 'box'): PermissionLevels => ({
      global: { preset: 'auto', rules: [{ kind: 'ssh-host', target, decision }] },
    })
    // Allowed for this host: it runs without asking.
    expect(await ssh.run({ host: 'box', command: 'echo hi' }, 'kai', fake(rule('allow')))).toContain(
      'box: exit 0\n--- stdout\nhi',
    )
    expect(reviewed).toEqual([])
    // No rule: the Auto preset asks before a command on another computer, and the person's answer stands.
    expect(
      await ssh.run(
        { host: 'box', command: 'uname' },
        'kai',
        fake({ global: { preset: 'auto', rules: [] } }),
      ),
    ).toContain('exit 0')
    expect(reviewed).toEqual(['box: uname'])
    await expect(
      ssh.run(
        { host: 'box', command: 'reboot' },
        'kai',
        fake({ global: { preset: 'auto', rules: [] } }, false),
      ),
    ).rejects.toThrow('did not approve reboot on box')
    // Full access runs it unasked; a deny for every host refuses it, reads included.
    reviewed.length = 0
    expect(
      await ssh.run({ host: 'box', command: 'true' }, 'kai', fake({ global: { preset: 'full', rules: [] } })),
    ).toContain('exit 0')
    expect(reviewed).toEqual([])
    await expect(
      ssh.run({ host: 'box', read: '/etc/hosts' }, 'kai', fake(rule('deny', '*'))),
    ).rejects.toThrow('not permitted')
    // Only the person's hosts, one thing at a time, and none in a round someone else started.
    await expect(ssh.run({ host: 'other', command: 'true' }, 'kai', fake(rule('allow')))).rejects.toThrow(
      'not one of the person',
    )
    await expect(ssh.run({ host: 'box' }, 'kai', fake(rule('allow')))).rejects.toThrow(
      'either command or read',
    )
    await expect(
      ssh.run({ host: 'box', command: 'true' }, 'kai', fake(rule('allow'), true, true)),
    ).rejects.toThrow('no remote hosts')
  })
})

test('permissions: hosts are rule targets like MCP servers, offered on the card and hidden by a deny for all', () => {
  const call: PermissionCall = {
    tool: 'ssh',
    kind: 'ssh',
    ssh: { host: 'box' },
    command: 'ls',
    readOnly: false,
  }
  expect(offersFor(call)).toEqual([{ kind: 'ssh-host', target: 'box' }])
  const levels = (
    rules: PermissionRule[],
    preset: 'auto' | 'full' | 'read-only' = 'auto',
  ): PermissionLevels => ({
    global: { preset, rules },
  })
  expect(decide(levels([]), call).decision).toBe('ask')
  expect(decide(levels([], 'full'), call).decision).toBe('allow')
  expect(decide(levels([{ kind: 'ssh-host', target: 'box', decision: 'allow' }]), call).decision).toBe(
    'allow',
  )
  expect(decide(levels([{ kind: 'ssh-host', target: 'other', decision: 'allow' }]), call).decision).toBe(
    'ask',
  )
  // A channel member's round asks whatever the rules allow.
  expect(
    decide(levels([{ kind: 'ssh-host', target: '*', decision: 'allow' }]), call, { askAll: true }).decision,
  ).toBe('ask')
  // Command rules are about this computer's commands, not another's.
  expect(decide(levels([{ kind: 'command', target: '*', decision: 'allow' }]), call).decision).toBe('ask')
  expect(toolHidden(levels([{ kind: 'ssh-host', target: '*', decision: 'deny' }]), 'ssh')).toBe(true)
  expect(toolHidden(levels([{ kind: 'ssh-host', target: 'box', decision: 'deny' }]), 'ssh')).toBe(false)
})

test('the ssh tool reaches agents only in a round of the person’s with hosts set up, unless remote hosts are off', () => {
  const spec = (extra: Partial<ColonySpec>): ColonySpec => ({
    name: 'chat',
    mission: 'm',
    pattern: 'lead-workers',
    agents: [{ name: 'lead', role: 'lead', model: 'mock/lead' }],
    acceptance: [],
    budget: { wallMs: 60_000, maxTurns: 10 },
    observer: { intervalMs: 30_000 },
    chat: { chatId: 'c', round: 1, request: 'check the logs on box', history: '' },
    tier: 'solo',
    ...extra,
  })
  const agent = { name: 'lead', role: 'lead', model: 'mock/lead' }
  expect(toolsFor(spec({}), agent)).not.toContain('ssh')
  expect(toolsFor(spec({ remotes: [box] }), agent)).toContain('ssh')
  expect(toolsFor(spec({ remotes: [box], askAll: true }), agent)).not.toContain('ssh')
  const off = { global: { preset: 'auto' as const, rules: [], access: { crew: { remote: false } } } }
  expect(toolsFor(spec({ remotes: [box], permissions: off }), agent)).not.toContain('ssh')
})

test('settings keep hosts by name, with only where to connect, and refuse an option for a host', () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-ssh-settings-'))
  try {
    const store = new SettingsStore(home)
    expect(store.get().ssh).toEqual({ hosts: [] })
    const saved = store.set({
      ...store.get(),
      ssh: {
        hosts: [
          { name: 'box', host: 'build.example.com', user: 'deploy', port: 2222 },
          { name: 'pi', host: 'pi', keyPath: '/Users/me/.ssh/id_ed25519' },
          { name: 'box', host: 'again.example.com' },
        ],
      },
    })
    expect(saved.ssh.hosts).toEqual([
      { name: 'box', host: 'again.example.com' },
      { name: 'pi', host: 'pi' },
    ])
    expect(() =>
      store.set({ ...store.get(), ssh: { hosts: [{ name: 'x', host: '-oProxyCommand=sh' }] } }),
    ).toThrow()
    expect(() => store.set({ ...store.get(), ssh: { hosts: [{ name: 'a b', host: 'h' }] } })).toThrow()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
