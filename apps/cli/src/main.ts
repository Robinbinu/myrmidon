#!/usr/bin/env bun
import './home.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { colonyId, SqliteLogStore } from '@myrmidon/core'
import {
  type ColonyState,
  colonyMetrics,
  DELIVERED_VERIFIER,
  type EventPayloads,
  foldColony,
  type MyrEvent,
  reviewVerdicts,
  roundSlice,
} from '@myrmidon/protocol'
import {
  addKnownSecrets,
  alive,
  BrowserHub,
  bootOmp,
  bootRuntime,
  ChatService,
  ChatShelf,
  Checkpoints,
  ColonyRun,
  ComputerHub,
  ContextWindows,
  detectSandbox,
  guardSecrets,
  HookStore,
  importFromOmp,
  loadColonySpec,
  McpHub,
  MemoryStore,
  ModelResolver,
  ompMediaTools,
  ompWebTools,
  ownerOnly,
  PluginHost,
  PluginStore,
  ProjectStore,
  type Runtime,
  recoverOrphans,
  ScheduleStore,
  SessionImports,
  SettingsStore,
  SkillLibrary,
  SkillProposalStore,
  SpecialistStore,
  SshHub,
  StreamRuleStore,
  TelemetryExport,
  ToolLibrary,
  type VoiceFiles,
} from '@myrmidon/runtime'
import { startServer } from '@myrmidon/web'
import { channels } from './channels.ts'
import { setupCopy } from './copy.ts'
import { plugins, skills } from './installs.ts'
import { type Call, doctor, key, login, model, type ServerInfo, setup } from './setup.ts'
import { shutdownSignals } from './shutdown.ts'
import { style, terminal } from './terminal.ts'

const HELP = `myrmidon — run and watch colonies of collaborating agents

Usage:
  myrmidon run <colony.yaml> [--ui] [--port N] [--unsafe-no-sandbox]
  myrmidon serve [--port N] [--dev] [--debug] [--host ADDR] [--public-url URL] [--allow-host HOST:PORT]
               [--preview-port N] [--preview-url URL]
               --host / --public-url make a remote gateway: devices pair, see docs/remote.md
               --preview-port / --preview-url: where devices open agent-built pages from a remote gateway
  myrmidon pair [--scope full|chat]
               Print a single-use link that pairs a device with the running server (10 minutes)
  myrmidon setup               Walk through sign-in or keys, the default model and a first device, in the terminal
  myrmidon login [ID]          Sign in with a subscription; works on a server with no browser (paste the link back)
  myrmidon key [PROVIDER]      Add an API key (typed hidden, or piped: myrmidon key openai < key.txt)
  myrmidon model [REF]         Show or set the default model (provider/model); it is tested before it is saved
  myrmidon doctor              Check the server, models, sandbox, browser tools, previews, devices and channels
  myrmidon channels [<channel> [on|off|set <name> <value>] | approve <channel> <code> | revoke <channel> <who>]
               Talk to your agents from Telegram and more: set a channel up (secrets hidden or piped), approve
               people, and choose who may write (set dm|groups|mention|per-person|allow|stream)
  myrmidon plugins [add <source> | update <name> | remove <name> | marketplaces [add|refresh|remove …]]
               Install plugins from a folder, repository URL, npm:<package> or <plugin>@<marketplace>; you
               review what runs before anything is installed
  myrmidon skills [search [query] | add <@scope/name | repository URL> | update <name> | remove <name>]
               Search omp's skills registry and install skills, after the same review
  myrmidon ask "<request>" [--chat ID] [--project ID] [--wait]
               Send a request to the running server (from \`serve\`); --wait prints the final answer
  myrmidon import-omp          Copy an existing omp setup (keys, logins, models.yml) from ~/.omp
  myrmidon import-session [ID "<message>"] [--project ID]
               List your Claude Code and Codex sessions; with an ID and a message, continue that session as a new chat
  myrmidon ls
  myrmidon events <colony-id> [--json]
  myrmidon export <colony-id> [--out file.jsonl]

Options:
  --home DIR   Data directory (default $MYRMIDON_HOME or ~/.myrmidon)
  --dev        Serve the dashboard without an access token (localhost only; for development)
  --debug      Development build of the dashboard with hot reload; the browser's console and errors print here
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
    host: { type: 'string' },
    'public-url': { type: 'string' },
    'allow-host': { type: 'string', multiple: true },
    'preview-port': { type: 'string' },
    'preview-url': { type: 'string' },
    scope: { type: 'string' },
    debug: { type: 'boolean', default: false },
    chat: { type: 'string' },
    project: { type: 'string' },
    wait: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const home = process.env.MYRMIDON_HOME as string
const [command, arg] = positionals

const c = style

/**
 * One event as a terminal line, or nothing for events not worth a line. `delivered` collects the ids of the delivery
 * records an unreviewed round's completion cites, so that completion is not announced as checked.
 */
function line(e: MyrEvent, delivered: Set<string>): string | undefined {
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
      if (x.verifierId === DELIVERED_VERIFIER) {
        delivered.add(e.id)
        return `${t} ${c.dim('final answer delivered, not reviewed')}`
      }
      return `${t} ${x.pass ? c.green('PASS') : c.red('FAIL')} ${x.verifierId} on ${x.target}: ${cut(x.evidence, 100)}`
    }
    case 'colony/started':
      return `${t} ${c.bold('colony started')}`
    case 'colony/completed': {
      const x = p as EventPayloads['colony/completed']
      return x.verdicts.every((id) => delivered.has(id))
        ? `${t} ${c.green(c.bold('colony completed (not reviewed)'))}`
        : `${t} ${c.green(c.bold('colony COMPLETED — all acceptance checks passed'))}`
    }
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
  const verdicts = reviewVerdicts(state).filter((v) => v.target === 'colony')
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

/** Model windows from the person's settings, omp, and models.dev; the models.dev refresh finishes in the background. */
function contextWindows(settings: SettingsStore): ContextWindows {
  const windows = new ContextWindows({
    cacheFile: join(home, 'cache', 'model-windows.json'),
    overrides: () => settings.get().models.windows,
  })
  void windows.load()
  return windows
}

async function run(path: string) {
  const spec = loadColonySpec(path)
  const runtime = await bootRuntime(home)
  await recover(runtime)
  const sandbox = detectSandbox()
  const omp = await bootOmp(home)
  const settings = new SettingsStore(home)
  // As `serve` does (apps/web/src/server.ts): secrets reach model providers as placeholders unless the person said no.
  const hide = settings.get().privacy.hideSecrets
  guardSecrets({ enabled: () => hide, keyFile: join(home, 'secret-placeholder.key') })
  addKnownSecrets(() => omp.secretValues())
  const colony = new ColonyRun(runtime, spec, {
    unsafeNoSandbox: values['unsafe-no-sandbox'],
    sandbox,
    resolver: new ModelResolver(omp, contextWindows(settings)),
    web: ompWebTools(omp, () => settings.get().search.provider),
    media: ompMediaTools({
      images: omp,
      imageModel: () => settings.get().images.model,
      voice: () => undefined,
    }),
  })
  const delivered = new Set<string>()
  runtime.ctx.on('log/appended', (id, events) => {
    if (id !== colony.id) return
    for (const e of events) {
      const out = line(e, delivered)
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
    ? startServer({ home, port: Number(values.port ?? 0), noAuth: values.dev, debug: values.debug })
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
      // The desktop app names the server it starts with this (apps/desktop/src/server.ts), to tell its server.json
      // from another server's for the same home. Taken out first, so nothing this server starts inherits it.
      const launch = process.env.MYRMIDON_LAUNCH_ID
      delete process.env.MYRMIDON_LAUNCH_ID
      const runtime = await bootRuntime(home)
      await recover(runtime)
      const settings = new SettingsStore(home)
      const omp = await bootOmp(home)
      const resolver = new ModelResolver(omp, contextWindows(settings))
      const sandbox = detectSandbox()
      const plugins = new PluginStore(home)
      const pluginHost = new PluginHost(plugins)
      // Plugin code sees every event as it lands, and adds its own to a colony's log.
      runtime.ctx.on('log/appended', (id, events) => pluginHost.dispatch(id, events))
      // Each finished round goes to the person's OTLP collector, when Settings → General turns that on.
      const telemetry = new TelemetryExport({
        settings: () => settings.get().telemetry,
        vault: omp.voiceKeys,
        read: (id) => runtime.ctx.log.read(id as never),
      })
      runtime.ctx.on('log/appended', (id, events) => telemetry.appended(id, events))
      pluginHost.attach(async (colonyId, type, data, plugin) => {
        await runtime.ctx.log.appendOne(colonyId as never, {
          type: 'plugin/event',
          actor: { kind: 'system', id: `plugin:${plugin}` },
          payload: { plugin, type, data },
        })
      })
      void pluginHost
        .start()
        .catch((err) => console.error(c.yellow(`plugins: ${err instanceof Error ? err.message : err}`)))
      const mcp = new McpHub(omp.agentDir, () => plugins.mcpServers())
      const browser = new BrowserHub(join(home, 'browser'))
      const computer = new ComputerHub(home, {
        mcp,
        enabled: () => settings.get().computerUse.enabled,
        engine: () => settings.get().computerUse.engine ?? 'cua',
        log: (line) => (values.debug ? console.log(c.dim(line)) : undefined),
        // macOS names the app this server runs in (the desktop app, or the terminal) for the driver's diagnostics.
        ...(process.env.__CFBundleIdentifier ? { hostBundleId: process.env.__CFBundleIdentifier } : {}),
      })
      const ssh = new SshHub({ controlDir: join(home, 'ssh') })
      const projects = new ProjectStore(home)
      const specialists = new SpecialistStore(home)
      const skillProposals = new SkillProposalStore(home)
      const library = new ToolLibrary(join(home, 'tools'))
      const memory = new MemoryStore(home)
      const skills = new SkillLibrary(home, undefined, () => plugins.skillRoots())
      // Learned skills nobody uses are retired to the archive; Settings → Skills restores them.
      skills.curateEvery((archived, err) =>
        err
          ? console.error(c.yellow(`skills: ${err instanceof Error ? err.message : err}`))
          : console.log(c.dim(`skills archived (unused for a while): ${archived.join(', ')}`)),
      )
      const hooks = new HookStore(home, () => plugins.hooks())
      const rules = new StreamRuleStore(home)
      const checkpoints = new Checkpoints(join(home, 'checkpoints'))
      // A server that fails to start is reported in Settings; it must not keep Myrmidon from starting.
      void mcp
        .start()
        .catch((err) => console.error(c.yellow(`MCP: ${err instanceof Error ? err.message : err}`)))
      const shelf = new ChatShelf(home)
      const imports = new SessionImports(home, { projects })
      // The voice engines belong to the server, which starts after the chats: tts finds them once it is up.
      let voice: VoiceFiles | undefined
      const chats = new ChatService(runtime, {
        resolver,
        shelf,
        imports,
        settings,
        web: ompWebTools(omp, () => settings.get().search.provider),
        media: ompMediaTools({
          images: omp,
          imageModel: () => settings.get().images.model,
          voice: () => voice,
        }),
        unsafeNoSandbox: values['unsafe-no-sandbox'],
        mcp,
        browser,
        computer,
        ssh,
        projects,
        specialists,
        skillProposals,
        library,
        checkpoints,
        memory,
        skills,
        hooks,
        rules,
        plugins: pluginHost,
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
        computer,
        ssh,
        telemetry,
        projects,
        specialists,
        skillProposals,
        library,
        memory,
        skills,
        hooks,
        plugins,
        pluginHost,
        schedules: new ScheduleStore(home),
        shelf,
        imports,
        sandboxKind: sandbox.kind,
        noAuth: values.dev,
        ...(values.host ? { host: values.host } : {}),
        ...(values['public-url'] ? { publicUrl: values['public-url'] } : {}),
        ...(values['allow-host']?.length ? { allowHosts: values['allow-host'] } : {}),
        ...(values['preview-port'] ? { previewPort: Number(values['preview-port']) } : {}),
        ...(values['preview-url'] ? { previewUrl: values['preview-url'] } : {}),
        debug: values.debug,
        // The desktop app stops the server it started this way: Windows has no SIGTERM for it to send.
        onShutdown: () => void shutdown(),
      })
      voice = server.voice
      console.log(`${c.bold('Myrmidon')} ${server.url}`)
      // Speech engines load in the background now, so the first call does not wait on them.
      void server.warmVoice()
      if (server.remote)
        console.log(
          `${c.green('remote gateway')}${server.publicUrl ? ` at ${server.publicUrl}` : ''}: pair a device with ${c.bold('myrmidon pair')} (see docs/remote.md)`,
        )
      if (server.remote && !server.previewUrl)
        console.log(
          c.dim(
            'previews of agent-built pages open only over an SSH tunnel or the bound address; add --preview-port and --preview-url for others (docs/remote.md)',
          ),
        )
      if (values.dev)
        console.log(c.yellow('dev mode: no access token. Any program on this machine can use the API.'))
      if (values.debug)
        console.log(c.yellow('debug mode: development build; browser console output and errors print below.'))
      console.log(
        c.dim(
          `data ${home} · ${omp.available().length} models ready · sandbox ${sandbox.kind} · Ctrl-C to stop`,
        ),
      )
      // `myrmidon ask` and scripts find the running server here; only this user can read it.
      const serverFile = join(home, 'server.json')
      writeFileSync(
        serverFile,
        JSON.stringify({
          url: server.url.replace(/#.*$/, ''),
          token: server.token,
          pid: process.pid,
          ...(launch ? { launch } : {}),
          remote: server.remote,
          ...(server.publicUrl ? { publicUrl: server.publicUrl } : {}),
          ...(server.previewUrl ? { previewUrl: server.previewUrl } : {}),
        }),
        {
          mode: 0o600,
        },
      )
      ownerOnly(serverFile)
      // Also on an exit no handler below sees (an uncaught error); a kill leaves it, and readers check its pid.
      process.on('exit', () => rmSync(serverFile, { force: true }))
      // Once, however many ways the stop arrives (the desktop app's request, then its signal if that is slow).
      let stopping: Promise<void> | undefined
      const shutdown = () =>
        (stopping ??= (async () => {
          console.log(c.yellow('\nstopping running colonies…'))
          rmSync(serverFile, { force: true })
          await chats.stopAll()
          // The rounds just stopped are on their way to the collector.
          await telemetry.flush()
          await browser.close().catch(() => {})
          await computer.stop().catch(() => {})
          await ssh.close().catch(() => {})
          await mcp.close().catch(() => {})
          await server.stop()
          await runtime.dispose()
          process.exit(0)
        })())
      // SIGINT and SIGTERM (systemd) everywhere; Windows adds Ctrl+Break and closing the console window.
      for (const sig of shutdownSignals(process.platform)) process.on(sig, shutdown)
      return
    }
    case 'ask':
      return ask(arg)
    case 'pair':
      return pair()
    case 'setup': {
      const { call, info } = await runningServer()
      return withScratch((scratch) =>
        setup(call, terminal(), { sandbox: detectSandbox(), scratch, server: info }, pair),
      )
    }
    case 'login':
      return login((await runningServer()).call, terminal(), arg)
    case 'key':
      return key((await runningServer()).call, terminal(), arg)
    case 'model':
      return model((await runningServer()).call, terminal(), arg)
    case 'channels':
      return channels((await runningServer()).call, terminal(), positionals.slice(1))
    case 'plugins':
      return plugins((await runningServer()).call, terminal(), positionals.slice(1))
    case 'skills':
      return skills((await runningServer()).call, terminal(), positionals.slice(1))
    case 'doctor': {
      const server = await runningServer().catch(() => undefined)
      const problems = await withScratch((scratch) =>
        doctor(server?.call, terminal(), { sandbox: detectSandbox(), scratch, server: server?.info }),
      )
      process.exitCode = problems ? 1 : 0
      return
    }
    case 'import-omp': {
      const report = importFromOmp(home)
      console.log(`${c.green('imported')} ${report.copied.join(', ') || 'nothing'} into ${home}/agent`)
      if (report.skipped.length) console.log(c.dim(`not found: ${report.skipped.join(', ')}`))
      return
    }
    case 'import-session':
      return importSession(arg, positionals[2])
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
      const delivered = new Set<string>()
      for (const e of events)
        console.log(
          `#${String(e.seq).padStart(4)} ${line(e, delivered) ?? `${c.dim(e.time.slice(11, 19))} ${e.type}`}`,
        )
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

/** Calls the API of the server running on this machine for this home, with the token it wrote down. */
/** The server `myrmidon serve` started for this home, checked to be answering (server.json outlives a crash). */
async function runningServer(): Promise<{ call: Call; info: ServerInfo }> {
  const file = join(home, 'server.json')
  if (!existsSync(file)) throw new Error(setupCopy.noServer(home))
  const info = JSON.parse(readFileSync(file, 'utf8')) as ServerInfo & { token: string; pid?: number }
  // Left by a server that was killed (on Windows, any server stopped from outside).
  if (info.pid !== undefined && !alive(info.pid)) {
    rmSync(file, { force: true })
    throw new Error(setupCopy.noServer(home))
  }
  const call: Call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(new URL(path, info.url), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(info.token ? { authorization: `Bearer ${info.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(data.error ?? `${method} ${path}: ${res.status}`)
    return data
  }
  await call('GET', '/api/whoami').catch((err: Error) => {
    throw new Error(err.message.includes('Unable to connect') ? setupCopy.noServer(home) : err.message)
  })
  const { token: _token, ...rest } = info
  return { call, info: rest }
}

/** A throwaway directory for checks that run something (the sandbox), removed afterwards. */
async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'myr-check-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Prints a single-use link that pairs a device (a phone, a laptop) with the running remote gateway. */
async function pair() {
  const scope = values.scope === 'chat' ? 'chat' : 'full'
  const { call } = await runningServer()
  const { code, link } = await call<{ code: string; link: string }>('POST', '/api/devices/pair-code', {
    scope,
  })
  console.log(
    `${c.bold('Pair a device')} (${scope === 'chat' ? 'chats only' : 'full access'}, one use, 10 minutes):`,
  )
  console.log(`  ${c.green(link)}`)
  console.log(c.dim(`  or enter the code ${code} on the gateway's page`))
}

/** Sends a request to the running server, like typing it in the composer; with --wait, prints the answer. */
/** Lists other tools' sessions (read here, no server needed), or continues one as a new chat on the running server. */
async function importSession(id: string | undefined, request: string | undefined) {
  const sessions = await new SessionImports(home, { projects: new ProjectStore(home) }).list()
  if (!id) {
    if (!sessions.length) return console.log('No Claude Code or Codex sessions found.')
    for (const s of sessions.slice(0, 30))
      console.log(
        `${c.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${(s.source === 'claude' ? 'Claude Code' : 'Codex').padEnd(11)}  ${s.id}  ${s.title ?? s.preview ?? ''}${c.dim(`  ${s.cwd}`)}`,
      )
    return console.log(c.dim('Continue one: myrmidon import-session <id> "<message>"'))
  }
  if (!request?.trim()) throw new Error('usage: myrmidon import-session <id> "<message>" [--project ID]')
  const found = sessions.find((s) => s.id === id)
  if (!found) throw new Error(`no Claude Code or Codex session ${id}`)
  const { call } = await runningServer()
  const imported = await call<{ id: string; project?: { id: string } }>('POST', '/api/import-sessions', {
    source: found.source,
    id,
  })
  const project = values.project ?? imported.project?.id
  const sent = await call<{ chatId: string }>('POST', '/api/chats', {
    text: request,
    importOf: imported.id,
    ...(project ? { project } : {}),
  })
  console.log(`${c.green('sent')} chat ${sent.chatId}`)
}

async function ask(request: string | undefined) {
  if (!request?.trim()) throw new Error('usage: myrmidon ask "<request>" [--chat ID] [--project ID] [--wait]')
  const { call } = await runningServer()
  const sent = await call<{ chatId: string; colonyId: string; round?: number }>('POST', '/api/chats', {
    text: request,
    ...(values.chat ? { chatId: values.chat } : {}),
    ...(values.project ? { project: values.project } : {}),
  })
  console.log(`${c.green('sent')} chat ${sent.chatId}${sent.round ? ` round ${sent.round}` : ''}`)
  if (!values.wait) return
  for (;;) {
    await Bun.sleep(3000)
    const events = await call<MyrEvent[]>('GET', `/api/colonies/${sent.colonyId}/events?from=1&limit=20000`)
    const { state, info } = roundSlice(foldColony(sent.colonyId, events), events, sent.round)
    if (!info || info.endSeq === undefined) continue
    // An escalated round hands the request to the next one; follow it.
    if (info.escalated && sent.round !== undefined) {
      sent.round += 1
      continue
    }
    const replies = state.chatMessages.filter((m) => m.from !== 'user')
    const answer = replies.filter((m) => m.final).at(-1) ?? replies.at(-1)
    if (answer) console.log(`\n${answer.text}\n`)
    const verdict = state.verdicts.filter((v) => v.target === 'colony').at(-1)
    console.log(
      info.status === 'completed'
        ? c.green(`completed${verdict?.score !== undefined ? ` · judge ${verdict.score.toFixed(2)}` : ''}`)
        : c.yellow(`${info.status}${info.statusReason ? `: ${info.statusReason}` : ''}`),
    )
    process.exitCode = info.status === 'completed' ? 0 : 1
    return
  }
}
