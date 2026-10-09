import { expect, test } from 'bun:test'
import type { PermissionLevels } from '@myrmidon/protocol'
import { type ColonySpec, parseColonySpec, toolsFor } from '../src/index.ts'

const chat = { chatId: 'chat-a', round: 1, request: 'build it', history: '' }

/** A chat round led by `lead` with one worker, under these permission levels. */
function team(permissions?: PermissionLevels): ColonySpec {
  const base = parseColonySpec({
    name: 'T',
    mission: 'm',
    pattern: 'lead-workers',
    agents: [
      { name: 'lead', role: 'lead', model: 'x/y' },
      { name: 'nova', role: 'worker', model: 'x/y' },
    ],
  })
  return {
    ...base,
    chat,
    tier: 'team',
    team: { mode: 'orchestrated', maxWorkers: 1, workerModels: ['x/y'] },
    ...(permissions ? { permissions } : {}),
  }
}

const lead = (spec: ColonySpec) => toolsFor(spec, spec.agents[0] as never)
const worker = (spec: ColonySpec) => toolsFor(spec, spec.agents[1] as never)

test("a team's lead gets the crew's build tools by default, beside its planning tools", () => {
  const tools = lead(team({ global: { preset: 'auto', rules: [] } }))
  for (const t of ['shell', 'fs_write', 'web_search', 'browser_open', 'mcp', 'assign_task', 'create_task'])
    expect(tools).toContain(t)
})

test('turning groups off for the lead restores the delegating lead, at any level, nearest wins', () => {
  const off = { files: false, shell: false, web: false, browser: false, mcp: false, computer: false }
  const delegating = lead(team({ global: { preset: 'auto', rules: [], access: { lead: off } } }))
  for (const t of ['shell', 'fs_write', 'fs_read', 'web_search', 'browser_open', 'mcp', 'computer'])
    expect(delegating).not.toContain(t)
  expect(delegating).toContain('assign_task')
  // The crew keeps them: the lead column is the lead's alone.
  expect(worker(team({ global: { preset: 'auto', rules: [], access: { lead: off } } }))).toContain('shell')
  // A chat gives the lead its shell back.
  const chatOn = lead(
    team({
      global: { preset: 'auto', rules: [], access: { lead: off } },
      chat: { rules: [], access: { lead: { shell: true } } },
    }),
  )
  expect(chatOn).toContain('shell')
  expect(chatOn).not.toContain('fs_write')
})

test("a group off for the crew leaves workers without it, and an agent working alone follows the crew's column", () => {
  const levels: PermissionLevels = {
    global: { preset: 'auto', rules: [], access: { crew: { web: false }, lead: { shell: false } } },
  }
  expect(worker(team(levels))).not.toContain('web_search')
  const solo = { ...team(levels), tier: 'solo' as const, agents: [team().agents[0] as never] }
  const alone = toolsFor(solo, solo.agents[0] as never)
  // Alone, the lead has nobody to hand work to: the lead column (shell off) does not apply, the crew's does.
  expect(alone).toContain('shell')
  expect(alone).not.toContain('web_search')
})

test('a tool denied outright is left out of the agents it applies to', () => {
  const levels: PermissionLevels = {
    global: {
      preset: 'auto',
      rules: [
        { kind: 'tool', target: 'web_fetch', decision: 'deny', who: 'crew' },
        { kind: 'mcp-server', target: '*', decision: 'deny', who: 'lead' },
        { kind: 'command', target: 'rm', decision: 'deny' },
      ],
    },
  }
  expect(worker(team(levels))).not.toContain('web_fetch')
  expect(lead(team(levels))).toContain('web_fetch')
  expect(lead(team(levels))).not.toContain('mcp')
  expect(worker(team(levels))).toContain('mcp')
  // A command prefix denies calls, not the tool.
  expect(worker(team(levels))).toContain('shell')
})
