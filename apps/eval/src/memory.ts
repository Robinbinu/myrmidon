/**
 * Task 10's memory and continuation evals: each case seeds projects, kept memories and earlier chats through a
 * running server's API, sends one request, and grades its round together with what it cost.
 *
 *   bun apps/eval/src/memory.ts --base http://127.0.0.1:4401 --model provider/id [--cases a,b] [--trials 2] [--out f]
 *
 * It spends real tokens, so it never runs in `bun test`. Point it at a throwaway server (`myr serve --home <dir>`):
 * it adds memories and projects there and removes the projects after.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { foldColony, type MyrEvent } from '@myrmidon/protocol'
import { MEMORY_CASES, type MemoryCase, type Setup } from './memory-cases.ts'
import { metrics } from './report.ts'

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: process.env.BASE ?? 'http://127.0.0.1:4318' },
    cases: { type: 'string' },
    model: { type: 'string' },
    trials: { type: 'string', default: '1' },
    out: { type: 'string' },
  },
})

const base = values.base.replace(/\/$/, '')
const headers: Record<string, string> = { 'content-type': 'application/json' }
if (process.env.MYR_TOKEN) headers.authorization = `Bearer ${process.env.MYR_TOKEN}`

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? res.status}`)
  return data
}

async function events(colonyId: string): Promise<MyrEvent[]> {
  const out: MyrEvent[] = []
  for (;;) {
    const page = await call<MyrEvent[]>(
      'GET',
      `/api/colonies/${colonyId}/events?from=${out.length + 1}&limit=5000`,
    )
    out.push(...page)
    if (page.length < 5000) return out
  }
}

const model = values.model
if (!model) throw new Error('pass --model provider/id')
const config = { mode: 'orchestrated', leadModel: model, judgeModel: model, roster: [] }

/** Sends one chat and waits for its round to end (or stops it past `seconds`); its log from that round on. */
async function run(setup: Setup, projects: Map<string, string>, seconds: number, title: string) {
  const sent = await call<{ chatId: string; colonyId: string }>('POST', '/api/chats', {
    text: setup.text,
    config,
    ...(setup.project ? { project: projects.get(setup.project) } : {}),
  })
  await call('PATCH', `/api/chats/${sent.chatId}`, { title })
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const log = await events(sent.colonyId)
    const last = foldColony(sent.colonyId, log).rounds.at(-1)
    if (last?.endSeq !== undefined && !last.escalated) return { ...sent, log }
    if (Date.now() > deadline) {
      await call('POST', `/api/chats/${sent.chatId}/stop`, {})
      await Bun.sleep(2000)
      return { ...sent, log: await events(sent.colonyId) }
    }
    await Bun.sleep(3000)
  }
}

async function trial(c: MemoryCase, n: number) {
  const dirs = new Map<string, string>()
  const projects = new Map<string, string>()
  const memories: string[] = []
  try {
    for (const [key, files] of Object.entries(c.projects)) {
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `myr-eval-${c.id}-${key}-`)))
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true })
        writeFileSync(join(dir, name), text)
      }
      dirs.set(key, dir)
      const added = await call<{ project: { id: string } }>('POST', '/api/projects', { path: dir })
      projects.set(key, added.project.id)
      // Evals run unattended: the project's agents may edit and run commands without asking.
      await call('PUT', `/api/projects/${added.project.id}/permissions`, { preset: 'auto' })
    }
    for (const m of c.memories ?? []) {
      const r = await call<{ memory: { id: string } }>('POST', '/api/memory', {
        text: m.text,
        kind: m.kind,
        ...(m.project ? { project: projects.get(m.project) } : {}),
      })
      memories.push(r.memory.id)
    }
    let tokens = 0
    for (const [i, setup] of (c.before ?? []).entries()) {
      const r = await run(setup, projects, c.budget.seconds, `[eval] ${c.id} #${n} setup ${i + 1}`)
      tokens += metrics(r.log).tokens
    }
    const r = await run(c.ask, projects, c.budget.seconds, `[eval] ${c.id} #${n}`)
    const m = metrics(r.log)
    const dir = c.ask.project ? dirs.get(c.ask.project) : undefined
    const files = (name: string) => {
      if (!dir) return undefined
      try {
        return readFileSync(join(dir, name), 'utf8')
      } catch {
        return undefined
      }
    }
    const checks = c.checks.map((check) => ({
      label: check.label,
      pass: check.pass({ events: r.log, reply: m.finalReply ?? '', files }),
    }))
    return {
      case: c.id,
      trial: n,
      chatId: r.chatId,
      outcome: m.outcome,
      pass: m.outcome === 'completed' && checks.every((x) => x.pass),
      checks,
      seconds: m.seconds,
      tokens: m.tokens,
      setupTokens: tokens,
      toolCalls: m.toolCalls,
      reply: (m.finalReply ?? '').slice(0, 400),
    }
  } finally {
    for (const id of memories) await call('DELETE', `/api/memory/${id}`).catch(() => {})
    for (const id of projects.values()) await call('DELETE', `/api/projects/${id}`).catch(() => {})
    for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true })
  }
}

const wanted = values.cases?.split(',').map((x) => x.trim())
const cases = wanted ? MEMORY_CASES.filter((c) => wanted.includes(c.id)) : MEMORY_CASES
const results = []
for (const c of cases)
  for (let t = 1; t <= Math.max(1, Number(values.trials)); t++) {
    process.stdout.write(`${c.id} #${t} … `)
    const r = await trial(c, t).catch((err: Error) => ({
      case: c.id,
      trial: t,
      pass: false,
      error: err.message,
    }))
    results.push(r)
    console.log(
      'error' in r
        ? `error: ${r.error}`
        : `${r.pass ? 'PASS' : 'FAIL'} ${r.outcome}, ${r.seconds}s, ${r.tokens.toLocaleString('en-US')} tok, ${r.toolCalls} tools` +
            (r.checks.some((x) => !x.pass)
              ? ` — failed: ${r.checks
                  .filter((x) => !x.pass)
                  .map((x) => x.label)
                  .join('; ')}`
              : ''),
    )
  }
const out =
  values.out ?? join('evals', 'results', `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ base, model, results }, null, 2)}\n`)
console.log(`\nreport: ${out}`)
