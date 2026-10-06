/**
 * Eval harness: runs the standard prompts against a running Myrmidon server with real models and writes a report.
 *
 *   bun run eval [--base http://127.0.0.1:4318] [--cases a,b] [--modes orchestrated,swarm]
 *                       [--model provider/id] [--judge provider/id] [--trials 3] [--out file.json]
 *   bun run eval --compare before.json after.json
 *
 * It spends real tokens, so it never runs as part of `bun test`. Point it at a test server (`myr serve --home
 * <dir>`) to keep eval chats out of your own list; they are titled "[eval] …" either way. A server started
 * without --dev needs its token in MYR_TOKEN. Exits 1 when a run picks the wrong tier or breaches its budget.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { MyrEvent } from '@myrmidon/protocol'
import { CASES } from './cases.ts'
import {
  type CaseSummary,
  compare,
  type EvalCase,
  grade,
  type Mode,
  metrics,
  summarize,
  type TrialResult,
} from './report.ts'

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: process.env.BASE ?? 'http://127.0.0.1:4318' },
    cases: { type: 'string' },
    modes: { type: 'string', default: 'orchestrated,swarm' },
    model: { type: 'string' },
    judge: { type: 'string' },
    trials: { type: 'string', default: '1' },
    out: { type: 'string' },
    compare: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (values.compare) {
  const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'))
  if (!a || !b) throw new Error('usage: bun run eval --compare before.json after.json')
  const load = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { summary: CaseSummary[] }).summary
  for (const line of compare(load(a), load(b))) console.log(line)
  process.exit(0)
}

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

const ENDED = new Set(['colony/completed', 'colony/stopped', 'colony/failed'])

const cases = values.cases
  ? values.cases.split(',').map((id) => {
      const c = CASES.find((x) => x.id === id.trim())
      if (!c) throw new Error(`no such case: ${id} (have ${CASES.map((x) => x.id).join(', ')})`)
      return c
    })
  : CASES
const modes = values.modes.split(',').map((m) => m.trim()) as Mode[]
const trials = Math.max(1, Number(values.trials))
const models = await call<{ default?: string }>('GET', '/api/models')
const model = values.model ?? models.default
if (!model) throw new Error('no model: pass --model provider/id')
const judge = values.judge ?? model

function teamConfig(mode: Mode) {
  return mode === 'swarm'
    ? { mode, leadModel: model, judgeModel: judge, roster: [0, 1, 2].map(() => ({ role: 'peer', model })) }
    : {
        mode,
        leadModel: model,
        judgeModel: judge,
        roster: ['researcher', 'coder', 'writer'].map((role) => ({ role, model })),
      }
}

async function runTrial(c: EvalCase, mode: Mode, trial: number): Promise<TrialResult> {
  let dir: string | undefined
  let projectId: string | undefined
  try {
    if (c.project) {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `myr-eval-${c.id}-`)))
      for (const [name, text] of Object.entries(c.project)) writeFileSync(join(dir, name), text)
      projectId = (await call<{ project: { id: string } }>('POST', '/api/projects', { path: dir })).project.id
    }
    const sent = await call<{ chatId: string; colonyId: string }>('POST', '/api/chats', {
      text: c.prompt,
      config: teamConfig(mode),
      ...(projectId ? { project: projectId } : {}),
    })
    await call('PATCH', `/api/chats/${sent.chatId}`, { title: `[eval] ${c.id} ${mode} #${trial}` })
    // A runaway still gets a verdict: stop it well past its budget and grade what it did.
    const deadline = Date.now() + (c.budget.seconds * 1.5 + 60) * 1000
    let log: MyrEvent[] = []
    for (;;) {
      log = await events(sent.colonyId)
      if (log.some((e) => ENDED.has(e.type))) break
      if (Date.now() > deadline) {
        await call('POST', `/api/chats/${sent.chatId}/stop`, {})
        await Bun.sleep(2000)
        log = await events(sent.colonyId)
        break
      }
      await Bun.sleep(3000)
    }
    const latest = new Map<string, string>()
    for (const e of log)
      if (e.type === 'artifact/versioned') {
        const p = e.payload as { name: string; blob: string }
        latest.set(p.name, p.blob)
      }
    const artifacts: Record<string, string> = {}
    for (const [name, blob] of latest) {
      const res = await fetch(`${base}/api/colonies/${sent.colonyId}/blobs/${blob}`, { headers })
      if (res.ok) artifacts[name] = await res.text()
    }
    const local: Record<string, boolean> = {}
    for (const check of c.checks) {
      if (!dir) continue
      if (check.kind === 'command') {
        const proc = Bun.spawn(check.run, { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
        local[check.label] = (await proc.exited) === 0
      } else if (check.kind === 'unchanged') {
        let now: string | undefined
        try {
          now = readFileSync(join(dir, check.file), 'utf8')
        } catch {
          now = undefined
        }
        local[check.label] = now === c.project?.[check.file]
      }
    }
    const m = metrics(log)
    return {
      case: c.id,
      mode,
      trial,
      chatId: sent.chatId,
      colonyId: sent.colonyId,
      metrics: m,
      grade: grade(c, { events: log, artifacts, local }, m),
    }
  } catch (err) {
    return {
      case: c.id,
      mode,
      trial,
      metrics: metrics([]),
      grade: { checks: [], pass: false, tierMismatch: false },
      error: (err as Error).message,
    }
  } finally {
    if (projectId) await call('DELETE', `/api/projects/${projectId}`).catch(() => {})
  }
}

const startedAt = new Date().toISOString()
const results: TrialResult[] = []
for (const c of cases)
  for (const mode of c.modes ?? modes) {
    if (!modes.includes(mode)) continue
    for (let t = 1; t <= trials; t++) {
      process.stdout.write(`${c.id} [${mode}] #${t} … `)
      const r = await runTrial(c, mode, t)
      results.push(r)
      const failed = r.grade.checks.filter((x) => !x.pass).map((x) => x.label)
      console.log(
        r.error
          ? `error: ${r.error}`
          : `${r.grade.pass ? 'PASS' : 'FAIL'} ${r.metrics.outcome}, ${r.metrics.tier ?? '?'} tier, ` +
              `${r.metrics.seconds}s, ${r.metrics.tokens.toLocaleString('en-US')} tok, ${r.metrics.toolCalls} tools` +
              (failed.length ? ` — failed: ${failed.join('; ')}` : '') +
              (r.grade.tierMismatch ? ' — TIER MISMATCH' : '') +
              (r.grade.budgetBreach ? ` — BUDGET ${r.grade.budgetBreach}` : ''),
      )
    }
  }

const summary = summarize(results)
const out = values.out ?? join('evals', 'results', `${startedAt.replace(/[:.]/g, '-')}.json`)
mkdirSync(join(out, '..'), { recursive: true })
writeFileSync(
  out,
  `${JSON.stringify({ startedAt, base, model, judge, trials, summary, results }, null, 2)}\n`,
)

console.log('\ncase [mode]                       pass   pass@k pass^k  median s   median tok')
for (const s of summary)
  console.log(
    `${`${s.case} [${s.mode}]`.padEnd(34)} ${`${Math.round(s.passRate * 100)}%`.padStart(4)}   ` +
      `${(s.passAtK ? 'yes' : 'no').padEnd(6)} ${(s.passHatK ? 'yes' : 'no').padEnd(6)} ` +
      `${String(s.medianSeconds).padStart(8)}   ${s.medianTokens.toLocaleString('en-US').padStart(10)}`,
  )
console.log(`\nreport: ${out}`)
const hard = summary.flatMap((s) => s.hardFailures.map((f) => `${s.case} [${s.mode}] ${f}`))
if (hard.length) {
  console.log(`\nhard failures:\n${hard.map((h) => `  ${h}`).join('\n')}`)
  process.exit(1)
}
