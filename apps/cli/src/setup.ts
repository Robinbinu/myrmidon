import { findChrome, type Sandbox } from '@myrmidon/runtime'
import { listChannels, statusText } from './channels.ts'
import { setupCopy as t } from './copy.ts'

/**
 * Setting Myrmidon up from a terminal alone, for a server with no desktop (after Hermes's `hermes setup` / `model` /
 * `doctor`). Everything goes through the running server's API, the same one Settings uses, so the CLI and the page
 * never disagree about keys or the default model.
 */

/** A call to the running server's API (loopback, with its token). */
export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>

/** How the commands talk to the person; a test drives it with scripted answers. */
export interface Terminal {
  print(line?: string): void
  /** Asks one question; `hidden` does not echo (keys). Rejects when `signal` aborts. */
  ask(question: string, options?: { hidden?: boolean; signal?: AbortSignal }): Promise<string>
  /** Everything piped to stdin, when it is not a terminal (`myrmidon key openai < key.txt`). */
  piped(): Promise<string | undefined>
  /** Someone is typing (stdin is a terminal). */
  readonly interactive: boolean
  /** Over SSH, or with no display: a sign-in's browser is on another device. */
  readonly headless: boolean
  /** Runs `fn` on Ctrl-C instead of exiting at once; returns the undo. */
  onInterrupt(fn: () => void): () => void
  readonly style: Record<'dim' | 'bold' | 'green' | 'red' | 'yellow' | 'cyan', (s: string) => string>
}

interface LoginOption {
  id: string
  name: string
  provider: string
  ready: boolean
}
interface LoginState {
  id: string
  status: 'waiting' | 'done' | 'failed' | 'cancelled'
  url?: string
  instructions?: string
  prompt?: { message: string; placeholder?: string }
  progress?: string
  result?: { email?: string; orgName?: string }
  error?: string
}
interface ModelEntry {
  ref: string
  provider: string
  name: string
}
interface Provider {
  id: string
  ready: boolean
  custom: boolean
}
type Settings = { team: { leadModel?: string } & Record<string, unknown> } & Record<string, unknown>

const POLL_MS = 1000
/** Models shown at once when picking; more means typing more of the name. */
const PICK_MAX = 15

/** A numbered menu; returns the chosen index. */
async function choose(term: Terminal, title: string, options: string[]): Promise<number> {
  term.print(term.style.bold(title))
  options.forEach((o, i) => {
    term.print(`  ${term.style.cyan(String(i + 1).padStart(2))}  ${o}`)
  })
  for (;;) {
    const n = Number((await term.ask(t.pick.prompt)).trim())
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
    term.print(term.style.yellow(t.pick.invalid))
  }
}

/** An OAuth sign-in from the terminal: print the link, and take a pasted redirect when the callback cannot land. */
export async function login(call: Call, term: Terminal, id?: string): Promise<void> {
  const { logins } = await call<{ logins: LoginOption[] }>('GET', '/api/logins')
  let chosen = id
  if (!chosen) {
    const i = await choose(
      term,
      t.login.pick,
      logins.map((l) => `${l.name}${l.ready ? term.style.dim(` · ${t.login.ready}`) : ''}`),
    )
    chosen = logins[i]?.id
  }
  if (!chosen || !logins.some((l) => l.id === chosen))
    throw new Error(
      t.login.unknown(
        chosen ?? '',
        logins.map((l) => l.id),
      ),
    )

  let state = await call<LoginState>('POST', '/api/logins', { login: chosen })
  // Ctrl-C while waiting withdraws the sign-in on the server too, rather than leaving it polling there.
  const interrupted = new AbortController()
  const stopListening = term.onInterrupt(() => interrupted.abort())
  const stopped = new Promise<never>((_, reject) =>
    interrupted.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
  )
  stopped.catch(() => {})
  let shownUrl: string | undefined
  let progress: string | undefined
  // The question being asked, so the flow finishing on its own (a forwarded callback) can withdraw it.
  let asking: { message: string; abort: AbortController; answer: Promise<string> } | undefined
  try {
    for (;;) {
      if (state.url && state.url !== shownUrl) {
        shownUrl = state.url
        term.print()
        term.print(t.login.open)
        term.print(`  ${term.style.green(state.url)}`)
        if (state.instructions) term.print(`  ${state.instructions}`)
        // Only a loopback redirect strands the person on a dead page; device codes and pasted codes need no advice.
        const port = callbackPort(state.url)
        if (term.headless && port) {
          for (const line of t.login.headless) term.print(term.style.dim(line))
          term.print(term.style.dim(t.login.tunnel(port)))
        }
        term.print()
      }
      if (state.progress && state.progress !== progress) {
        progress = state.progress
        term.print(term.style.dim(progress))
      }
      if (state.status === 'done') {
        term.print(term.style.green(t.login.done(state.result?.email ?? state.result?.orgName)))
        return
      }
      if (state.status !== 'waiting') throw new Error(t.login.failed(state.error ?? state.status))
      if (state.prompt && asking?.message !== state.prompt.message) {
        asking?.abort.abort()
        const abort = new AbortController()
        const label = state.prompt.placeholder
          ? `${state.prompt.message} ${term.style.dim(`(${state.prompt.placeholder})`)}`
          : state.prompt.message
        asking = {
          message: state.prompt.message,
          abort,
          // Withdrawn when the flow moves on by itself, which is not an error; the person cancelling is.
          answer: term.ask(label, { signal: abort.signal }).catch((err) => {
            if (abort.signal.aborted) return ''
            throw err
          }),
        }
      }
      const tick = Bun.sleep(POLL_MS).then(() => undefined)
      const answered = await Promise.race([
        asking ? Promise.race([asking.answer.then((a) => a.trim()), tick]) : tick,
        stopped,
      ])
      if (answered) {
        asking = undefined
        state = await call<LoginState>('POST', `/api/logins/${state.id}`, { answer: answered })
      } else state = await call<LoginState>('GET', `/api/logins/${state.id}`)
    }
  } finally {
    stopListening()
    asking?.abort.abort()
    if (state.status === 'waiting') await call('DELETE', `/api/logins/${state.id}`).catch(() => {})
  }
}

/** The local port a sign-in redirects back to, when it uses a loopback callback that an SSH tunnel can carry. */
export function callbackPort(authUrl: string): string | undefined {
  try {
    const redirect = new URL(authUrl).searchParams.get('redirect_uri')
    if (!redirect) return undefined
    const back = new URL(redirect)
    return ['localhost', '127.0.0.1', '[::1]'].includes(back.hostname) && back.port ? back.port : undefined
  } catch {
    return undefined
  }
}

/** Tests one model through the server; never throws. */
async function probe(
  call: Call,
  ref: string,
): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  try {
    const r = await call<{ ok: boolean; ms?: number; error?: string }>('POST', '/api/models/test', { ref })
    return r.ok ? { ok: true, ms: r.ms ?? 0 } : { ok: false, error: r.error ?? 'no answer' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Stores an API key: piped on stdin for scripts, otherwise typed without echo; then tries it. */
export async function key(call: Call, term: Terminal, providerArg?: string): Promise<void> {
  let provider = providerArg
  if (!provider) {
    const { providers } = await call<{ providers: Provider[] }>('GET', '/api/settings')
    const builtIn = providers.filter((p) => !p.custom)
    const options = [
      ...builtIn.map((p) => `${p.id}${p.ready ? term.style.dim(' · ready') : ''}`),
      t.key.custom,
    ]
    const i = await choose(term, t.key.pick, options)
    provider = builtIn[i]?.id ?? (await term.ask(t.key.providerId)).trim()
  }
  const value = ((await term.piped()) ?? (await term.ask(t.key.enter(provider), { hidden: true }))).trim()
  if (!value) {
    term.print(term.style.yellow(t.key.empty))
    return
  }
  await call('PUT', `/api/credentials/${encodeURIComponent(provider)}`, { apiKey: value })
  term.print(term.style.green(t.key.saved(provider)))
  const { models } = await call<{ models: ModelEntry[] }>('GET', '/api/models')
  const sample = models.find((m) => m.provider === provider)
  if (!sample) {
    term.print(term.style.dim(t.key.noModel(provider)))
    return
  }
  term.print(term.style.dim(t.key.testing(sample.ref)))
  const r = await probe(call, sample.ref)
  if (r.ok) {
    term.print(term.style.green(t.model.works(r.ms)))
    return
  }
  term.print(term.style.red(t.model.fails(r.error)))
  term.print(t.key.kept(provider))
  process.exitCode = 1
}

/** Shows or sets the default model; a model is only saved once it answers. */
export async function model(call: Call, term: Terminal, refArg?: string): Promise<void> {
  const { models, defaults } = await call<{ models: ModelEntry[]; defaults?: { leadModel?: string } }>(
    'GET',
    '/api/models',
  )
  term.print(t.model.current(defaults?.leadModel))
  if (!models.length) {
    term.print(term.style.yellow(t.model.none))
    return
  }
  let ref = refArg
  if (ref && !models.some((m) => m.ref === ref)) throw new Error(t.model.unknown(ref))
  while (!ref) {
    const q = (await term.ask(t.pick.filter)).trim().toLowerCase()
    const matches = models.filter((m) => !q || `${m.ref} ${m.name}`.toLowerCase().includes(q))
    if (!matches.length) {
      term.print(term.style.yellow(t.pick.none(q)))
      continue
    }
    const shown = matches.slice(0, PICK_MAX)
    if (matches.length > PICK_MAX) term.print(term.style.dim(t.pick.more(matches.length - PICK_MAX)))
    const i = await choose(
      term,
      '',
      shown.map((m) => `${m.ref}${m.ref === defaults?.leadModel ? term.style.dim(' · default') : ''}`),
    )
    ref = shown[i]?.ref
  }
  term.print(term.style.dim(t.model.testing(ref)))
  const r = await probe(call, ref)
  if (!r.ok) {
    term.print(term.style.red(t.model.fails(r.error)))
    term.print(t.model.notSaved)
    process.exitCode = 1
    return
  }
  term.print(term.style.green(t.model.works(r.ms)))
  // Settings are saved whole; change only the lead model, which the workers and judge follow when unset.
  const { settings } = await call<{ settings: Settings }>('GET', '/api/settings')
  await call('PUT', '/api/settings', { ...settings, team: { ...settings.team, leadModel: ref } })
  term.print(term.style.green(t.model.saved(ref)))
}

/** One line of the doctor's report. */
interface Check {
  readonly ok: boolean
  readonly text: string
  readonly fix?: string
}

/** What the server says about itself, from server.json. */
export interface ServerInfo {
  readonly url: string
  readonly remote?: boolean
  readonly previewUrl?: string
}

/** Checks this machine and the running server, printing each with what to do about it. */
export async function doctor(
  call: Call | undefined,
  term: Terminal,
  local: { sandbox: Sandbox; scratch: string; server?: ServerInfo },
): Promise<number> {
  const checks: Check[] = []
  if (call && local.server) {
    checks.push({ ok: true, text: t.doctor.server.ok(local.server.url, Boolean(local.server.remote)) })
    const { models, defaults } = await call<{ models: ModelEntry[]; defaults?: { leadModel?: string } }>(
      'GET',
      '/api/models',
    )
    checks.push(
      models.length
        ? { ok: true, text: t.doctor.models.ok(models.length) }
        : { ok: false, text: t.doctor.models.none, fix: t.doctor.models.fix },
    )
    const ref = defaults?.leadModel
    if (!ref) checks.push({ ok: false, text: t.doctor.default.unset, fix: t.doctor.default.fix })
    else {
      const r = await probe(call, ref)
      checks.push(
        r.ok
          ? { ok: true, text: t.doctor.default.ok(ref, r.ms) }
          : { ok: false, text: t.doctor.default.fails(ref, r.error), fix: t.doctor.default.fix },
      )
    }
    if (local.server.remote) {
      checks.push(
        local.server.previewUrl
          ? { ok: true, text: t.doctor.previews.ok(local.server.previewUrl) }
          : { ok: false, text: t.doctor.previews.none, fix: t.doctor.previews.fix },
      )
      const { devices } = await call<{ devices: unknown[] }>('GET', '/api/devices')
      checks.push(
        devices.length
          ? { ok: true, text: t.doctor.devices.ok(devices.length) }
          : { ok: false, text: t.doctor.devices.none, fix: t.doctor.devices.fix },
      )
    }
    for (const c of (await listChannels(call)).filter((x) => x.configured && x.enabled)) {
      if (c.status.state !== 'on')
        checks.push({
          ok: false,
          text: t.doctor.channel.down(c.label, statusText(c.status)),
          fix: t.doctor.channel.fix(c.id),
        })
      else if (!c.people.length)
        checks.push({
          ok: false,
          text: t.doctor.channel.nobody(c.label),
          fix: t.doctor.channel.approveFix(c.id),
        })
      else checks.push({ ok: true, text: t.doctor.channel.ok(c.label, c.status.account, c.people.length) })
    }
    checks.push(await accessCheck(call))
  } else checks.push({ ok: false, text: t.doctor.server.none, fix: t.doctor.server.fix })

  checks.push(await sandboxCheck(local.sandbox, local.scratch))
  const chrome = findChrome()
  checks.push(
    chrome
      ? { ok: true, text: t.doctor.browser.ok(chrome) }
      : { ok: false, text: t.doctor.browser.none, fix: t.doctor.browser.fix },
  )

  term.print(term.style.bold(t.doctor.title))
  for (const c of checks) {
    term.print(`  ${c.ok ? term.style.green('✓') : term.style.yellow('!')} ${c.text}`)
    if (!c.ok && c.fix) term.print(`    ${term.style.dim(`→ ${c.fix}`)}`)
  }
  const problems = checks.filter((c) => !c.ok).length
  term.print(problems ? term.style.yellow(t.doctor.summary(problems)) : term.style.green(t.doctor.summary(0)))
  return problems
}

/** Whether agents run sandboxed or with full access: a choice the person made in Settings, said as it is. */
async function accessCheck(call: Call): Promise<Check> {
  const { projects, fullAccess } = await call<{
    projects: { name: string; permissions?: { preset?: string; mode?: string } }[]
    fullAccess?: boolean
  }>('GET', '/api/projects')
  if (fullAccess) return { ok: true, text: t.doctor.access.off }
  // `mode` is what a server from before the permission model sends.
  const full = projects
    .filter((p) => (p.permissions?.preset ?? p.permissions?.mode) === 'full')
    .map((p) => p.name)
  return { ok: true, text: full.length ? t.doctor.access.projects(full) : t.doctor.access.on }
}

/**
 * Runs a trivial command through the sandbox: bubblewrap can be installed yet blocked (Ubuntu 24.04's AppArmor
 * limits on user namespaces), which only shows when it runs.
 */
async function sandboxCheck(sandbox: Sandbox, scratch: string): Promise<Check> {
  const fix = process.platform === 'linux' ? t.doctor.sandbox.fixLinux : t.doctor.sandbox.fixOther
  if (sandbox.kind === 'none') return { ok: false, text: t.doctor.sandbox.none, fix }
  const r = await sandbox.run({ command: 'true', cwd: scratch, writable: [scratch], timeoutMs: 10_000 })
  if (r.code === 0) return { ok: true, text: t.doctor.sandbox.ok(sandbox.kind) }
  const why = (r.stderr.trim().split('\n').at(-1) ?? '') || `exit ${r.code}`
  return { ok: false, text: t.doctor.sandbox.broken(sandbox.kind, why), fix }
}

/** The whole first-run walk-through: checks, a way to reach a model, the default model, a first device. */
export async function setup(
  call: Call,
  term: Terminal,
  local: { sandbox: Sandbox; scratch: string; server: ServerInfo },
  pair: () => Promise<void>,
): Promise<void> {
  term.print(term.style.bold(t.wizard.title))
  // Questions with no one to answer them would hang (a script, a pipe): say how to script it instead.
  if (!term.interactive) {
    for (const line of t.wizard.notInteractive) term.print(line)
    process.exitCode = 1
    return
  }
  term.print()
  for (;;) {
    const { models } = await call<{ models: ModelEntry[] }>('GET', '/api/models')
    const options = [
      t.wizard.choices.login,
      t.wizard.choices.key,
      ...(models.length ? [t.wizard.choices.skip] : []),
    ]
    const i = await choose(
      term,
      models.length ? t.wizard.haveModels(models.length) : t.wizard.noModels,
      options,
    )
    if (i === 2) break
    try {
      await (i === 0 ? login(call, term) : key(call, term))
    } catch (err) {
      term.print(term.style.red(err instanceof Error ? err.message : String(err)))
    }
    term.print()
  }
  term.print()
  await model(call, term)
  if (local.server.remote) {
    const { devices } = await call<{ devices: unknown[] }>('GET', '/api/devices')
    if (!devices.length) {
      term.print()
      const yes = await choose(term, t.wizard.pairNow, [t.wizard.yes, t.wizard.no])
      if (yes === 0) await pair()
    }
  }
  term.print()
  await doctor(call, term, local)
  term.print()
  term.print(t.wizard.done)
}
