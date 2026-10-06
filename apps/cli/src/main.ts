#!/usr/bin/env bun
import './home.ts'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { colonyId, SqliteLogStore } from '@myrmidon/core'
import {
  type ColonyState,
  colonyMetrics,
  type EventPayloads,
  foldColony,
  type MyrEvent,
} from '@myrmidon/protocol'
import {
  BrowserHub,
  bootOmp,
  bootRuntime,
  ChatService,
  ColonyRun,
  detectSandbox,
  importFromOmp,
  loadColonySpec,
  McpHub,
  ModelResolver,
  ompWebTools,
  ProjectStore,
  type Runtime,
  recoverOrphans,
  SettingsStore,
} from '@myrmidon/runtime'
import { startServer } from '@myrmidon/web'

const HELP = `myrmidon — run and watch colonies of collaborating agents

Usage:
  myrmidon run <colony.yaml> [--ui] [--port N] [--unsafe-no-sandbox]
  myrmidon serve [--port N] [--dev]
  myrmidon import-omp          Copy an existing omp setup (keys, logins, models.yml) from ~/.omp
  myrmidon ls
  myrmidon events <colony-id> [--json]
  myrmidon export <colony-id> [--out file.jsonl]

Options:
  --home DIR   Data directory (default $MYRMIDON_HOME or ~/.myrmidon)
  --dev        Serve the dashboard without an access token (localhost only; for development)
`

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    ui: { type: 'boolean', default: false },
    port: { type: 'string' },
    home: { type: 'string' },
    json: { type: 'boolean', default: false },
    out: { type: 'string' },
    'unsafe-no-sandbox': { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const home = process.env.MYRMIDON_HOME as string
const [command, arg] = positionals

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

function line(e: MyrEvent): string | undefined {
  const p = e.payload as never
  const t = c.dim(e.time.slice(11, 19))
  const cut = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ')
  switch (e.type) {
    case 'board/posted': {
      const x = p as EventPayloads['board/posted']
      return `${t} ${c.cyan(x.agent)} ▸ board: ${cut(x.text)}`
    }
    case 'mail/sent': {
      const x = p as EventPayloads['mail/sent']
      return `${t} ${c.cyan(x.from)} ✉ ${x.to}: ${cut(x.subject || x.body, 90)}`
    }
    case 'note/appended': {
      const x = p as EventPayloads['note/appended']
      return `${t} ${c.cyan(x.agent)} ✎ ${cut(x.text)}`
    }
    case 'task/changed': {
      const x = p as EventPayloads['task/changed']
      return `${t} ${c.dim('task')} ${x.task.id} → ${x.task.status}${x.task.owner ? ` (${x.task.owner})` : ''}: ${cut(x.task.subject, 70)}`
    }
    case 'artifact/versioned': {
      const x = p as EventPayloads['artifact/versioned']
      return `${t} ${c.cyan(x.author)} ⬆ ${c.bold(x.name)} v${x.version} (${x.size} B)`
    }
    case 'tool/result': {
      const x = p as EventPayloads['tool/result']
      return x.ok ? undefined : `${t} ${c.cyan(x.agent)} ${c.red('✗')} ${x.tool}: ${cut(x.output, 100)}`
    }
    case 'llm/response': {
      const x = p as EventPayloads['llm/response']
      return x.error ? `${t} ${c.cyan(x.agent)} ${c.red('model error')}: ${cut(x.error)}` : undefined
    }
    case 'agent/status': {
      const x = p as EventPayloads['agent/status']
      return x.status === 'failed' || x.status === 'stopped'
        ? `${t} ${c.cyan(x.agent)} ${c.yellow(x.status)}${x.detail ? `: ${x.detail}` : ''}`
        : undefined
    }
    case 'observer/signal': {
      const x = p as EventPayloads['observer/signal']
      return `${t} ${c.yellow(`observer ${x.kind}`)}: ${cut(x.facts)}`
    }
    case 'verifier/verdict': {
      const x = p as EventPayloads['verifier/verdict']
      return `${t} ${x.pass ? c.green('PASS') : c.red('FAIL')} ${x.verifierId} on ${x.target}: ${cut(x.evidence, 100)}`
    }
    case 'colony/started':
      return `${t} ${c.bold('colony started')}`
    case 'colony/completed':
      return `${t} ${c.green(c.bold('colony COMPLETED — all acceptance checks passed'))}`
    case 'colony/stopped': {
      const x = p as EventPayloads['colony/stopped']
      return `${t} ${c.yellow(c.bold(`colony stopped: ${x.reason}`))}`
    }
    default:
      return undefined
  }
}

function summary(state: ColonyState) {
  const m = colonyMetrics(state)
  const verdicts = state.verdicts.filter((v) => v.target === 'colony')
  console.log(
    `\n${c.bold(state.name)} — ${state.status}${state.statusReason ? ` (${state.statusReason})` : ''}`,
  )
  console.log(
    `wall ${Math.round(m.wallMs / 1000)}s · tokens ${m.tokens.toLocaleString()} · cost ${m.cost === undefined ? 'n/a' : `$${m.cost.toFixed(3)}`} · turns ${m.turns} · tool calls ${m.toolCalls}`,
  )
  console.log(
    `artifacts: ${
      Object.entries(state.artifacts)
        .map(([n, v]) => `${n} v${v.at(-1)?.version}`)
        .join(', ') || 'none'
    }`,
  )
  const latest = new Map(verdicts.map((v) => [v.verifierId, v.pass]))
  if (latest.size)
    console.log(
      `final checks: ${[...latest].map(([id, pass]) => `${id}=${pass ? 'pass' : 'fail'}`).join(' ')}`,
    )
}

async function recover(runtime: Runtime) {
  for (const id of await recoverOrphans(runtime.ctx.log))
    console.log(c.yellow(`marked ${id} stopped: its runner process had exited`))
}

async function recoverOnly() {
  const runtime = await bootRuntime(home)
  await recover(runtime)
  await runtime.dispose()
}

async function run(path: string) {
  const spec = loadColonySpec(path)
  const runtime = await bootRuntime(home)
  await recover(runtime)
  const sandbox = detectSandbox()
  const omp = await bootOmp(home)
  const settings = new SettingsStore(home)
  const colony = new ColonyRun(runtime, spec, {
    unsafeNoSandbox: values['unsafe-no-sandbox'],
    sandbox,
    resolver: new ModelResolver(omp),
    web: ompWebTools(omp, () => settings.get().search.provider),
  })
  runtime.ctx.on('log/appended', (id, events) => {
    if (id !== colony.id) return
    for (const e of events) {
      const out = line(e)
      if (out) console.log(out)
    }
  })
  console.log(
    `${c.bold('Myrmidon')} colony ${c.bold(spec.name)} — ${spec.agents.length} agents, pattern ${spec.pattern}, budget ${Math.round(spec.budget.wallMs / 1000)}s`,
  )
  console.log(
    c.dim(
      `id ${colony.id} · sandbox ${sandbox.kind}${values['unsafe-no-sandbox'] ? ' (UNSAFE override)' : ''} · data ${home}`,
    ),
  )
  const server = values.ui
    ? startServer({ home, port: Number(values.port ?? 0), noAuth: values.dev })
    : undefined
  if (server) console.log(`${c.bold('UI')} ${server.url}`)
  let interrupted = false
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130)
    interrupted = true
    console.log(c.yellow('\nstopping colony… (Ctrl-C again to force)'))
    void colony.stop('interrupted by user')
  })
  try {
    await colony.start()
  } catch (err) {
    console.error(c.red(`cannot start colony: ${err instanceof Error ? err.message : String(err)}`))
    await runtime.dispose()
    await server?.stop()
    process.exit(2)
  }
  const final = await colony.done
  summary(final)
  console.log(c.dim(`artifacts mirror: ${colony.workspace.mirrorRoot}/artifacts`))
  await runtime.dispose()
  if (server) {
    console.log(`${c.bold('UI still running')} at ${server.url} — Ctrl-C to exit`)
    process.removeAllListeners('SIGINT')
    process.on('SIGINT', async () => {
      await server.stop()
      process.exit(final.status === 'completed' ? 0 : 1)
    })
    return
  }
  process.exit(final.status === 'completed' ? 0 : 1)
}

async function main() {
  if (values.help || !command) {
    console.log(HELP)
    return
  }
  switch (command) {
    case 'run':
      if (!arg) throw new Error('usage: myrmidon run <colony.yaml>')
      return run(arg)
    case 'serve': {
      const runtime = await bootRuntime(home)
      await recover(runtime)
      const settings = new SettingsStore(home)
      const omp = await bootOmp(home)
      const resolver = new ModelResolver(omp)
      const sandbox = detectSandbox()
      const mcp = new McpHub(omp.agentDir)
      const browser = new BrowserHub(join(home, 'browser'))
      const projects = new ProjectStore(home)
      // A server that fails to start is reported in Settings; it must not keep Myrmidon from starting.
      void mcp
        .start()
        .catch((err) => console.error(c.yellow(`MCP: ${err instanceof Error ? err.message : err}`)))
      const chats = new ChatService(runtime, {
        resolver,
        settings,
        web: ompWebTools(omp, () => settings.get().search.provider),
        unsafeNoSandbox: values['unsafe-no-sandbox'],
        mcp,
        browser,
        projects,
      })
      const server = startServer({
        home,
        port: Number(values.port ?? 0),
        chats,
        settings,
        resolver,
        omp,
        mcp,
        browser,
        projects,
        sandboxKind: sandbox.kind,
        noAuth: values.dev,
      })
      console.log(`${c.bold('Myrmidon')} ${server.url}`)
      if (values.dev)
        console.log(c.yellow('dev mode: no access token. Any program on this machine can use the API.'))
      console.log(
        c.dim(
          `data ${home} · ${omp.available().length} models ready · sandbox ${sandbox.kind} · Ctrl-C to stop`,
        ),
      )
      process.on('SIGINT', async () => {
        console.log(c.yellow('\nstopping running colonies…'))
        await chats.stopAll()
        await browser.close().catch(() => {})
        await mcp.close().catch(() => {})
        await server.stop()
        await runtime.dispose()
        process.exit(0)
      })
      return
    }
    case 'import-omp': {
      const report = importFromOmp(home)
      console.log(`${c.green('imported')} ${report.copied.join(', ') || 'nothing'} into ${home}/agent`)
      if (report.skipped.length) console.log(c.dim(`not found: ${report.skipped.join(', ')}`))
      return
    }
    case 'ls': {
      await recoverOnly()
      const store = new SqliteLogStore(home)
      for (const id of await store.colonies()) {
        const s = foldColony(id, await store.read(id))
        console.log(
          `${id}  ${s.status.padEnd(9)} ${s.name}${s.statusReason ? c.dim(` (${s.statusReason})`) : ''}`,
        )
      }
      store.close()
      return
    }
    case 'events':
    case 'export': {
      if (!arg) throw new Error(`usage: myrmidon ${command} <colony-id>`)
      const store = new SqliteLogStore(home)
      const events = await store.read(colonyId(arg))
      store.close()
      if (command === 'export' || values.json) {
        const text = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        if (values.out) {
          await Bun.write(values.out, text)
          console.log(`wrote ${events.length} events to ${values.out}`)
        } else process.stdout.write(text)
        return
      }
      for (const e of events)
        console.log(`#${String(e.seq).padStart(4)} ${line(e) ?? `${c.dim(e.time.slice(11, 19))} ${e.type}`}`)
      return
    }
    default:
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
