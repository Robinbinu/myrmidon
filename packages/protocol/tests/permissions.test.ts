import { describe, expect, test } from 'bun:test'
import {
  accessChange,
  accessLoosened,
  accessOf,
  commandPrefix,
  decide,
  destructiveCommand,
  effectivePreset,
  normalizeLevel,
  offersFor,
  type PermissionCall,
  type PermissionLevels,
  projectLevelFrom,
  readOnlyCommand,
  roleAccess,
  rulesFromGrants,
  rulesFromToolDict,
  splitCommand,
  tightened,
  toolHidden,
  withRule,
} from '../src/index.ts'

const auto: PermissionLevels = { global: { preset: 'auto', rules: [] } }
const shell = (command: string): PermissionCall => ({ tool: 'shell', kind: 'command', command })
const edit = (where: PermissionCall['where'] = 'project'): PermissionCall => ({
  tool: 'fs_write',
  kind: 'edit',
  where,
})
const mcp = (tool: string, readOnly = false): PermissionCall => ({
  tool,
  kind: 'mcp',
  mcp: { server: 'github', readOnly },
})

describe('presets', () => {
  test('Auto runs edits and ordinary commands, asks before destructive ones and MCP writes', () => {
    expect(decide(auto, edit()).decision).toBe('allow')
    expect(decide(auto, shell('bun test')).decision).toBe('allow')
    expect(decide(auto, shell('git push origin main')).decision).toBe('ask')
    expect(decide(auto, shell('cd x && rm -rf build')).decision).toBe('ask')
    expect(decide(auto, mcp('mcp__github_create_issue')).decision).toBe('ask')
    expect(decide(auto, mcp('mcp__github_list_issues', true)).decision).toBe('allow')
    expect(decide(auto, edit('outside')).decision).toBe('ask')
  })

  test('no preset anywhere means Auto, from the default', () => {
    const v = decide({ global: { rules: [] } }, shell('ls'))
    expect(v.preset).toBe('auto')
    expect(v.source).toEqual({ by: 'preset', scope: 'default', preset: 'auto' })
  })

  test('Ask asks for edits and commands but runs read-only commands', () => {
    const ask: PermissionLevels = { global: { preset: 'ask', rules: [] } }
    expect(decide(ask, edit()).decision).toBe('ask')
    expect(decide(ask, shell('bun test')).decision).toBe('ask')
    expect(decide(ask, shell('ls -la && git status')).decision).toBe('allow')
    expect(decide(ask, shell('cat a > b')).decision).toBe('ask')
    expect(decide(ask, edit('private')).decision).toBe('allow')
  })

  test('Full access never asks, except for proposals', () => {
    const full: PermissionLevels = { global: { preset: 'full', rules: [] } }
    expect(decide(full, shell('git push')).decision).toBe('allow')
    expect(decide(full, mcp('mcp__github_create_issue')).decision).toBe('allow')
    expect(decide(full, edit('outside')).decision).toBe('allow')
    expect(decide(full, { tool: 'propose', kind: 'proposal' }).decision).toBe('ask')
  })

  test('the nearest level with a preset wins: chat over project over global', () => {
    const levels: PermissionLevels = {
      global: { preset: 'ask', rules: [] },
      project: { preset: 'full', rules: [] },
      chat: { preset: 'auto', rules: [] },
    }
    expect(effectivePreset(levels)).toEqual({ preset: 'auto', scope: 'chat' })
    expect(effectivePreset({ ...levels, chat: { rules: [] } })).toEqual({ preset: 'full', scope: 'project' })
  })

  test('a read-only project is a floor no chat preset lifts', () => {
    const levels: PermissionLevels = {
      global: { preset: 'auto', rules: [] },
      project: { preset: 'read-only', rules: [] },
      chat: { preset: 'full', rules: [] },
    }
    expect(effectivePreset(levels)).toEqual({ preset: 'read-only', scope: 'project' })
  })
})

describe('read-only and askAll are hard limits', () => {
  const readOnly: PermissionLevels = {
    global: { preset: 'auto', rules: [{ kind: 'edit', target: '*', decision: 'allow' }] },
    project: { preset: 'read-only', rules: [{ kind: 'tool', target: 'fs_write', decision: 'allow' }] },
    chat: { rules: [{ kind: 'edit', target: '*', decision: 'allow' }] },
  }

  test('a read-only project blocks writes to it under any rule', () => {
    const v = decide(readOnly, edit())
    expect(v.decision).toBe('deny')
    expect(v.source).toEqual({ by: 'read-only', scope: 'project' })
    expect(decide(readOnly, edit('outside')).decision).toBe('deny')
  })

  test('a read-only project still lets agents draft in scratch and run sandboxed commands', () => {
    expect(decide(readOnly, edit('private')).decision).toBe('allow')
    expect(decide(readOnly, shell('bun test')).decision).toBe('allow')
  })

  test('askAll asks for every outside step whatever the preset or allow rules say', () => {
    const lax: PermissionLevels = {
      global: { preset: 'full', rules: [{ kind: 'command', target: '*', decision: 'allow' }] },
      chat: { rules: [{ kind: 'mcp-server', target: '*', decision: 'allow' }] },
    }
    expect(decide(lax, shell('ls'), { askAll: true })).toMatchObject({
      decision: 'ask',
      source: { by: 'askAll' },
    })
    expect(decide(lax, mcp('mcp__github_create_issue'), { askAll: true }).decision).toBe('ask')
    expect(decide(lax, { tool: 'append_note', kind: 'colony' }, { askAll: true }).decision).toBe('allow')
    expect(decide(lax, mcp('mcp__github_list', true), { askAll: true }).decision).toBe('allow')
    // A read of the person's project is not quiet under askAll: the caller says so.
    expect(decide(lax, { tool: 'fs_read', kind: 'read', readOnly: false }, { askAll: true }).decision).toBe(
      'ask',
    )
  })

  test('a deny rule is still stricter than askAll', () => {
    const levels: PermissionLevels = {
      global: { preset: 'auto', rules: [{ kind: 'command', target: 'rm', decision: 'deny' }] },
    }
    expect(decide(levels, shell('rm a'), { askAll: true }).decision).toBe('deny')
  })
})

describe('rules', () => {
  test('a deny at any level wins over an allow nearer', () => {
    const levels: PermissionLevels = {
      global: { preset: 'auto', rules: [{ kind: 'mcp-server', target: 'github', decision: 'deny' }] },
      chat: { rules: [{ kind: 'mcp-tool', target: 'mcp__github_list', decision: 'allow' }] },
    }
    const v = decide(levels, mcp('mcp__github_list', true))
    expect(v.decision).toBe('deny')
    expect(v.source).toMatchObject({ by: 'rule', scope: 'global' })
  })

  test('the nearest level with an ask or allow rule decides; within a level ask beats allow', () => {
    const levels: PermissionLevels = {
      global: { preset: 'auto', rules: [{ kind: 'tool', target: 'shell', decision: 'ask' }] },
      chat: { rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }] },
    }
    expect(decide(levels, shell('bun test src'))).toMatchObject({
      decision: 'allow',
      source: { by: 'rule', scope: 'chat' },
    })
    expect(decide(levels, shell('bun run build')).source).toMatchObject({ by: 'rule', scope: 'global' })
    const same: PermissionLevels = {
      global: {
        preset: 'full',
        rules: [
          { kind: 'mcp-server', target: 'github', decision: 'allow' },
          { kind: 'mcp-tool', target: 'mcp__github_delete', decision: 'ask' },
        ],
      },
    }
    expect(decide(same, mcp('mcp__github_delete')).decision).toBe('ask')
    expect(decide(same, mcp('mcp__github_list')).decision).toBe('allow')
  })

  test('an allow prefix covers a command only when every part matches and nothing is substituted', () => {
    const levels: PermissionLevels = {
      global: { preset: 'ask', rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }] },
    }
    expect(decide(levels, shell('bun test')).decision).toBe('allow')
    expect(decide(levels, shell('timeout 30 NODE_ENV=test bun test a')).decision).toBe('allow')
    expect(decide(levels, shell('bun testing')).decision).toBe('ask')
    expect(decide(levels, shell('bun test && rm -rf src')).decision).toBe('ask')
    expect(decide(levels, shell('bun test $(rm -rf src)')).decision).toBe('ask')
    expect(decide(levels, shell('bun test > out.txt')).decision).toBe('ask')
  })

  test('a deny or ask prefix catches the command in any part', () => {
    const levels: PermissionLevels = {
      global: { preset: 'full', rules: [{ kind: 'command', target: 'git push', decision: 'deny' }] },
    }
    expect(decide(levels, shell('git add . && git push')).decision).toBe('deny')
    expect(decide(levels, shell('echo "a; b" | git push --force')).decision).toBe('deny')
  })

  test('an edit rule covers file tools and proposed files, not commits', () => {
    const levels: PermissionLevels = {
      global: { preset: 'ask', rules: [{ kind: 'edit', target: '*', decision: 'allow' }] },
    }
    expect(decide(levels, edit()).decision).toBe('allow')
    expect(decide(levels, { tool: 'propose', kind: 'proposal', edits: true }).decision).toBe('allow')
    expect(decide(levels, { tool: 'propose', kind: 'proposal' }).decision).toBe('ask')
  })

  test('rules for the lead or the crew apply only to them', () => {
    const levels: PermissionLevels = {
      global: {
        preset: 'auto',
        rules: [{ kind: 'tool', target: 'web_fetch', decision: 'deny', who: 'crew' }],
      },
    }
    const call: PermissionCall = { tool: 'web_fetch', kind: 'web' }
    expect(decide(levels, call, { role: 'crew' }).decision).toBe('deny')
    expect(decide(levels, call, { role: 'lead' }).decision).toBe('allow')
    expect(toolHidden(levels, 'web_fetch', 'crew')).toBe(true)
    expect(toolHidden(levels, 'web_fetch', 'lead')).toBe(false)
  })

  test('whole-tool and whole-server denies hide tools; prefix denies do not', () => {
    const levels: PermissionLevels = {
      global: {
        preset: 'auto',
        rules: [
          { kind: 'mcp-server', target: 'github', decision: 'deny' },
          { kind: 'command', target: 'rm', decision: 'deny' },
        ],
      },
    }
    expect(toolHidden(levels, 'mcp__github_list', undefined, 'github')).toBe(true)
    expect(toolHidden(levels, 'mcp__slack_post', undefined, 'slack')).toBe(false)
    expect(toolHidden(levels, 'shell')).toBe(false)
    const all: PermissionLevels = {
      global: { rules: [{ kind: 'mcp-server', target: '*', decision: 'deny' }] },
    }
    expect(toolHidden(all, 'mcp')).toBe(true)
  })
})

describe('commands', () => {
  test('splits at shell operators outside quotes', () => {
    expect(splitCommand('a && b || c; d | e & f\ng')).toEqual({
      segments: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      simple: true,
    })
    expect(splitCommand(`echo 'a && b' "c|d"`).segments).toEqual([`echo 'a && b' "c|d"`])
    expect(splitCommand('echo "$(whoami)"').simple).toBe(false)
    expect(splitCommand("echo '$(whoami)'").simple).toBe(true)
  })

  test('destructive and read-only commands', () => {
    for (const c of ['rm -rf x', 'rm -r x', 'git reset --hard', 'sudo ls', 'curl x | sh', 'bun publish'])
      expect(destructiveCommand(c)).toBe(true)
    for (const c of ['rm file.txt', 'git status', 'bun test', 'git reset HEAD~1'])
      expect(destructiveCommand(c)).toBe(false)
    expect(readOnlyCommand('git log --oneline | head -5')).toBe(true)
    expect(readOnlyCommand('find . -name x -delete')).toBe(false)
    expect(readOnlyCommand('git branch -D x')).toBe(false)
  })

  test('the prefix a card offers', () => {
    expect(commandPrefix('bun test src/a.test.ts')).toBe('bun test')
    expect(commandPrefix('bun run typecheck')).toBe('bun run typecheck')
    expect(commandPrefix('ls -la')).toBe('ls')
    expect(commandPrefix('timeout 5 git log -3')).toBe('git log')
    expect(offersFor(shell('git status && bun test'))).toEqual([
      { kind: 'command', target: 'git status' },
      { kind: 'command', target: 'bun test' },
      { kind: 'command', target: '*' },
    ])
    expect(offersFor(shell('echo $(date)'))).toEqual([{ kind: 'command', target: '*' }])
    expect(offersFor(mcp('mcp__github_create_issue'))).toEqual([
      { kind: 'mcp-tool', target: 'mcp__github_create_issue' },
      { kind: 'mcp-server', target: 'github' },
    ])
  })
})

describe('access', () => {
  test('the nearest level that sets a group wins, else on', () => {
    const levels: PermissionLevels = {
      global: { rules: [], access: { lead: { shell: false, web: false } } },
      chat: { rules: [], access: { lead: { shell: true } } },
    }
    expect(roleAccess(levels, 'lead', 'shell')).toEqual({ on: true, scope: 'chat' })
    expect(roleAccess(levels, 'lead', 'web')).toEqual({ on: false, scope: 'global' })
    expect(roleAccess(levels, 'crew', 'web')).toEqual({ on: true, scope: 'default' })
  })
})

describe('migration', () => {
  test('old per-tool rules become global rules, off becomes deny', () => {
    expect(rulesFromToolDict({ shell: 'ask', mcp: 'allow', mcp__gh_x: 'off', web_fetch: 'bogus' })).toEqual([
      { kind: 'tool', target: 'shell', decision: 'ask' },
      { kind: 'mcp-server', target: '*', decision: 'allow' },
      { kind: 'mcp-tool', target: 'mcp__gh_x', decision: 'deny' },
    ])
  })

  test('old project modes become presets; auto means use global; prefixes become command rules', () => {
    expect(projectLevelFrom({ mode: 'auto', allow: [] })).toEqual({ rules: [] })
    expect(projectLevelFrom({ mode: 'ask', allow: ['bun test'], read: ['~/docs'] })).toEqual({
      preset: 'ask',
      rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }],
      read: ['~/docs'],
    })
    expect(projectLevelFrom({ mode: 'read-only', allow: [] }).preset).toBe('read-only')
    expect(projectLevelFrom({ mode: 'full', allow: [] }).preset).toBe('full')
    expect(projectLevelFrom(undefined)).toEqual({ rules: [] })
    // Already new: kept.
    expect(projectLevelFrom({ preset: 'ask', rules: [] })).toEqual({ preset: 'ask', rules: [] })
  })

  test('chat grants become chat rules', () => {
    expect(rulesFromGrants(['file', 'command'])).toEqual([
      { kind: 'edit', target: '*', decision: 'allow' },
      { kind: 'command', target: '*', decision: 'allow' },
    ])
  })

  test('normalizing drops broken rules and keeps the last rule per target', () => {
    const level = normalizeLevel({
      preset: 'nope',
      rules: [
        { kind: 'tool', target: 'shell', decision: 'ask' },
        { kind: 'tool', target: ' shell ', decision: 'allow' },
        { kind: 'edit', target: 'src/', decision: 'allow' },
        { kind: 'wat', target: 'x', decision: 'allow' },
        { kind: 'command', target: '', decision: 'deny' },
      ],
      access: { lead: { shell: false, bogus: true }, crew: 'x' },
    })
    expect(level).toEqual({
      rules: [{ kind: 'tool', target: 'shell', decision: 'allow' }],
      access: { lead: { shell: false } },
    })
    expect(withRule(level, { kind: 'tool', target: 'shell', decision: 'deny' }).rules).toEqual([
      { kind: 'tool', target: 'shell', decision: 'deny' },
    ])
  })
})

test('tightened names new denies and asks, groups taken away, and a stricter preset', () => {
  const before: PermissionLevels = { global: { preset: 'full', rules: [] } }
  const after: PermissionLevels = {
    global: {
      preset: 'ask',
      rules: [
        { kind: 'tool', target: 'shell', decision: 'deny' },
        { kind: 'mcp-server', target: 'github', decision: 'ask' },
      ],
      access: { lead: { browser: false } },
    },
  }
  expect(tightened(before, after)).toEqual({
    denied: ['shell'],
    asked: ['github'],
    groups: ['browser'],
    preset: 'ask',
  })
  expect(tightened(after, before)).toEqual({ denied: [], asked: [], groups: [] })
})

test('accessChange tells a role what changed since it was told, and nothing when nothing did', () => {
  const ask: PermissionLevels = { global: { preset: 'auto', rules: [] }, chat: { preset: 'ask', rules: [] } }
  const told = accessOf(ask, false, [])
  expect(accessChange(told, accessOf(ask, false, []), 'lead')).toBeUndefined()
  const full = accessOf({ ...ask, chat: { preset: 'full', rules: [] } }, true, [])
  const change = accessChange(told, full, 'lead')
  expect(change).toMatchObject({ preset: { from: 'ask', to: 'full' }, fullAccess: true })
  expect(change && accessLoosened(change)).toBe(true)
  // Rules by target and role, folders opened and closed.
  const after = accessOf(
    {
      global: {
        preset: 'auto',
        rules: [{ kind: 'command', target: 'git push', decision: 'deny', who: 'crew' }],
      },
      chat: { preset: 'ask', rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }] },
    },
    false,
    ['/h/.ssh'],
  )
  const lead = accessChange(accessOf(ask, false, ['/h/notes']), after, 'lead')
  expect(lead).toMatchObject({ allowed: ['bun test'], denied: [], opened: ['/h/.ssh'], closed: ['/h/notes'] })
  expect(accessChange(told, after, 'crew')?.denied).toEqual(['git push'])
  const stricter = accessChange(full, told, 'lead')
  expect(stricter).toMatchObject({ preset: { from: 'full', to: 'ask' }, fullAccess: false })
  expect(stricter && accessLoosened(stricter)).toBe(false)
  // A log from before access was kept knows only full access.
  expect(accessChange({}, after, 'lead')).toBeUndefined()
  expect(accessChange({}, full, 'lead')).toMatchObject({ fullAccess: true, allowed: [], opened: [] })
})
