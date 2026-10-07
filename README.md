<div align="center">

<img src="docs/assets/banner.svg" alt="Myrmidon: one chat, a whole crew of AI agents behind it" width="100%">

Myrmidon is a local-first, open-source agent harness. You talk to one lead; it answers, codes, browses, or brings
in a crew of specialists when the job is big. Every step is logged, sandboxed, and reviewable.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun_%E2%89%A51.3.14-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Features](#features) · [Architecture](#architecture) ·
[Roadmap](ROADMAP.md) · [Contributing](#contributing)

<br>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/home-light.png">
  <img src="docs/assets/home-dark.png" alt="Myrmidon's home screen: a dot-matrix mascot, crew cursors, and a composer with model, thinking, reviewer and helper controls" width="100%">
</picture>

</div>

---

## Why Myrmidon

Most agent tools make you pick a shape up front: a chat bot, a coding agent, a browser operator, or a multi-agent
framework you wire together yourself. Myrmidon is all four behind a single conversation.

- **The work sizes itself.** A quick question gets a plain reply. A script gets written by the lead alone. A
  multi-part build or research job escalates to a crew, orchestrated by a lead or run as a leaderless swarm.
- **It is the harness, not a wrapper.** Myrmidon runs its own agent loop, tools, sandbox, and model calls. No other
  CLI has to be installed or logged in.
- **Any model, per agent.** Anthropic, OpenAI, Codex, Gemini, OpenRouter, Ollama, or any OpenAI-compatible endpoint.
  The lead, each worker, and the reviewer can each run a different model.
- **Nothing is hidden.** Every message, tool call, file, and decision is an event in an append-only SQLite log that
  refuses `UPDATE` and `DELETE`. The UI, replay, audit view, and exports all read that same log.
- **Safe by default.** Shell commands run under `sandbox-exec` (macOS) or bubblewrap (Linux). Secrets are redacted
  from logs and transcripts. Fetched web pages are treated as untrusted data. Each tool can be set to Allow, Ask
  first, or Off.
- **Done means checked.** An independent reviewer (off, auto, or always) can run real tests, rules, and an LLM
  rubric against the output. Agents cannot mark their own work verified.
- **Yours.** Runs on your machine, stores data in `~/.myrmidon`, Apache-2.0.

## Quick start

You need [Bun](https://bun.sh) 1.3.14 or newer and access to at least one model provider: an API key in the usual
environment variable (for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), a key or endpoint added in
**Settings → Models & providers**, or a ChatGPT/Codex sign-in.

```bash
git clone https://github.com/Robinbinu/myrmidon.git
```

```bash
cd myrmidon && bun install
```

```bash
bun run myr serve
```

The command prints a `http://127.0.0.1:…/#token=…` link. Open it, pick a model in the composer, and type what you
want done.

Already use [oh-my-pi](https://github.com/can1357/oh-my-pi)? Bring your keys, sign-ins, and `models.yml` across:

```bash
bun run myr import-omp
```

## How it works

```mermaid
flowchart LR
    You([You]) -->|message| Lead
    Lead -->|quick answer| Reply([Reply])
    Lead -->|does the work| Tools
    Lead -->|"escalate(to: team)"| Crew
    subgraph Crew [Crew round]
        direction TB
        Orchestrated["Orchestrated<br/>lead plans · specialists build"]
        Swarm["Swarm<br/>peers huddle · claim tasks"]
    end
    Crew --> Tools
    Tools["shell · files · browser · web<br/>MCP · skills · made tools"] --> Log[(Append-only<br/>event log)]
    Crew --> Reviewer{Reviewer}
    Lead --> Reviewer
    Reviewer -->|findings| Crew
    Reviewer -->|passes| Reply
    Log --> UI[Live UI · replay · audit]
```

1. **The lead starts at once.** Every request goes straight to one lead with every tool. It answers directly, does
   moderate work itself, or calls `escalate(to: team)` early when parallel specialists would help.
2. **Crews coordinate through logged tools only:** a shared board with `@mentions`, direct mail, append-only notes,
   a task graph with revision checks, and versioned artifacts. Nothing is edited in place.
3. **Two crew modes.**

   | Mode | Shape | Best for |
   |---|---|---|
   | Orchestrated | A lead plans and assigns; specialist workers (researcher, coder, writer…) each on their own model | Builds with a clear split of parts |
   | Swarm | Equal peers huddle, merge a plan, claim tasks; the most productive peer speaks | Exploratory work, research, A/B of coordination |

4. **Finishing follows your reviewer setting.** Off: the answer ends the round. Auto: the lead asks for a review
   when the work deserves one. Always: every final answer is checked and findings go back as fix tasks.
5. **Follow-ups carry on.** Files, notes, and each agent's own conversation persist across rounds of a chat.

The agent-facing docs in [`packages/runtime/docs`](packages/runtime/docs) describe the same rules the agents read at
runtime.

### See a crew at work

A lead plans a snake game, a coder and a tester build it in parallel, and the reviewer scores the result.

<img src="docs/assets/chat-dark.png" alt="A finished crew round in the chat: the lead's final answer, the reviewer's score, the files, and the task list with the plan" width="100%">

<table>
  <tr>
    <td width="50%"><img src="docs/assets/crew-dark.png" alt="Crew console: agents with their models and token counts, a live activity feed of every tool call, and a replay scrubber"></td>
    <td width="50%"><img src="docs/assets/preview-dark.png" alt="A published file previewed in a sandbox: the snake game the crew built, running"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Crew console</b>: every tool call, task and verdict, with replay</sub></td>
    <td align="center"><sub><b>Artifacts</b>: published files open in a sandboxed preview</sub></td>
  </tr>
</table>

<sub>Screens from a demo run with scripted models, so the steps are reproducible.</sub>

## Features

### Coding harness

- Work in a real project folder, with `AGENTS.md` / `CLAUDE.md` / `.myrmidon.md` read at kickoff.
- `grep`, `glob`, `run_checks`, a project outline, and fs read/write/edit confined to the project.
- **Checkpoints and rewind** before a round's first write; per-round diffs and a Git view to stage and commit (it
  never pushes).
- **A git worktree per coding worker**, so parallel agents never share a working tree.
- Dev servers the agents can start, open in their browser, and show you live.
- Per-project permissions: autonomous, ask, or read-only.
- Context compaction that respects each model's real context window.

### Browser agent

- A real Chrome over CDP: aria snapshots with refs, click, type, tabs, uploads, downloads, console, network.
- `browser_extract(schema)` turns a page into JSON instead of a long snapshot.
- **Login handoff:** the agent asks, you sign in through the live view, it carries on. Agents never type passwords.
- Live view with the agent's cursor; take over at any time; saved browser flows replay as tools.

### Crews

- Orchestrated and swarm modes, persistent workers across rounds, random call signs (`nova`, `kai`, …).
- Mid-round escalation, task rejection with reasons, non-blocking check-ins, and `ask_user` pauses.
- A live task board, a crew map, and a run comparison view with diffs.
- Review tailored to the kind of work: tests for code, citation checks for research, a rubric for writing.

### Agent harness

- **MCP servers** with a circuit breaker for flaky ones.
- **Skills** in the Agent Skills format, from Myrmidon's folder, `~/.claude/skills`, or the project.
- **Hooks** in Claude Code's format, before and after tools and at round end.
- **Self-made tools:** agents write sandboxed tools with an input schema; keep the good ones in a library.
- **Memory** across chats: agents propose, you decide what is kept.
- **Background and scheduled rounds** from the CLI or cron schedules, with desktop notifications.
- **Budgets** for wall time, turns, tokens, and dollars, with live spend in the run card.
- **Audit view** of every file, URL, and command each agent touched, and what was stopped.

## Scripted crews

For repeatable runs and research, describe a crew in YAML and run it headless or with the UI:

```yaml
name: Calculator
mission: ./task.md            # inline text or a .md file
pattern: lead-workers         # or blackboard (swarm)
agents:
  - { name: lead, role: lead, model: anthropic/claude-sonnet-4-5 }
  - { name: coder, role: worker, model: openai/gpt-5, count: 2 }
acceptance:
  - { verifier: checks, rules: [{ artifact: index.html, contains: "<html" }] }
  - { verifier: command, run: "bun test", against: [src/, tests/] }
  - { verifier: llm-judge, model: openai/gpt-5, rubric: ./rubric.md, threshold: 0.8 }
budget: { wall: 15m, costUsd: 5, maxTurns: 40 }
observer: { interval: 30s }
```

```bash
bun run myr run examples/calculator/colony.yaml --ui
```

The [calculator example](examples/calculator) has three agents build a calculator while the verifier runs real
tests against their code. Edit its `model:` lines to models you have access to.

## CLI

| Command | What it does |
|---|---|
| `myr serve [--port N]` | Start the server and web UI |
| `myr run <spec.yaml> [--ui]` | Run a scripted crew |
| `myr ask "<request>" [--chat ID] [--project ID] [--wait]` | Send a request to a running server; `--wait` prints the final answer |
| `myr ls` | List crews |
| `myr events <id> [--json]` | Print a crew's event log |
| `myr export <id> [--out run.jsonl]` | Export a crew's events as JSONL |
| `myr import-omp` | Copy an oh-my-pi setup from `~/.omp` |

Run them with `bun run myr …`. Data lives in `~/.myrmidon`; override with `--home DIR` or `MYRMIDON_HOME`.

## Architecture

A Bun + TypeScript monorepo. The HTTP/WebSocket API and the event protocol are the contract, so native clients can
follow the browser UI without the runtime changing.

| Package | Role |
|---|---|
| [`packages/protocol`](packages/protocol) | Event and payload types, crew state projection; shared by server and clients |
| [`packages/core`](packages/core) | Append-only event log as a [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) service, SQLite store, validation, redaction, guards, blobs |
| [`packages/runtime`](packages/runtime) | Agents, tools, team patterns, observer, reviewer, sandbox, browser, MCP, skills, hooks, worktrees, recovery |
| [`apps/web`](apps/web) | Local API server and the React UI |
| [`apps/cli`](apps/cli) | The `myrmidon` command |
| [`apps/eval`](apps/eval) | Eval harness with fixed coding, browsing, research, and crew cases |

Models and the agent loop come from [`@oh-my-pi/pi-ai`](https://github.com/can1357/oh-my-pi) and
`@oh-my-pi/pi-agent-core`, embedded in-process behind Myrmidon's own interfaces. Design notes live in
[`docs/superpowers/specs`](docs/superpowers/specs).

## Development

```bash
bun run dev
```

Serves the UI on http://127.0.0.1:4318 with hot reload. The server restarts when server or runtime code changes, and
the browser's console output prints in the same terminal. It needs no access token; stop anything else on port 4318
first.

```bash
bun run check
```

Runs the type checker, Biome, and the test suite, including an end-to-end crew driven by scripted models.

```bash
bun run eval
```

Runs the eval suite against real models and writes a JSON report you can diff between changes.

## Status

Myrmidon is alpha. It works end to end, but APIs, the event schema, and storage formats will
still change. The browser UI is the first client; desktop shells come later. See the [roadmap](ROADMAP.md) for
what is done and what is next.

## Contributing

Issues and pull requests are welcome.

1. Run `bun run check` before opening a pull request; it must pass.
2. Keep changes focused, and match the surrounding code's style.
3. Write commit subjects in plain, imperative English that say why.

Good places to start: the open items in [ROADMAP.md](ROADMAP.md) (benchmarks in Milestone 4), new eval cases in
[`apps/eval`](apps/eval), and the agent docs in [`packages/runtime/docs`](packages/runtime/docs).

## Acknowledgements

Built on [oh-my-pi](https://github.com/can1357/oh-my-pi) for models and the agent loop, and
[Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) for the plugin and service system. Inspired by Claude
Code, Codex, Cursor, and Manus.

## License

[Apache License 2.0](LICENSE)
