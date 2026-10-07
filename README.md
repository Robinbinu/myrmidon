# Myrmidon

Run colonies of LLM agents that collaborate on one mission through a shared, append-only workspace, and watch them
live in a web UI. A colony is only complete when an independent verifier says so.

> Status: working proof of concept. APIs and storage formats will change.

## What it does

- **Agents** run on [`@oh-my-pi/pi-agent-core`](https://github.com/can1357/oh-my-pi) with any
  [`pi-ai`](https://github.com/can1357/oh-my-pi) provider (Anthropic, OpenAI, Codex, Gemini, OpenRouter, Ollama, …).
  Each agent picks its own model.
- **Coordination** happens only through logged tools: a board with `@mentions`, direct mail, append-only notes, a task
  graph with revision checks, and versioned artifacts.
- **Everything is an event** in a per-colony SQLite log that refuses `UPDATE`/`DELETE`. Replay, the UI, and exports
  all read the same log.
- **Verification decides completion.** Acceptance checks are declarative rules, sandboxed commands (real tests against
  the artifacts), and an LLM judge. Agents cannot declare themselves done.
- **Sandboxing.** Agent shell commands and command checks run under `sandbox-exec` (macOS) or bubblewrap (Linux) and
  can write only to the agent's scratch directory. File tools are confined to it as well.
- **Observer.** States time left, budget, idle agents, and unclaimed tasks. It informs; it has no authority.
- **UI.** Live colony map, timeline with replay, board/tasks/artifacts (with version diffs and a sandboxed preview),
  per-agent inspector, and a run comparison table.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3.14 and credentials for at least one model provider: either the provider's API key
environment variable (for example `ANTHROPIC_API_KEY`) or an existing `omp login <provider>`.

```bash
bun install
```

```bash
bun run myr run examples/calculator/colony.yaml --ui
```

The CLI prints a `http://127.0.0.1:…/#token=…` link to the dashboard. Edit `examples/calculator/colony.yaml` to choose
models available to you.

Other commands:

```bash
bun run myr serve
```

```bash
bun run myr ls
```

```bash
bun run myr export <colony-id> --out run.jsonl
```

Data lives in `~/.myrmidon` (override with `--home` or `MYRMIDON_HOME`).

## Colony spec

```yaml
name: Calculator
mission: ./task.md            # inline text or a .md file
pattern: lead-workers         # or blackboard
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

## Layout

| Path | Purpose |
|---|---|
| `packages/protocol` | Event and payload types, colony state projection (shared by daemon and UI) |
| `packages/core` | Append-only event log (Cordis service), SQLite store, validation, redaction, guards, blobs |
| `packages/runtime` | Agents, tools, patterns, observer, verifier, sandbox, colony runner, crash recovery |
| `apps/cli` | `myrmidon` command |
| `apps/web` | Local API server and React UI |
| `docs/superpowers/specs` | Design spec |

## Development

```bash
bun run dev
```

Serves the dashboard on http://127.0.0.1:4318 for development: the browser updates as you edit client files, the server
restarts when you edit server or runtime code (which stops any round in progress), and the browser's console output and
errors print in the same terminal, with React's development build naming the component that failed. It needs no access
token and uses your normal data directory; stop any other server on port 4318 first.

```bash
bun run check
```

Runs the type checker, Biome, and the test suite (including an end-to-end colony with scripted models).

## License

Apache-2.0
