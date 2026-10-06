# Myrmidon — Design Spec

- **Date:** 2026-10-06
- **Status:** Approved for implementation (phased)
- **License:** Apache-2.0

## 1. Purpose

Myrmidon is an open-source agent harness that runs **colonies**: groups of
autonomous LLM agents that collaborate on one mission through a shared,
append-only workspace, under an observer that reports deadlines and budgets and
a verifier that decides when work is actually done. A web UI shows colonies
live and replays any past run.

It serves two audiences with equal weight:

- **Real work** — colonies produce verified artifacts (code, documents).
- **Research** — runs are reproducible, measurable, and comparable across
  models, coordination patterns, and observer strategies.

Myrmidon **is the harness**: it owns the agent loop, model calls, and tools.
External agents (Claude Code, Codex, …) can join a colony only through an
optional plugin.

### Non-goals for v1

- Distributed execution (interfaces allow it later; no remote backend ships).
- Agents editing the user's files. All output is versioned artifacts.
- Container sandboxes (a later `ctx.sandbox` provider).
- Multi-user accounts, hosted service, or remote access to the daemon.

## 2. Decisions and their reasons

| Decision | Choice | Reason |
|---|---|---|
| Language | TypeScript monorepo on Bun | Shared types across daemon, projections, and UI; built-in SQLite; single-binary builds; the model and loop libraries we adopt are Bun-native. |
| Plugin model | Cordis (`@deepseek-ai/cordis`) | Services, typed events, dependency injection, and reversible effects; proven in DeepSeek Harness. Spike confirmed it runs on Bun 1.3.14. |
| Model layer | `@oh-my-pi/pi-ai` behind our `ctx.llm` | ~35 providers, unified stream events, usage and cost tracking. |
| Agent loop | `@oh-my-pi/pi-agent-core` behind our `ctx.agentLoop` | Tool hooks, steering queue, context transforms, tool tiers. |
| Source of truth | Append-only event log in SQLite | Replay, crash recovery, UI, and research exports all derive from one record. |
| Shared notes | Append-only, enforced | Collaboration history can never be rewritten by an agent. |
| Work output | Versioned, content-addressed artifacts | No agent can damage user files or overwrite another agent's version. |
| Completion | Only via verifier verdicts | Self-reported completion is trivially gamed. |
| Deployment | Local single machine | Storage, transport, and execution sit behind interfaces for a later distributed backend. |
| Research access | SQLite schema + JSONL/Parquet export + Python reader | Notebook users get data without a second runtime. |

Patterns borrowed from DeepSeek Harness (dsh): capability seams
(definition / provider / consumer), "model-visible means logged", projections
over the log, task DAG with revision compare-and-set, durable mailbox,
fail-loud capability flags, real-composition and disposal tests.

## 3. Architecture

```
myrmidon CLI ──┐                      ┌── Web UI (React; panels are plugins)
               ▼                      ▼
        ┌──────────── Daemon (Bun process, Cordis root) ────────────┐
        │ kernel      Loader · profiles · YAML patches · invariants │
        │ ctx.log          append-only event log   (provider: sqlite)│
        │ ctx.blobs        content-addressed blob store (fs)        │
        │ ctx.projections  fold events → state                       │
        │ ctx.colonies     lifecycle · roster · budgets · scheduler  │
        │ ctx.llm          model adapters   (pi-ai, scripted)        │
        │ ctx.agentLoop    agent driver     (pi-agent-core)          │
        │ ctx.tools        tool registry + guarded execution         │
        │ ctx.sandbox      process confinement (sandbox-runtime)     │
        │ ctx.observers    observer strategies                       │
        │ ctx.verifiers    command · checks · llm-judge              │
        │ ctx.patterns     blackboard · lead-workers · pipeline      │
        │ ctx.mirror       read-only disk view of notes/artifacts    │
        │ ctx.exporters    jsonl · parquet · otlp                    │
        │ ctx.transport    HTTP + WebSocket on 127.0.0.1             │
        └────────────────────────────────────────────────────────────┘
```

### 3.1 Plugin rules

- Every capability is a **seam** with three roles: a *service definition*
  package (interface, event declarations, invariants), one or more
  *providers*, and *consumers*. Providers are chosen in YAML.
- Plugins find each other by `ctx.<key>`, never by importing a provider.
- All registrations are reversible effects; unloading a plugin removes
  everything it registered.
- Configuration is layered: a **profile** stacks **bundles**, then the
  profile's `myrmidon.patch.yml`, then the home-level patch, then any
  `--patch` file. A patch replaces or inserts rows by id.
- A request for a capability a provider lacks fails with a typed error;
  nothing is silently ignored.

### 3.2 Invariants (enforced inside the owning operation)

Plugins can extend these checks but cannot bypass them, because they live in
the service-definition layer that wraps every provider.

1. **Append-only.** `ctx.log` has no update or delete. The SQLite provider
   also installs triggers that abort `UPDATE` and `DELETE` on the events table.
2. **Completion requires verification.** `colony/completed` is accepted only
   if it references passing `verifier/verdict` events for every acceptance
   check. `verifier/verdict` may only be appended by an actor of kind
   `verifier`.
3. **Permission before effect.** Every tool call passes the permission gate
   before its body runs; the tool body itself re-checks path and tier.
4. **Confinement.** Process-spawning tools run only through `ctx.sandbox`.
   With no sandbox backend, those tools are unavailable unless the colony is
   started with `--unsafe-no-sandbox`, which is logged and shown in the UI.
5. **No secrets in the log.** Credentials are resolved at call time and
   never written; a redaction pass runs before every append.

### 3.3 Monorepo layout

```
packages/
  kernel/          Cordis root, loader, profiles, invariants
  log/             ctx.log definition, event registry, appendIf
  log-sqlite/      SQLite provider (bun:sqlite)
  blobs/           content-addressed blob store
  projections/     projection registry; isomorphic (daemon + UI)
  colony/          colonies, roster, scheduler, budgets
  llm/             ctx.llm definition
  llm-pi-ai/       pi-ai provider
  llm-scripted/    deterministic scripted model for tests
  agent-loop/      ctx.agentLoop definition
  agent-loop-pi/   pi-agent-core provider
  tools/           ctx.tools definition + permission gate
  tools-colony/    board, notes, mail, tasks, artifacts, observe
  tools-work/      fs_* (scratch-confined), shell, web_fetch
  sandbox/         ctx.sandbox definition
  sandbox-srt/     @anthropic-ai/sandbox-runtime provider
  observer/        definition + observer-factual
  verifier/        definition + command, checks, llm-judge
  patterns/        definition + blackboard, lead-workers, pipeline
  mirror/          read-only disk projection
  exporters/       jsonl, parquet, otlp
  transport-http/  HTTP + WebSocket API
  protocol/        shared API and event types for clients
  agent-acp/       optional: external ACP agent as a colony member
apps/
  daemon/          `myrmidon serve`
  cli/             `myrmidon` command
  web/             React UI
python/
  myrmidon/        read-only Python reader
```

## 4. Data model

### 4.1 Event envelope

```ts
interface MyrEvent<T extends string = string, P = unknown> {
  colonyId: ColonyId
  seq: number            // gap-free per colony, assigned at commit; ordering key
  id: EventId            // ULID, globally unique
  time: string           // ISO-8601; informational, never used for ordering
  type: T                // 'board/posted', 'task/claimed', ...
  actor: ActorRef        // { kind: 'agent'|'observer'|'verifier'|'user'|'system', id }
  causedBy?: EventId
  trace: { traceId: string; spanId: string; parentSpanId?: string }
  schema: number         // payload version for this type
  payload: P             // validated against the registered schema
}
```

### 4.2 Log semantics

- Storage layout: `~/.myrmidon/index.sqlite` lists colonies; each colony has
  its own `~/.myrmidon/colonies/<id>/events.sqlite`, `blobs/`, and agent
  scratch directories. A colony directory is a self-contained, portable run.
- Event types and payload schemas are registered by plugins. Unknown types
  and invalid payloads are rejected.
- One writer per colony; `seq` is assigned inside a SQLite transaction
  (WAL mode). An append is all-or-nothing; listeners are notified only after
  commit.
- `appendIf(colonyId, expectedSeq, events)` gives optimistic concurrency.
- Payload migrations are per-type `vN → vN+1` steps applied on read; stored
  events are never rewritten.

### 4.3 Projections

A projection is a pure, versioned fold `(state, event) → state`. Projections
rebuild from `seq 0` on demand and cache snapshots. The same projection code
runs in the daemon and in the browser.

### 4.4 Colony records

| Record | Events |
|---|---|
| Notes, board | `note/appended`, `board/posted`. Corrections are new events with `corrects: EventId`. |
| Mail | `mail/sent`, `mail/delivered`, `mail/read`. Pending = sent − delivered; re-delivered after restart. |
| Tasks | `task/*` snapshots with `revision` (+1 per change; stale writes rejected), `blockedBy` (acyclic), advisory `writeScopes`. Status: `pending → in_progress → submitted → verified | rejected`, plus `deleted` tombstone. |
| Artifacts | Blob by SHA-256; `artifact/versioned {name, version, blobHash, parentVersion, author}`. Diffs computed from blobs. |
| Agent activity | `agent/*` (lifecycle), `llm/request`, `llm/response`, `tool/call`, `tool/result`. Enough to reconstruct every model request exactly. |
| Control | `colony/created|started|paused|resumed|stopped|completed|failed`, `observer/signal`, `verifier/verdict`, `*/interrupted`. |

### 4.5 Crash recovery

On start the daemon rebuilds projections, then appends `*/interrupted` for any
open turn, undelivered mail, or vanished process. Colonies then resume or fail
explicitly.

## 5. Agent runtime

- Each agent is an in-process `ctx.agentLoop` instance with its own model
  (`provider/model`), role prompt, and tool allowlist.
- **Model-visible means logged.** Every request, streamed response, tool call,
  and tool result becomes an event.
- The permission gate runs in `beforeToolCall`; tools re-check inside their
  body. Tool tiers: `read`, `write`, `exec`.
- Work tools: `fs_read`, `fs_write`, `fs_edit` confined to the agent's
  scratch directory by real-path resolution; `shell` via `ctx.sandbox`
  (write only to scratch, read the mirror, network allowed); `web_fetch`.
- Colony tools: `read_task`, `read_board`, `post`, `append_note`,
  `send_mail`, `read_mail`, `list_agents`, `list_tasks`, `create_task`,
  `claim_task`, `submit_task`, `publish_artifact`, `read_artifact`, `observe`.
- Lifecycle: `provisioning → ready → working ⇄ idle → completed | stopped | failed`.
  Idle agents wake on inbox items (mail, board mention, observer signal,
  unblocked task) at the next step boundary.
- Supervision: per-turn timeout, failure isolation per agent, restart with
  exponential backoff up to a configured limit, resume by rebuilding context
  from the log. Shell subprocesses run in their own process group and are
  killed on cancel.
- Usage: tokens and cost recorded when the provider reports them; otherwise
  recorded as `unknown`, never 0.

## 6. Observer, verifier, coordination

- **Observer** (`ctx.observers`, one strategy per colony): runs on a timer and
  on trigger events, reads projections only, appends
  `observer/signal {kind, severity, facts, targets}` where kind is one of
  `deadline | budget | stall | unclaimed | blocked | conflict`. Default
  strategy `observer-factual`. Strategies choose wording, cadence, and
  targets; they cannot grant permissions, complete, or stop colonies.
- **Hard limits** (wall time, turns, tokens, cost — per agent and per colony)
  are enforced by `ctx.colonies`. Exceeding one appends
  `colony/stopped {reason: 'budget'}`.
- **Verifiers** (`ctx.verifiers`, many): `command` (sandboxed tests against
  materialized artifacts), `checks` (declarative rules), `llm-judge` (rubric,
  structured score, different model from authors by default, optional
  majority vote). Run on `submit_task` and on final submission.
- **Patterns** (`ctx.patterns`): supply role prompts, initial tasks, and
  per-role tool allowlists. Ships `blackboard` (default), `lead-workers`,
  `pipeline`.
- **Metrics projection:** wall time, tokens, cost, turns, messages, artifact
  versions, rejections, and verdict scores per agent and per colony.

### 6.1 Colony spec file

```yaml
mission: ./task.md
pattern: lead-workers
agents:
  - { name: lead,  model: anthropic/claude-opus, role: lead }
  - { name: coder, model: openai/gpt-5, role: worker, count: 2 }
acceptance:
  - { verifier: checks,    rules: [{ artifact: index.html, exists: true }] }
  - { verifier: command,   run: "bun test", against: [index.html, tests/] }
  - { verifier: llm-judge, rubric: ./rubric.md, threshold: 0.8 }
budget: { wall: 15m, costUsd: 5 }
```

## 7. API and UI

### 7.1 Transport

- HTTP + WebSocket bound to `127.0.0.1` on a random port. The port and a
  bearer token are written to `~/.myrmidon/daemon.json` with mode `0600`.
- Every request needs the token. `Origin` and `Host` are checked to block
  DNS-rebinding; CORS is closed.
- Endpoints: colony list/create/start/pause/resume/stop; event stream
  (`subscribe from seq`, backfill then live); projection snapshots; artifact
  blobs and diffs; exports.
- `packages/protocol` holds the shared request, response, and event types.

### 7.2 UI (React + Vite)

The client keeps a local event cache per colony and runs the shared
projections, so live view and replay are the same code path with a different
`seq` cursor. Panels register through a panel registry.

| View | Content |
|---|---|
| Colony map | Agents as nodes (status, model, current task); mail and board activity animate along edges. Built on React Flow. |
| Timeline + replay | Scrubber over `seq`; play, pause, step, jump; every other panel follows the cursor. |
| Board, tasks, artifacts | Notes and board feed; task DAG with owners and status; artifact browser with version diffs. |
| Agent inspector + compare | Full transcript, tool calls, and usage per agent; side-by-side run metrics. |

### 7.3 CLI

`myrmidon init | run <colony.yaml> | serve | ui | ls | logs <colony> |
export <colony> --format jsonl|parquet | replay <colony>`.

## 8. Engineering foundation

- **Tooling:** Bun workspaces; TypeScript `strict`; Biome for lint and format;
  `bun test`; `tsc -b` for project references.
- **Tests:**
  - Unit tests per package.
  - Contract tests per seam, run against every provider.
  - Real-composition tests that boot a YAML profile through the Loader with
    the scripted model, then assert durable events and user-visible output.
  - Disposal tests: every registry contribution is removed on unload.
  - Concurrency tests for `appendIf` and task claims.
  - End-to-end test: a full colony run with scripted models reaches a
    verified completion.
- **CI (GitHub Actions):** typecheck, lint, test on macOS and Linux for every
  pull request; required before merge.
- **Repository health:** Apache-2.0 `LICENSE`, `README`, `CONTRIBUTING`,
  `SECURITY.md`, `CODE_OF_CONDUCT`, ADRs in `docs/adr/`, Conventional Commits,
  DCO sign-off, Changesets for versioning, Renovate for dependencies, gitleaks
  for secret scanning.
- **Branching:** `main` changes only through pull requests with passing
  checks.
- **Dependency policy:** exact pins for `@oh-my-pi/*` and Cordis; upgrades
  land in dedicated pull requests that must pass the seam contract tests.

## 9. Delivery phases

Each phase gets its own implementation plan and must pass its tests before the
next starts.

| Phase | Scope | Exit criterion |
|---|---|---|
| 1. Foundation + core | Repo health, tooling, CI, kernel, Loader/YAML, `ctx.log` + SQLite, blobs, projections, CLI skeleton | Profile boots from YAML; events append, reject edits, survive restart, and rebuild projections. |
| 2. Agent runtime | llm (pi-ai + scripted), agent loop, tools + permission gate, sandbox, colony tools, colonies + scheduler, observer, verifiers, patterns, mirror | `myrmidon run` completes a colony with scripted models end-to-end, and with a real provider when a key is present. |
| 3. API + data | transport-http, protocol, exporters, Python reader | Live event stream and replay over the API; JSONL/Parquet export loads in pandas. |
| 4. UI | Four v1 views | A recorded run replays fully; a live run updates the map in real time. |
| 5. Release | Docs, packaging (npm `@myrmidon/*`, compiled binary), `agent-acp` plugin | Clean install from npm runs the quick-start colony. |

## 10. Risks

| Risk | Mitigation |
|---|---|
| `@oh-my-pi/*` changes fast (v17 → v18) | Exact pins, wrapped behind our seams, contract tests; vendor if needed. |
| Cordis Loader untested on Bun | First task of Phase 1 verifies it before anything depends on it. |
| `sandbox-runtime` is 0.0.x | Behind `ctx.sandbox`; shell disabled without a backend. |
| Agents game verification | Verdicts only from verifier actors; judges default to a different model; command verifiers run sandboxed on materialized artifacts. |
| Log growth | Projection snapshots; blobs outside SQLite; per-colony databases. |
