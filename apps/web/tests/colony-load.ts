import type { MyrEvent } from '@myrmidon/protocol'

/** A small seeded generator, so a failing history can be made again from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x1_0000_0000
  }
}

const AGENTS = ['lead', 'ada', 'grace', 'linus']
const TOOLS = ['fs_read', 'fs_edit', 'shell', 'web_search', 'list_tasks', 'read_task']
const START = Date.parse('2026-10-15T09:00:00Z')

/**
 * A colony's log as a long chat makes it: rounds of work with replies, tool calls, mail, board posts, tasks, files,
 * reviews and the events that change earlier entries (deliveries, group changes, decisions). `seed` picks the mix.
 */
export function colonyLog(count: number, seed = 1, colonyId = 'c-load'): MyrEvent[] {
  const random = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
  const events: MyrEvent[] = []
  const calls: string[] = []
  const mails: string[] = []
  const approvals: string[] = []
  let round = 1
  const push = (type: string, payload: unknown) => {
    const seq = events.length + 1
    events.push({
      colonyId: colonyId as MyrEvent['colonyId'],
      seq,
      id: `e${seq}` as MyrEvent['id'],
      time: new Date(START + seq * 1000).toISOString(),
      type,
      actor: { kind: 'agent', id: 'lead' },
      trace: { traceId: 't', spanId: 's' },
      schema: 1,
      payload,
    })
  }
  const created = (r: number) => ({
    name: 'Load test',
    mission: `request ${r}`,
    pattern: 'chat',
    agents: AGENTS.map((name) => ({
      name,
      role: name === 'lead' ? 'lead' : 'worker',
      model: 'm/x',
      tools: [],
    })),
    acceptance: [],
    budget: { wallMs: 600_000 },
    unsafeNoSandbox: false,
    chat: { chatId: 'chat-1', round: r, request: `request ${r}` },
    tier: 'team',
  })
  push('colony/created', created(1))
  push('colony/started', {})
  while (events.length < count) {
    const agent = pick(AGENTS)
    const other = pick(AGENTS.filter((a) => a !== agent))
    const roll = random()
    if (roll < 0.2) {
      const callId = `call${events.length}`
      calls.push(callId)
      push('tool/call', { agent, callId, tool: pick(TOOLS), args: { path: `src/f${events.length % 40}.ts` } })
    } else if (roll < 0.38 && calls.length) {
      const callId = calls.shift() as string
      push('tool/result', {
        agent,
        callId,
        tool: 'fs_read',
        ok: random() > 0.1,
        output: 'x'.repeat(Math.floor(random() * 400)),
        ...(random() < 0.1 ? { usage: { totalTokens: 30, cost: 0.001 } } : {}),
      })
    } else if (roll < 0.5) {
      push('llm/response', {
        agent,
        model: 'm/x',
        text:
          random() < 0.6 ? `Thinking about step ${events.length}. `.repeat(1 + Math.floor(random() * 6)) : '',
        toolCalls: [],
        usage: { totalTokens: 200 + Math.floor(random() * 800), ...(random() < 0.95 ? { cost: 0.002 } : {}) },
        stopReason: 'stop',
      })
    } else if (roll < 0.58) push('agent/status', { agent, status: pick(['working', 'idle', 'waiting']) })
    else if (roll < 0.63)
      push('agent/turn', { agent, phase: pick(['start', 'end']), turn: events.length, trigger: 'x' })
    else if (roll < 0.68) {
      mails.push(`e${events.length + 1}`)
      push('mail/sent', { from: agent, to: other, subject: 'about it', body: 'details here', members: [] })
    } else if (roll < 0.72 && mails.length) push('mail/delivered', { mail: pick(mails), to: other })
    else if (roll < 0.75)
      push('board/posted', { agent, text: 'status update', mentions: random() < 0.5 ? [other] : [] })
    else if (roll < 0.78)
      push('note/appended', { agent, text: 'a note', section: random() < 0.3 ? 'plan' : undefined })
    else if (roll < 0.83)
      push('task/changed', {
        by: agent,
        task: {
          id: `t${Math.floor(random() * 30)}`,
          revision: events.length,
          subject: 'Do a thing',
          description: '',
          status: pick(['pending', 'in_progress', 'submitted', 'verified', 'rejected']),
          blockedBy: [],
          artifacts: [],
          assignee: other,
        },
      })
    else if (roll < 0.86)
      push('artifact/versioned', {
        name: `out/file${Math.floor(random() * 12)}.md`,
        version: events.length,
        blob: `b${events.length}`,
        size: 1200,
        author: agent,
        mediaType: 'text/markdown',
      })
    else if (roll < 0.88)
      push('verifier/verdict', {
        target: 'colony',
        verifierId: 'llm-judge#0',
        pass: random() < 0.7,
        score: random(),
        evidence: 'checked',
      })
    else if (roll < 0.9) push('chat/reply', { agent: 'lead', text: 'Here is where it stands.', final: false })
    else if (roll < 0.91)
      push('group/created', { name: `g${Math.floor(random() * 3)}`, members: [agent, other], by: agent })
    else if (roll < 0.92)
      push('group/changed', { name: `g${Math.floor(random() * 3)}`, add: [other], remove: [], by: agent })
    else if (roll < 0.93) {
      const id = `a${events.length}`
      approvals.push(id)
      push('approval/requested', { id, agent, tool: 'shell', summary: 'runs a command' })
    } else if (roll < 0.94 && approvals.length)
      push('approval/decided', { id: approvals.shift(), approved: random() < 0.5, by: 'person' })
    else if (roll < 0.945)
      push('observer/signal', { kind: 'loop', severity: 'warn', facts: 'same call', targets: [agent] })
    else if (roll < 0.95) push('worktree/created', { agent, path: `/w/${agent}`, branch: agent })
    else if (roll < 0.955) push('worktree/merged', { agent, files: ['src/a.ts'] })
    else if (roll < 0.96)
      push('checkpoint/created', { phase: pick(['start', 'end']), commit: `c${events.length}` })
    else if (roll < 0.962)
      push('agent/joined', {
        // A crew stays small: the same few helpers join again in later rounds.
        agent: { name: `w${Math.floor(random() * 6)}`, role: 'worker', model: 'm/y', tools: [] },
        by: 'lead',
        focus: 'help out',
      })
    else if (roll < 0.964)
      push('agent/fallback', { agent, model: 'm/z', previous: 'm/x', kind: 'error', message: 'overloaded' })
    else if (roll < 0.966) {
      // A round ends and the next one starts, as a chat does when the person writes again.
      push(pick(['colony/completed', 'colony/stopped']), { reason: 'awaiting your reply', verdicts: [] })
      push('chat/user', { text: `next request ${round + 1}` })
      round += 1
      push('round/started', created(round))
      push('colony/started', {})
    } else push('agent/status', { agent, status: 'working', detail: 'busy' })
  }
  return events.slice(0, count)
}
