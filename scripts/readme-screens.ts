#!/usr/bin/env bun
/**
 * Retakes the README screenshots and demo GIF in docs/assets: `bun scripts/readme-screens.ts`.
 *
 * Everything runs offline against a throwaway data folder and a throwaway HOME (deleted at the end), so no account,
 * key, chat or path of the person running it can show. Every model is one of omp's scripted mock models, so no
 * provider is called and nothing is spent. Chrome runs headless. Needs ffmpeg on PATH for demo.gif / demo.mp4.
 *
 * Flags: --only home,chat,… to retake some shots; --no-gif to skip the recording; --keep to keep the temp folder.
 */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context as Ctx } from '../packages/runtime/src/omp/ai.ts'

const ROOT = process.env.MYR_SCREENS_ROOT

if (!ROOT) {
  // The capture runs in a child whose HOME is an empty folder: omp would otherwise find the person's cloud
  // credentials (~/.aws, gcloud) and Myrmidon their Claude Code and Codex sessions.
  const root = mkdtempSync(join(tmpdir(), 'myr-screens-'))
  const home = join(root, 'home', 'robin')
  // The agents' sandbox runs toolchains from the home folder only, so bun gets a copy there for the crew's tests.
  const bunBin = join(home, '.bun', 'bin')
  mkdirSync(bunBin, { recursive: true })
  try {
    linkSync(process.execPath, join(bunBin, 'bun'))
  } catch {
    copyFileSync(process.execPath, join(bunBin, 'bun'))
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !/KEY|TOKEN|SECRET|PASSWORD|AWS|GOOGLE|GEMINI|AZURE|OPENAI|ANTHROPIC|BAGGAGE/i.test(k)
    )
      env[k] = v
  const child = Bun.spawn([process.execPath, import.meta.path, ...Bun.argv.slice(2)], {
    env: {
      ...env,
      HOME: home,
      USER: 'robin',
      PATH: `${bunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      MYR_SCREENS_ROOT: root,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  if (Bun.argv.includes('--keep')) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true })
  process.exit(code)
} else {
  await capture(ROOT)
}

async function capture(root: string) {
  const repo = join(import.meta.dir, '..')
  const out = join(repo, 'docs', 'assets')
  // Under the throwaway HOME, so Settings shows its folders as ~/.myrmidon.
  const home = join(homedir(), '.myrmidon')
  const { pointOmpAt } = await import('../packages/runtime/src/omp/runtime.ts')
  pointOmpAt(home)
  const rt = await import('../packages/runtime/src/index.ts')
  const { createMockModel } = await import('../packages/runtime/src/omp/mock.ts')
  const { startServer } = await import('../apps/web/src/server.ts')
  const debug = Bun.argv.includes('--debug')

  const runtime = await rt.bootRuntime(home)
  const settings = new rt.SettingsStore(home)
  const realOmp = await rt.bootOmp(home)

  // ---------- models: real catalog entries, answered by scripted mocks ----------
  const SHOWN = [
    'anthropic/claude-opus-5-5',
    'anthropic/claude-sonnet-5-5',
    'anthropic/claude-haiku-5-5',
    'openai/gpt-5.6',
    'openai/gpt-5.5-pro',
    'openai/gpt-5.3-codex',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3.8-flash',
    'xai/grok-4.7',
    'deepseek/deepseek-v4-pro',
    'mistral/mistral-large-4',
  ]
  const REQUEST = 'Build a playable snake game with a leaderboard and tests'
  /** Where the scripted round is, for the capture to time its clicks. */
  const progress = { parallel: false, browsing: false, answered: false }
  const LEAD = 'anthropic/claude-sonnet-5-5'
  const CODER = 'openai/gpt-5.6'
  const TESTER = 'google/gemini-3.1-pro-preview'
  const JUDGE = 'anthropic/claude-opus-5-5'
  const catalog = SHOWN.map((ref) => {
    const [provider = '', id = ''] = ref.split('/')
    const model = realOmp.find(provider, id)
    if (!model) throw new Error(`${ref} is not in omp's catalog any more; pick another model`)
    return model
  })
  const providerIds = new Set(catalog.map((m) => m.provider))
  const now = Date.now()
  const omp = new Proxy(realOmp, {
    get(target, key, receiver) {
      switch (key) {
        case 'available':
          return () => catalog
        case 'defaultModel':
          return () => LEAD
        case 'apiKey':
          return async (m: { provider: string; api?: string }) => (m.api === 'mock' ? 'mock' : undefined)
        case 'providers':
          return () =>
            target.providers().map((p) =>
              providerIds.has(p.id)
                ? {
                    ...p,
                    ready: true,
                    stored: true,
                    hasKey: true,
                    models: catalog.filter((m) => m.provider === p.id).length,
                  }
                : p,
            )
        case 'logins':
          return () =>
            target
              .logins()
              .map((l) =>
                l.id === 'anthropic' || l.id === 'openai-codex' ? { ...l, ready: true, signedIn: true } : l,
              )
        case 'quota':
          return {
            read: async () => ({
              fetchedAt: now,
              accounts: [
                {
                  provider: 'anthropic',
                  account: 'robin@example.com',
                  plan: 'max',
                  status: 'ok',
                  windows: [
                    {
                      id: 'anthropic:5h',
                      label: 'Claude 5 Hour',
                      usedPercent: 34,
                      resetsAt: now + 2.6 * 3600e3,
                      status: 'ok',
                    },
                    {
                      id: 'anthropic:7d',
                      label: 'Claude Weekly',
                      usedPercent: 58,
                      resetsAt: now + 3.2 * 86400e3,
                      status: 'ok',
                    },
                  ],
                },
                {
                  provider: 'openai',
                  account: 'robin@example.com',
                  plan: 'pro',
                  status: 'ok',
                  windows: [
                    {
                      id: 'openai:5h',
                      label: 'Codex 5 Hour',
                      usedPercent: 12,
                      resetsAt: now + 4.1 * 3600e3,
                      status: 'ok',
                    },
                    {
                      id: 'openai:7d',
                      label: 'Codex Weekly',
                      usedPercent: 27,
                      resetsAt: now + 5 * 86400e3,
                      status: 'ok',
                    },
                  ],
                },
              ],
            }),
          }
        default: {
          const v = Reflect.get(target, key, receiver)
          return typeof v === 'function' ? v.bind(target) : v
        }
      }
    },
  }) as typeof realOmp

  // Windows from omp's catalog only: ContextWindows.load() would fetch models.dev.
  const resolver = new rt.ModelResolver(omp, new rt.ContextWindows())
  for (const m of catalog) {
    const ref = `${m.provider}/${m.id}`
    const mock = createMockModel({
      id: m.id,
      provider: m.provider,
      cost: m.cost,
      contextWindow: m.contextWindow ?? undefined,
      handler: (ctx: Ctx) => {
        const reply = route(ref, ctx)
        // Tokens and cost as the real model would count them, roughly: four characters a token at its list price.
        const input = Math.round(JSON.stringify([ctx.systemPrompt, ctx.messages, ctx.tools]).length / 4)
        const output = Math.round(JSON.stringify(reply.content).length / 4) + 60
        const cost = { input: (input * m.cost.input) / 1e6, output: (output * m.cost.output) / 1e6 }
        return { ...reply, usage: { input, output, totalTokens: input + output, cost } }
      },
    })
    resolver.register(ref, { model: { ...m, ...{ api: 'mock' } } as never, streamFn: mock.stream })
  }

  let calls = 0
  function route(ref: string, ctx: Ctx) {
    const system = Array.isArray(ctx.systemPrompt)
      ? ctx.systemPrompt.join('\n')
      : String(ctx.systemPrompt ?? '')
    const tools = (ctx.tools ?? []).map((t) => t.name)
    if (debug) {
      Bun.write(
        join(root, `call-${String(++calls).padStart(3, '0')}-${ref.replace('/', '_')}.json`),
        JSON.stringify({ system, tools: ctx.tools, messages: ctx.messages }, null, 1),
      )
      const last = ctx.messages.at(-1)
      console.log(
        `\n[model ${ref}] tools=${tools.length} msgs=${ctx.messages.length}\n  system: ${system.slice(0, 300).replace(/\n/g, ' ⏎ ')}\n  last: ${JSON.stringify(last).slice(0, 400)}`,
      )
    }
    const turns = ctx.messages.filter((m) => m.role === 'assistant').length
    if (system.startsWith('You name conversations'))
      return { content: ['{"title": "Snake game with leaderboard"}'] }
    if (ref === LEAD && tools.includes('escalate')) {
      if (turns > 0) return { content: [] }
      return {
        delayMs: 1600,
        content: [
          tool('reply_user', {
            text: "Fun one. It splits cleanly into a game engine, a playable page, a leaderboard and tests, so I'm bringing in the crew to build them in parallel.",
          }),
          tool('escalate', {
            to: 'team',
            reason:
              'Engine, page, leaderboard and tests are independent pieces a crew can build in parallel.',
          }),
        ],
      }
    }
    const coder = /- (\w+): coder/.exec(system)?.[1] ?? 'coder'
    const tester = /- (\w+): tester/.exec(system)?.[1] ?? 'tester'
    const called = (name: string) =>
      ctx.messages.some(
        (m) => m.role === 'assistant' && m.content.some((c) => c.type === 'toolCall' && c.name === name),
      )
    if (ref === LEAD && !called('create_task'))
      return {
        delayMs: 1500,
        content: [
          tool('append_note', {
            section: 'plan',
            text: `${coder} builds the engine (snake.js, leaderboard.js), then the page (index.html); ${tester} tests the engine, then play-tests the page in a real browser. I review and ship.`,
          }),
          tool('create_task', {
            subject: 'Build the game engine and leaderboard',
            description:
              'Goal: the rules of Snake as plain functions, so the page and the tests share them.\nContext: a fresh folder; no framework, ES modules.\nDeliverable: snake.js (createGame, turn, step, tickMs) and leaderboard.js (top five in localStorage).\nApproach: pure functions, no DOM; buffer two quick turns; ignore reversals.\nDone when: both modules load in bun and the page can import them.\nNot yours: index.html (task-3), tests (task-2).',
            assignee: coder,
            outputs: ['snake.js', 'leaderboard.js'],
          }),
          tool('create_task', {
            subject: 'Write tests for the engine and leaderboard',
            description:
              'Goal: prove the rules hold.\nContext: snake.js and leaderboard.js from task-1.\nDeliverable: snake.test.js and leaderboard.test.js (bun test).\nApproach: drive the game tick by tick with a fixed rng.\nDone when: movement, eating, walls, self-bites, turn buffering and the top-five board are covered and pass.\nNot yours: the page.',
            assignee: tester,
            outputs: ['snake.test.js', 'leaderboard.test.js'],
            blockedBy: ['task-1'],
          }),
          tool('create_task', {
            subject: 'Build the playable page',
            description:
              'Goal: a page Robin can open and play.\nContext: import snake.js and leaderboard.js from task-1.\nDeliverable: index.html: canvas, score and best, leaderboard panel, arrow keys and WASD, space to pause, an attract mode while idle.\nDone when: it plays in a browser with no console errors.\nNot yours: tests.',
            assignee: coder,
            outputs: ['index.html'],
            blockedBy: ['task-1'],
          }),
          tool('create_task', {
            subject: 'Play-test the page in a real browser',
            description:
              'Goal: catch what unit tests miss.\nContext: index.html from task-3.\nDeliverable: a note with what you tried and saw.\nApproach: browser_open("artifact:index.html"), play with the arrow keys, read the console with browser_debug, take a screenshot.\nDone when: a game starts, the score counts up, and the console is clean.',
            assignee: tester,
            blockedBy: ['task-3'],
          }),
        ],
      }
    if (ref === CODER || ref === TESTER) return worker(ref === CODER ? 'coder' : 'tester', ctx)
    if (system.includes('strict, independent reviewer'))
      return {
        delayMs: 1800,
        content: [
          JSON.stringify({
            score: 0.94,
            reasons:
              'Playable and tested: the engine is pure and covered by 11 passing bun tests, the page imports it, and the play-test saw a clean console.',
            findings: [
              {
                severity: 'minor',
                where: 'index.html',
                what: 'No touch controls yet, so it is keyboard-only on phones.',
              },
            ],
          }),
        ],
      }
    if (ref === LEAD) {
      const last = ctx.messages.at(-1)
      const said = last ? JSON.stringify(last.content) : ''
      if (last?.role === 'toolResult' && last.toolName === 'request_review') {
        setTimeout(() => {
          progress.answered = true
        }, 2500)
        return {
          delayMs: 1400,
          content: [
            tool('reply_user', {
              final: true,
              text: [
                'Your snake game is ready: open **index.html** and press an arrow key to play. Until you do, it plays itself.',
                '',
                '- `snake.js` holds the rules (moving, eating, walls, turn buffering), kept pure so they can be tested',
                '- `leaderboard.js` keeps your top five scores in the browser, so they survive a reload',
                '- `snake.test.js` and `leaderboard.test.js`: 11 tests, all passing with `bun test`',
                '',
                `${tester} also play-tested it in Chrome: a game starts, the score counts and the console is clean. It is keyboard-only for now; touch controls would be the next step.`,
              ].join('\n'),
            }),
          ],
        }
      }
      if (said.includes('Open tasks: none') && !called('request_review'))
        return {
          delayMs: 1200,
          content: [
            tool('request_review', {
              summary:
                'Snake game: snake.js and leaderboard.js (engine), index.html (page), snake.test.js and leaderboard.test.js (11 bun tests, passing); play-tested in Chrome by the tester.',
            }),
          ],
        }
      const verdict = /\[verdict\] (task-\d+)/.exec(said)?.[1]
      if (verdict === 'task-1')
        return { delayMs: 900, content: [tool('read_artifact', { name: 'snake.js' })] }
      if (verdict === 'task-3')
        return { delayMs: 900, content: [tool('read_artifact', { name: 'index.html' })] }
      return { delayMs: 600, content: [] }
    }
    return { content: ['ok'] }
  }

  /** A crewmate works through the steps of the task it was given last, one step per call. */
  function worker(role: 'coder' | 'tester', ctx: Ctx) {
    const text = (m: Ctx['messages'][number]) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    let at = -1
    for (let i = ctx.messages.length - 1; i >= 0 && at < 0; i--) {
      const m = ctx.messages[i]
      if (m?.role === 'user' && /\[task\] Task task-\d+ r\d+ is yours/.test(text(m))) at = i
    }
    const given = at >= 0 ? /Task (task-\d+) r(\d+)/.exec(text(ctx.messages[at] as never)) : null
    if (!given) return { content: ['Nothing assigned to me yet.'] }
    const id = given[1] as string
    const since = ctx.messages.slice(at + 1)
    const step = since.filter((m) => m.role === 'assistant').length
    const claimed = since.find((m) => m.role === 'toolResult' && m.toolName === 'claim_task')
    const rev = Number(/ r(\d+)/.exec(claimed ? text(claimed as never) : '')?.[1] ?? Number(given[2]) + 1)
    const files = gameFiles()
    const write = (path: string) => tool('fs_write', { path, content: files[path] })
    const publish = (...names: string[]) =>
      names.map((name) => tool('publish_artifact', { name, fromScratch: name }))
    const steps: Record<string, unknown[][]> = {
      'coder:task-1': [
        [
          'Starting on the engine: pure functions, so the page and the tests share one set of rules.',
          tool('claim_task', { id, revision: Number(given[2]) }),
        ],
        [write('snake.js')],
        [write('leaderboard.js')],
        [
          tool('shell', {
            command:
              "bun -e \"for (const f of ['./snake.js', './leaderboard.js']) console.log(f, Object.keys(await import(f)).join(', '))\"",
          }),
        ],
        publish('snake.js', 'leaderboard.js'),
        [tool('submit_task', { id, revision: rev, artifacts: ['snake.js', 'leaderboard.js'] })],
        ['Engine and leaderboard are published.'],
      ],
      'coder:task-3': [
        [tool('claim_task', { id, revision: Number(given[2]) })],
        [
          'Building the page on the engine: canvas board, score and best, leaderboard panel, and an autopilot while idle.',
          write('index.html'),
        ],
        publish('index.html'),
        [tool('submit_task', { id, revision: rev, artifacts: ['index.html'] })],
        ['index.html is up.'],
      ],
      'tester:task-2': [
        [tool('claim_task', { id, revision: Number(given[2]) })],
        [write('snake.test.js'), write('leaderboard.test.js')],
        [
          tool('shell', {
            command:
              'cp "$MYR_MIRROR/artifacts/snake.js" "$MYR_MIRROR/artifacts/leaderboard.js" . && bun test 2>&1',
          }),
        ],
        publish('snake.test.js', 'leaderboard.test.js'),
        [tool('submit_task', { id, revision: rev, artifacts: ['snake.test.js', 'leaderboard.test.js'] })],
        ['11 tests, all passing.'],
      ],
      'tester:task-4': [
        [tool('claim_task', { id, revision: Number(given[2]) }), tool('find_tools', { query: 'browser' })],
        [tool('browser_open', { url: 'artifact:index.html' })],
        [tool('browser_act', { steps: [{ press: 'ArrowUp' }] })],
        [tool('browser_act', { steps: [{ press: 'ArrowLeft' }] })],
        [tool('browser_screenshot', {}), tool('browser_debug', { kind: 'console' })],
        [
          tool('append_note', {
            section: 'finding',
            text: 'Play-tested index.html in Chrome: the attract mode runs, an arrow key starts a game, the snake turns and the score counts; the console is clean.',
          }),
          tool('submit_task', { id, revision: rev, artifacts: [] }),
        ],
        ['Play-test passed.'],
      ],
    }
    const plan = steps[`${role}:${id}`] ?? []
    const browsing = role === 'tester' && id === 'task-4'
    if (browsing && step === 1) progress.browsing = true
    if (role === 'coder' && id === 'task-3' && step === 1) progress.parallel = true
    // The play-test goes slower, so the live browser view has something to show.
    const delayMs = browsing && step > 0 ? 2600 : 900 + ((step * 337) % 900)
    return { delayMs, content: (plan[step] ?? []) as never }
  }

  function tool(name: string, args: Record<string, unknown>) {
    return { type: 'toolCall' as const, name, arguments: args }
  }

  // ---------- settings: Robin, the crew, setup half done ----------
  const base = settings.get()
  settings.set({
    ...base,
    profile: { ...base.profile, name: 'Robin', greeting: 'rules', titles: 'model' },
    mascot: {
      ...base.mascot,
      color: 'amber',
      screen: 'name',
      crew: { ...base.mascot.crew, show: true, count: 3, names: 'custom', custom: ['kai', 'nova', 'judge'] },
    },
    setup: { steps: {} },
    memory: { suggest: false },
    team: { ...base.team, leadModel: LEAD, judgeModel: JUDGE, workerModel: CODER },
    composer: {
      mode: 'orchestrated',
      leadModel: LEAD,
      judgeModel: JUDGE,
      roster: [
        { role: 'coder', model: CODER },
        { role: 'tester', model: TESTER },
      ],
      extraWorkers: 0,
    },
  })

  // ---------- a few skills of Robin's, so Settings → Skills has something to list ----------
  const SKILLS: [dir: string, name: string, description: string][] = [
    [
      join(homedir(), '.claude', 'skills'),
      'frontend-design',
      'Distinctive, production-grade web pages: type scale, colour, spacing and motion that do not look generated.',
    ],
    [
      join(homedir(), '.claude', 'skills'),
      'release-notes',
      'Turn merged pull requests into release notes grouped by user impact, with breaking changes first.',
    ],
    [
      join(home, 'skills'),
      'browser-play-test',
      'Open a built page in the browser, play its main loop with the keyboard, and report console errors with a screenshot.',
    ],
    [
      join(home, 'skills'),
      'bun-test-first',
      'Write bun tests for pure modules before the UI: fixed RNG, one behaviour per test, run them before submitting.',
    ],
  ]
  for (const [dir, name, description] of SKILLS) {
    mkdirSync(join(dir, name), { recursive: true })
    await Bun.write(
      join(dir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${description}\n`,
    )
  }

  // ---------- the server, as `myrmidon serve` wires it ----------
  const plugins = new rt.PluginStore(home)
  const pluginHost = new rt.PluginHost(plugins)
  const mcp = new rt.McpHub(omp.agentDir, () => plugins.mcpServers())
  const browser = new rt.BrowserHub(join(home, 'browser'))
  const projects = new rt.ProjectStore(home)
  const specialists = new rt.SpecialistStore(home)
  const skillProposals = new rt.SkillProposalStore(home)
  const library = new rt.ToolLibrary(join(home, 'tools'))
  const memory = new rt.MemoryStore(home)
  const skills = new rt.SkillLibrary(home, undefined, () => plugins.skillRoots())
  const hooks = new rt.HookStore(home, () => plugins.hooks())
  const rules = new rt.StreamRuleStore(home)
  const checkpoints = new rt.Checkpoints(join(home, 'checkpoints'))
  const shelf = new rt.ChatShelf(home)
  const imports = new rt.SessionImports(home, { projects })
  const chats = new rt.ChatService(runtime, {
    resolver,
    shelf,
    imports,
    settings,
    mcp,
    browser,
    projects,
    specialists,
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
    port: 0,
    chats,
    settings,
    resolver,
    omp,
    mcp,
    browser,
    projects,
    specialists,
    skillProposals,
    library,
    memory,
    skills,
    hooks,
    plugins,
    pluginHost,
    schedules: new rt.ScheduleStore(home),
    shelf,
    imports,
    sandboxKind: rt.detectSandbox().kind,
  })
  console.log(`Myrmidon (scripted models) at ${server.url.replace(/#.*$/, '')}`)

  // ---------- headless Chrome ----------
  // puppeteer-core is the runtime package's dependency (its BrowserHub), not the workspace root's.
  const puppeteer = await import('../packages/runtime/node_modules/puppeteer-core')
  const chrome = rt.findChrome()
  if (!chrome) throw new Error('no Chrome found; set MYR_CHROME')
  const shooter = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: join(root, 'chrome'),
    args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  })
  try {
    const page = await shooter.newPage()
    page.on('pageerror', (err) => console.error('page error:', err))
    const shots = Bun.argv
      .find((a) => a.startsWith('--only='))
      ?.slice(7)
      .split(',')
    const shot = async (name: string) => {
      if (shots && !shots.includes(name.replace(/(-dark|-light)?\.png$/, ''))) return
      await Bun.sleep(400)
      // A real install shows the person's own home here, so the throwaway one reads as Robin's.
      await page.evaluate((from) => {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let n = walk.nextNode(); n; n = walk.nextNode())
          if (n.textContent?.includes(from)) n.textContent = n.textContent.replaceAll(from, '/Users/robin')
      }, homedir())
      await page.screenshot({ path: join(out, name) })
      console.log(`  ${name}`)
    }
    /** Whether an element's label, title or text starts with `text`; clicks the first such one when `press`. */
    const find = (text: string, press: boolean, selector = 'button, [role=button], [role=tab], a') =>
      page.evaluate(
        (t, s, p) => {
          const el = [...document.querySelectorAll<HTMLElement>(s)].find((b) =>
            [b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent?.trim()].some((v) =>
              v?.startsWith(t),
            ),
          )
          if (p) el?.click()
          return !!el
        },
        text,
        selector,
        press,
      )
    const click = async (text: string, selector?: string) => {
      if (!(await find(text, true, selector))) throw new Error(`nothing to click labelled "${text}"`)
      await Bun.sleep(700)
    }
    const theme = async (look: 'dark' | 'light') => {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: look }])
      await page.evaluate((l) => localStorage.setItem('myr-theme', l), look)
    }
    const until = async (done: () => boolean, ms = 90_000) => {
      for (const start = Date.now(); !done(); await Bun.sleep(100))
        if (Date.now() - start > ms) throw new Error('the scripted round took too long')
    }

    // ----- setup assistant, as a first run meets it -----
    await page.goto(server.url, { waitUntil: 'networkidle2' })
    await theme('dark')
    await page.reload({ waitUntil: 'networkidle2' })
    await Bun.sleep(2500)
    await shot('setup-dark.png')
    await click('Finish later')
    // The home screen's Finish setting up card, hidden for good the way its own button does it.
    const api = (path: string, method: string, body: unknown) =>
      fetch(new URL(path, server.url.replace(/#.*$/, '')), {
        method,
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    await api('/api/setup', 'PUT', { dismiss: true })
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('textarea', { timeout: 15_000 })
    await Bun.sleep(2500)

    // ----- the demo round, recorded -----
    const frames: { at: number; file: string }[] = []
    const cdp = await page.createCDPSession()
    const record = !Bun.argv.includes('--no-gif')
    mkdirSync(join(root, 'frames'), { recursive: true })
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      const file = join(root, 'frames', `${String(frames.length).padStart(5, '0')}.jpg`)
      frames.push({ at: Date.now(), file })
      void Bun.write(file, Buffer.from(f.data, 'base64'))
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    if (record)
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1440, maxHeight: 900 })
    await Bun.sleep(1500)
    await page.click('textarea')
    await page.keyboard.type(REQUEST, { delay: 32 })
    await Bun.sleep(500)
    await page.keyboard.press('Enter')
    await until(() => progress.parallel)
    // The tasks panel opens by itself once there are tasks; the rail button would close it again.
    if (!(await find('Board', false))) await click('Tasks, ')
    await click('Board')
    await Bun.sleep(900)
    await shot('tasks-dark.png')
    await until(() => progress.browsing)
    await Bun.sleep(1800)
    await click('Computer')
    for (let i = 0; i < 50 && !(await find('Full screen', false)); i++) await Bun.sleep(200)
    await click('Full screen')
    await Bun.sleep(2600)
    await shot('browser-dark.png')
    await Bun.sleep(1500)
    await click('Exit full screen')
    await until(() => progress.answered)
    await click('Tasks, ')
    await click('List')
    await Bun.sleep(3500)
    await click('index.html')
    await Bun.sleep(5000)
    const recorded = Date.now()
    if (record) await cdp.send('Page.stopScreencast')

    // ----- the finished chat -----
    // Robin has played a few rounds since, so the preview shows a leaderboard.
    const game = page.frames().find((f) => f.url().includes('index.html'))
    if (!game)
      throw new Error(
        `no game frame among ${page
          .frames()
          .map((f) => f.url())
          .join(', ')}`,
      )
    await game.evaluate(() => {
      const at = Date.now()
      const scores = [
        ['Robin', 42],
        ['Sam', 35],
        ['Robin', 31],
        ['Riley', 24],
        ['Robin', 17],
      ] as const
      localStorage.setItem(
        'snake.leaderboard',
        JSON.stringify(scores.map(([name, score], i) => ({ name, score, at: at + i }))),
      )
      location.reload()
    })
    // Long enough for the attract-mode snake to grow a little.
    await Bun.sleep(9000)
    await shot('preview-dark.png')
    await page.keyboard.press('Escape')
    await Bun.sleep(600)
    await click('Crew, ')
    await shot('chat-dark.png')
    await click('This chat’s crew')
    await Bun.sleep(1200)
    await shot('crew-dark.png')
    await page.keyboard.press('Escape')
    await Bun.sleep(600)
    await click('Close panel')
    await page.keyboard.down('Meta')
    await page.keyboard.press('k')
    await page.keyboard.up('Meta')
    await Bun.sleep(800)
    await shot('command-dark.png')
    await page.keyboard.press('Escape')

    // ----- settings -----
    await click('Settings')
    await click('Channels')
    await shot('channels-dark.png')
    await click('Skills')
    await shot('skills-dark.png')
    await page.keyboard.press('Escape')

    // ----- home, dark and light -----
    await click('New chat')
    await Bun.sleep(1500)
    await shot('home-dark.png')
    await click('Lead', 'button[title]')
    await shot('models-dark.png')
    await page.keyboard.press('Escape')
    await theme('light')
    await page.reload({ waitUntil: 'networkidle2' })
    await Bun.sleep(2500)
    await shot('home-light.png')

    if (!shots || shots.includes('social-preview')) await socialCard()
    if (record) await gif(frames.filter((f) => f.at <= recorded))
  } finally {
    await shooter.close()
    await chats.stopAll()
    await browser.close().catch(() => {})
    await mcp.close().catch(() => {})
    await server.stop()
    await runtime.dispose()
  }

  /** GitHub's 1280×640 social card: the name and pitch beside the finished chat, framed as a window. */
  async function socialCard() {
    const png = async (path: string) =>
      `data:image/png;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64')}`
    const icon = `data:image/svg+xml;base64,${Buffer.from(await Bun.file(join(repo, 'apps/web/src/client/icon.svg')).text()).toString('base64')}`
    const card = await shooter.newPage()
    await card.setViewport({ width: 1280, height: 640, deviceScaleFactor: 1 })
    await card.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box; margin: 0; }
      body { width: 1280px; height: 640px; overflow: hidden; background: #0b0c0f; color: #f4f4f5;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif; position: relative; }
      .dots { position: absolute; inset: 0; background-image: radial-gradient(rgb(255 255 255 / .07) 1px, transparent 1px); background-size: 22px 22px; }
      .glow { position: absolute; width: 760px; height: 760px; left: -180px; top: -60px; background: radial-gradient(closest-side, rgb(255 179 26 / .16), transparent); }
      .glow.two { left: 640px; top: 120px; background: radial-gradient(closest-side, rgb(163 230 53 / .10), transparent); }
      .text { position: absolute; left: 72px; top: 0; bottom: 0; width: 470px; display: flex; flex-direction: column; justify-content: center; gap: 18px; }
      .brand { display: flex; align-items: center; gap: 18px; }
      .brand img { width: 72px; height: 72px; border-radius: 18px; box-shadow: 0 10px 40px rgb(255 179 26 / .25); }
      h1 { font-size: 68px; font-weight: 750; letter-spacing: -0.035em; }
      .pitch { font-size: 30px; line-height: 1.22; font-weight: 600; color: #e4e4e7; letter-spacing: -0.015em; }
      .pitch b { color: #ffb31a; font-weight: 650; }
      .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
      .tags span { padding: 6px 12px; border-radius: 999px; border: 1px solid rgb(255 255 255 / .12); background: rgb(255 255 255 / .04); color: #a1a1aa; font-size: 15px; font-weight: 500; }
      .shot { position: absolute; left: 590px; top: 70px; width: 980px; height: 612px; border-radius: 16px; overflow: hidden;
        border: 1px solid rgb(255 255 255 / .14); box-shadow: 0 40px 120px rgb(0 0 0 / .7), 0 0 0 8px rgb(255 255 255 / .025);
        background: url('${await png(join(out, 'chat-dark.png'))}') no-repeat; background-size: 1152px 720px; background-position: -300px 0; }
    </style></head><body>
      <div class="dots"></div><div class="glow"></div><div class="glow two"></div>
      <div class="text">
        <div class="brand"><img src="${icon}" alt=""><h1>Myrmidon</h1></div>
        <p class="pitch">One chat. <b>A whole crew of AI agents</b> behind it.</p>
        <div class="tags"><span>Local-first</span><span>Any model</span><span>Crews that review their work</span><span>Browser agent</span><span>Chat apps</span><span>Voice</span></div>
      </div>
      <div class="shot"></div>
    </body></html>`)
    await Bun.sleep(500)
    await card.screenshot({ path: join(out, 'social-preview.png') })
    await card.close()
    console.log('  social-preview.png')
  }

  /** demo.gif and demo.mp4 from the recorded frames, sped up so the round fits in about 20 seconds. */
  async function gif(frames: { at: number; file: string }[]) {
    if (!Bun.which('ffmpeg')) return console.log('ffmpeg not found: skipping demo.gif and demo.mp4')
    const first = frames[0]?.at ?? 0
    const total = (frames.at(-1)?.at ?? first) - first
    const speed = Math.max(1, total / 22_000)
    const list = frames
      .map(
        (f, i) =>
          `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 1500) - f.at) / 1000 / speed).toFixed(3)}`,
      )
      .join('\n')
    await Bun.write(join(root, 'frames.txt'), `${list}\nfile '${frames.at(-1)?.file}'\n`)
    const ff = (...args: string[]) => {
      const run = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', ...args])
      if (run.exitCode !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`)
    }
    const input = ['-f', 'concat', '-safe', '0', '-i', join(root, 'frames.txt')]
    ff(
      ...input,
      '-vf',
      'fps=30,scale=1440:-2:flags=lanczos,format=yuv420p',
      '-c:v',
      'libx264',
      '-crf',
      '24',
      '-preset',
      'slow',
      '-movflags',
      '+faststart',
      join(out, 'demo.mp4'),
    )
    ff(
      ...input,
      '-vf',
      'fps=12,scale=1200:-1:flags=lanczos,palettegen=max_colors=200:stats_mode=diff',
      join(root, 'palette.png'),
    )
    ff(
      ...input,
      '-i',
      join(root, 'palette.png'),
      '-lavfi',
      'fps=12,scale=1200:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      '-loop',
      '0',
      join(out, 'demo.gif'),
    )
    console.log(`  demo.gif, demo.mp4 (${(total / 1000).toFixed(0)}s recorded, ${speed.toFixed(1)}x)`)
  }
}

/** The game the crew builds: real files, written, published and tested during the scripted round. */
function gameFiles(): Record<string, string> {
  return {
    'snake.js': `// Snake rules with no DOM, so the tests can drive them tick by tick.
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' }

export function createGame({ cols = 20, rows = 20, rng = Math.random } = {}) {
  const x = Math.floor(cols / 2)
  const y = Math.floor(rows / 2)
  const game = { cols, rows, rng, dir: 'right', queued: [], score: 0, over: false }
  game.snake = [
    [x, y],
    [x - 1, y],
    [x - 2, y],
  ]
  game.food = spawnFood(game)
  return game
}

export function spawnFood(game) {
  const free = []
  for (let y = 0; y < game.rows; y++)
    for (let x = 0; x < game.cols; x++)
      if (!game.snake.some(([sx, sy]) => sx === x && sy === y)) free.push([x, y])
  return free.length ? free[Math.floor(game.rng() * free.length)] : null
}

// Up to two turns are buffered, so a quick "up, left" is not lost between ticks; reversing is ignored.
export function turn(game, dir) {
  const last = game.queued.at(-1) ?? game.dir
  if (DIRS[dir] && dir !== last && dir !== OPPOSITE[last] && game.queued.length < 2) game.queued.push(dir)
}

export function step(game) {
  if (game.over) return game
  if (game.queued.length) game.dir = game.queued.shift()
  const [dx, dy] = DIRS[game.dir]
  const head = [game.snake[0][0] + dx, game.snake[0][1] + dy]
  const eats = game.food && head[0] === game.food[0] && head[1] === game.food[1]
  // The tail moves out of the way this tick unless the snake grows.
  const body = eats ? game.snake : game.snake.slice(0, -1)
  const outside = head[0] < 0 || head[1] < 0 || head[0] >= game.cols || head[1] >= game.rows
  if (outside || body.some(([x, y]) => x === head[0] && y === head[1])) {
    game.over = true
    return game
  }
  game.snake = [head, ...body]
  if (eats) {
    game.score += 1
    game.food = spawnFood(game)
  }
  return game
}

/** Milliseconds per tick: a little faster with every apple, never faster than 60. */
export const tickMs = (score) => Math.max(60, 140 - score * 4)
`,
    'leaderboard.js': `// The top five scores, kept in localStorage; pure functions so they test without a browser.
export const SIZE = 5
export const KEY = 'snake.leaderboard'

export function qualifies(board, score) {
  return score > 0 && (board.length < SIZE || score > board[board.length - 1].score)
}

export function addScore(board, entry) {
  const name = String(entry.name ?? '').trim().slice(0, 10) || 'Player'
  return [...board, { ...entry, name }].sort((a, b) => b.score - a.score || a.at - b.at).slice(0, SIZE)
}

export function load(storage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((e) => Number.isFinite(e?.score)).slice(0, SIZE) : []
  } catch {
    return []
  }
}

export function save(storage, board) {
  storage.setItem(KEY, JSON.stringify(board))
}
`,
    'snake.test.js': `import { describe, expect, test } from 'bun:test'
import { createGame, step, tickMs, turn } from './snake.js'

const fixed = () => 0

describe('snake', () => {
  test('moves one cell per tick', () => {
    const g = createGame({ rng: fixed })
    step(g)
    expect(g.snake[0]).toEqual([11, 10])
    expect(g.snake).toHaveLength(3)
  })

  test('grows and scores when it eats', () => {
    const g = createGame({ rng: fixed })
    g.food = [11, 10]
    step(g)
    expect(g.score).toBe(1)
    expect(g.snake).toHaveLength(4)
    expect(g.food).not.toEqual([11, 10])
  })

  test('ignores a reversal into itself', () => {
    const g = createGame({ rng: fixed })
    turn(g, 'left')
    step(g)
    expect(g.dir).toBe('right')
    expect(g.over).toBe(false)
  })

  test('buffers two quick turns', () => {
    const g = createGame({ rng: fixed })
    turn(g, 'up')
    turn(g, 'left')
    step(g)
    step(g)
    expect(g.snake[0]).toEqual([9, 9])
  })

  test('dies on a wall', () => {
    const g = createGame({ cols: 5, rows: 5, rng: fixed })
    for (let i = 0; i < 3; i++) step(g)
    expect(g.over).toBe(true)
  })

  test('dies when it bites itself', () => {
    const g = createGame({ rng: fixed })
    g.snake = [
      [5, 5],
      [6, 5],
      [6, 6],
      [5, 6],
      [4, 6],
    ]
    g.dir = 'down'
    step(g)
    expect(g.over).toBe(true)
  })

  test('speeds up but never past 60 ms', () => {
    expect(tickMs(0)).toBe(140)
    expect(tickMs(10)).toBe(100)
    expect(tickMs(99)).toBe(60)
  })
})
`,
    'leaderboard.test.js': `import { describe, expect, test } from 'bun:test'
import { addScore, KEY, load, qualifies, save } from './leaderboard.js'

const memory = () => {
  const data = new Map()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }
}

describe('leaderboard', () => {
  test('keeps the top five, highest first', () => {
    let board = []
    for (const [i, score] of [4, 9, 1, 7, 12, 3].entries()) board = addScore(board, { name: \`p\${i}\`, score, at: i })
    expect(board.map((e) => e.score)).toEqual([12, 9, 7, 4, 3])
  })

  test('an earlier score wins a tie', () => {
    const board = addScore(addScore([], { name: 'a', score: 5, at: 1 }), { name: 'b', score: 5, at: 2 })
    expect(board.map((e) => e.name)).toEqual(['a', 'b'])
  })

  test('only a score that beats the fifth qualifies', () => {
    const full = [9, 8, 7, 6, 5].map((score, at) => ({ name: 'x', score, at }))
    expect(qualifies(full, 5)).toBe(false)
    expect(qualifies(full, 6)).toBe(true)
    expect(qualifies([], 0)).toBe(false)
  })

  test('survives a reload, and ignores junk in storage', () => {
    const storage = memory()
    save(storage, [{ name: 'Robin', score: 21, at: 1 }])
    expect(load(storage)).toEqual([{ name: 'Robin', score: 21, at: 1 }])
    storage.setItem(KEY, '{not json')
    expect(load(storage)).toEqual([])
  })
})
`,
    'index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Snake</title>
<style>
  :root { --bg: #0a0c0f; --panel: #12161c; --line: #1e252e; --text: #e6edf3; --dim: #7d8794; --snake: #a3e635; --food: #fb7185; --gold: #fbbf24; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(1200px 600px at 50% -10%, #16202a 0%, var(--bg) 60%); color: var(--text); font: 15px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { display: grid; grid-template-columns: auto 250px; gap: 20px; align-items: start; padding: 20px; }
  header { grid-column: 1 / -1; display: flex; align-items: baseline; justify-content: space-between; }
  h1 { margin: 0; font: 700 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .3em; color: var(--snake); text-shadow: 0 0 18px rgb(163 230 53 / .45); }
  .stats { display: flex; gap: 18px; font: 600 13px ui-monospace, Menlo, monospace; color: var(--dim); letter-spacing: .08em; }
  .stats b { color: var(--text); font-size: 17px; margin-left: 6px; }
  .stats .best b { color: var(--gold); }
  .board { position: relative; border-radius: 14px; padding: 10px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 30px 80px rgb(0 0 0 / .55), inset 0 1px 0 rgb(255 255 255 / .04); }
  canvas { display: block; border-radius: 8px; }
  .overlay { position: absolute; inset: 10px; display: grid; place-items: end center; padding-bottom: 26px; pointer-events: none; }
  .overlay span { padding: 8px 14px; border-radius: 999px; background: rgb(10 12 15 / .78); border: 1px solid var(--line); font: 600 12px ui-monospace, Menlo, monospace; letter-spacing: .12em; color: var(--text); }
  aside { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
  aside h2 { margin: 0 0 12px; font: 600 11px ui-monospace, Menlo, monospace; letter-spacing: .22em; color: var(--dim); }
  ol { margin: 0; padding: 0; list-style: none; counter-reset: rank; }
  li { counter-increment: rank; display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font: 14px ui-monospace, Menlo, monospace; }
  li:first-child { border-top: 0; }
  li::before { content: counter(rank); width: 20px; height: 20px; display: grid; place-items: center; border-radius: 6px; background: #1b222b; color: var(--dim); font-size: 11px; }
  li:first-child::before { background: var(--gold); color: #1a1204; }
  li .name { flex: 1; }
  li .score { color: var(--snake); font-weight: 700; }
  .empty { color: var(--dim); font-size: 13px; }
  .keys { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--dim); font-size: 12px; line-height: 1.7; }
  kbd { font: 11px ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 5px; background: #1b222b; border: 1px solid var(--line); color: var(--text); }
  form { display: none; margin-top: 14px; gap: 6px; }
  form.open { display: flex; }
  input { flex: 1; min-width: 0; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: 13px ui-monospace, Menlo, monospace; }
  button { padding: 7px 10px; border: 0; border-radius: 8px; background: var(--snake); color: #0a0c0f; font-weight: 700; cursor: pointer; }
</style>
</head>
<body>
<main>
  <header>
    <h1>SNAKE</h1>
    <div class="stats"><span>SCORE<b id="score">0</b></span><span class="best">BEST<b id="best">0</b></span></div>
  </header>
  <div class="board">
    <canvas id="c" width="440" height="440"></canvas>
    <div class="overlay"><span id="hint">PRESS AN ARROW KEY TO PLAY</span></div>
  </div>
  <aside>
    <h2>LEADERBOARD</h2>
    <ol id="board"></ol>
    <form id="save"><input id="name" maxlength="10" placeholder="Your name" autocomplete="off"><button>Save</button></form>
    <div class="keys"><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> or <kbd>WASD</kbd> to steer<br><kbd>Space</kbd> to pause</div>
  </aside>
</main>
<script type="module">
import { createGame, DIRS, step, tickMs, turn } from './snake.js'
import { addScore, load, qualifies, save } from './leaderboard.js'

const CELL = 22
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
const $ = (id) => document.getElementById(id)
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' }
let board = load(localStorage)
let game = createGame()
let demo = true
let paused = false
let pending = 0

function renderBoard() {
  $('board').innerHTML = board.length
    ? board.map((e) => \`<li><span class="name">\${e.name.replace(/[<&]/g, '')}</span><span class="score">\${e.score}</span></li>\`).join('')
    : '<p class="empty">No scores yet. Be the first.</p>'
  $('best').textContent = board[0]?.score ?? 0
}

// While nobody plays, the snake steers itself toward the apple, avoiding walls and its own body.
function autopilot() {
  const [hx, hy] = game.snake[0]
  const safe = (d) => {
    const [x, y] = [hx + DIRS[d][0], hy + DIRS[d][1]]
    return x >= 0 && y >= 0 && x < game.cols && y < game.rows && !game.snake.slice(0, -1).some(([sx, sy]) => sx === x && sy === y)
  }
  const dist = (d) => Math.abs(hx + DIRS[d][0] - game.food[0]) + Math.abs(hy + DIRS[d][1] - game.food[1])
  const best = Object.keys(DIRS).filter(safe).sort((a, b) => dist(a) - dist(b))[0]
  if (best) turn(game, best)
}

function draw() {
  ctx.fillStyle = '#0d1116'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#151b22'
  for (let x = 0; x < game.cols; x++) for (let y = 0; y < game.rows; y++) ctx.fillRect(x * CELL + 10, y * CELL + 10, 2, 2)
  if (game.food) {
    const [fx, fy] = game.food
    ctx.shadowColor = '#fb7185'
    ctx.shadowBlur = 18
    ctx.fillStyle = '#fb7185'
    ctx.beginPath()
    ctx.arc(fx * CELL + CELL / 2, fy * CELL + CELL / 2, CELL / 2.8, 0, Math.PI * 2)
    ctx.fill()
  }
  game.snake.forEach(([x, y], i) => {
    const t = i / Math.max(1, game.snake.length - 1)
    ctx.shadowColor = '#a3e635'
    ctx.shadowBlur = i === 0 ? 20 : 8
    ctx.fillStyle = \`hsl(\${84 + t * 60} \${85 - t * 20}% \${58 - t * 18}%)\`
    ctx.beginPath()
    ctx.roundRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4, 6)
    ctx.fill()
  })
  ctx.shadowBlur = 0
  $('score').textContent = game.score
}

function tick() {
  if (!paused) {
    if (demo) autopilot()
    step(game)
    if (game.over) {
      if (!demo && qualifies(board, game.score)) {
        pending = game.score
        $('save').classList.add('open')
        $('name').focus()
      }
      demo = true
      game = createGame()
      $('hint').textContent = 'PRESS AN ARROW KEY TO PLAY'
    }
    draw()
  }
  setTimeout(tick, demo ? 90 : tickMs(game.score))
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return
  if (e.key === ' ') {
    paused = !paused
    $('hint').textContent = paused ? 'PAUSED' : ''
    return e.preventDefault()
  }
  const dir = KEYS[e.key]
  if (!dir) return
  e.preventDefault()
  if (demo) {
    demo = false
    game = createGame()
    $('hint').textContent = ''
  }
  turn(game, dir)
})

$('save').addEventListener('submit', (e) => {
  e.preventDefault()
  board = addScore(board, { name: $('name').value, score: pending, at: Date.now() })
  save(localStorage, board)
  $('save').classList.remove('open')
  renderBoard()
})

renderBoard()
draw()
tick()
</script>
</body>
</html>
`,
  }
}
