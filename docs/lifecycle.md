# Run and agent lifecycle

How a round (a `ColonyRun`) and its agents start, wait, stop, fail and recover, which invariants hold at each
transition, and where each one is enforced and tested. Read this before changing `packages/runtime/src/colony.ts`,
`agent.ts`, `chat.ts`, `recovery.ts`, `sandbox.ts` or the fold in `packages/protocol/src/colony-state.ts`.

## The log is the truth

Every fact is an event in the colony's append-only log (`packages/core/src/log.ts`, SQLite store with triggers that
refuse updates and deletes). Appends are serialized per colony and each gets the next gap-free `seq`; `appendAtomic`
adds a compare-and-set on the head for read-modify-write steps (task claims, task ids). `completionGuard` refuses a
`colony/completed` that does not cite passing verdicts in the same colony.

State is never stored: it is `foldColony(events)` (`colony-state.ts`). A running round keeps a live fold, fed by the
`log/appended` hook; the web client folds what it fetched; recovery and the chat index fold from the store.

Besides the log, each agent keeps a transcript (`<colony>/agents/<name>.jsonl`, one finished message per line). It is
a cache for resuming with the agent's own conversation; the log stays authoritative.

## Round states

`ColonyStatus` as the fold derives it:

```
            colony/created | round/started
                       │
                    created
                       │ colony/started (pid, hostname; again on every resume)
                       ▼
                    running ──────── colony/completed ──▶ completed   (cites passing verdicts)
                       │  ╲───────── colony/escalated ──▶ stopped     (rerun at a bigger tier)
                       │   ╲──────── colony/stopped ────▶ stopped     (reason; Resume offered)
                       │    ╲─────── colony/failed ─────▶ failed
                       ▼
       stopped ── colony/started (resume) ──▶ running
       stopped|completed ── round/started (next chat round) ──▶ created
```

What ends a round (`ColonyRun`): a final answer that verified (`_complete`, or `_closeSettled` after a crew's wind-down),
the person's Stop (`stop(reason, finish=true)`), a budget (`_checkBudget`, wall clock in `_watch`), a model failure
(`modelFailed`, which stops rather than fails so it can be resumed), a stall after `QUIET_NUDGES` nudges, a chat round
going quiet after it spoke (`AWAITING_USER`), all agents dead (`_watch`), and escalation. All of them go through
`_end()`, which runs `_shutDown` exactly once however many endings race: agents are aborted first, Stop hooks run, dev
servers, code cells, debuggers, worktrees, sign-in waits and approval waits are closed (the last two logged as
`stopped`), timers cleared, the mirror written, then `done` resolves.

## Agent states

`AgentStatus`: `provisioning` (created) → `idle` (waiting on its inbox) ⇄ `working` (a turn) → `stopped` | `failed`.
A turn is `agent/turn start` … `agent/turn end`; between them pi's loop runs model calls and tool calls. Deliveries to
a working agent are steered into its next step (or queued with `queue`); undelivered ones start the next turn
(`_requeueUnread`). The loop ends when the round is no longer running, at the turn limit, or after a model failure;
in every case it records `stopped`. A loop that throws is caught by `_runAgent` and recorded as `failed`.

## Waits

- **Model calls**: retried on transient errors (`MODEL_RETRIES`), folded on overflow once, moved to the person's
  fallback models, otherwise `agent/error` + stop. Every call carries pi's AbortSignal; `TURN_TIMEOUT_MS` aborts a turn.
- **Tool calls**: each logs `tool/call` before running and `tool/result` after. Every tool gets its call's signal
  (`ToolDef.run(…, signal)`); `shell` hands it to the sandbox, which stops the process tree; any other tool is abandoned
  `TOOL_STOP_GRACE_MS` after the signal, so a call already landing keeps its real result. Commands time out on their
  own (`timeoutSeconds`, at most 300 s), and the whole tree goes then too.
- **Approvals** (`reviewChange`): `approval/requested`, then exactly one `approval/decided` by the person, the
  `APPROVAL_MS` timer (`timeout`), or the round ending (`stopped`). A second answer to the same id is refused
  ("no longer waiting"); the HTTP route answers 400 for malformed bodies and 409 for decided or unknown requests.
- **Sign-ins**, **crewmates asked** (`ask_crewmate`): resolved by their answer, a timeout, or the round ending.
- **Tasks**: `pending` → `in_progress` (claimed) → `submitted` → `verified` | `rejected`; `deleted`. A task blocked by
  others is announced only once its blockers are verified (`_announceUnblocked`); a holder idle past `LEASE_MS`, or
  stopped, loses its claim (`_releaseStaleClaims`); a holder that ends its turn still holding is reminded twice.

## Processes

- Long-lived children (dev servers, Chrome, voice engines, MCP servers started by the hub) run on a **leash**
  (`leashed.ts`/`leash.ts`): a small process that stops the child's whole tree when Myrmidon dies, however it dies. A
  compiled server runs itself as the leash (`LEASH_COMMAND`, fixed in e6dd6fe1).
- Commands run to completion: confined ones (`sandbox-exec`, bubblewrap) are stopped as a tree (`killTree`) on timeout
  or abort; full-access ones run on a leash. Bubblewrap also has `--die-with-parent`.
- Shutdown (`apps/cli/src/main.ts` `serve`): `chats.stopAll()` stops every round with "server shutting down" (a round
  winding down completes) and waits up to `SETTLE_MS`; then browsers, computer use, ssh, MCP, the HTTP server and the
  runtime close. The desktop app stops its server over the API, then by signal.

## Recovery

A round's `colony/started` records `pid` and `hostname`; chat rounds also write `<home>/runs/<colonyId>`. On start, a
round the log calls running whose process is gone is closed by `closeOrphan` (`recovery.ts`), from `ChatService._settle`
(server) or `recoverOrphans` (CLI): undecided approvals, open sign-ins, running servers and live agents are closed as
stopped, and the round is stopped with a reason, in one batch. Calls that were running stay unanswered in the log.

**Resume** (`ColonyRun.resume`) reads the log, restores each agent's transcript, gives back what was left of the wall
clock (at least half) and of the spend limits, and wakes the speaker with a summary, unread messages, and the effects
already done outside Myrmidon (`outsideEffects`). A transcript cut mid-step is repaired from the log (`readTranscript`):
each unanswered call gets its recorded result, or `[interrupted]` when it started without one, or `[not run]`; the
repair is written back. Only a step nothing of which ran is dropped.

**What the person sees**: a stopped round shows its reason with Resume and Try again; calls it was in the middle of are
listed first ("It stopped while this was running"), since it is not known whether they ran; then everything it already
did outside Myrmidon. Approved calls carry receipts (`review/done`), so an approved write never runs twice in a round.

## Invariants

| # | Invariant | Enforced | Tested |
|---|-----------|----------|--------|
| 1 | A run is not completed while work is under way: a task `in_progress`, `submitted` or `rejected` (not `task-final`), or an undecided approval. A pending task nobody took is planned work and does not hold it. In a chat, the answer the person got closes the round; a crew winds down first. | `openWork` (protocol `lifecycle.ts`), `ColonyRun._openWork` before the checks run and again before completing; `completionGuard` for verdicts | `lifecycle.test.ts` "not completed while…" |
| 2 | A run does not stay running once its agents are gone, and no agent stays `working` in an ended run. | `_watch` ("all agents have stopped or failed"); agent loop records `stopped` on every exit, `failed` on a crash; `closeOrphan` for dead processes | "agents have all died", "model fails midway", "process died is closed whole", chat "Myrmidon that is gone" |
| 3 | Resume never repeats a call that ran without checking what was recorded. | `readTranscript` repair from `callRecords`; receipts for approved writes; `resumeEffects` to the speaker | `transcript.test.ts`, "crash between a call and its transcript", chat "reaching outside Myrmidon…" |
| 4 | An event delivered twice or late changes state once. | `applyEvent` ignores `seq <= lastSeq`; client merges by seq; `decideApproval` takes one answer per id | `protocol/tests/lifecycle.test.ts`, "approval answered… twice" |
| 5 | Stopping a call stops what it started. | signal → sandbox `killTree` / leash; grace for in-process tools | `sandbox.test.ts` (timeout and abort, confined and full access), "stopping during a command" |

## Scenarios

| Scenario | Where |
|----------|-------|
| Person writes while agents work (steer / queue) | `chat.test.ts` "a message sent mid-turn steers…", "a follow-up sent as the last round stops…" |
| Stop during model generation | `lifecycle.test.ts` "stopping while the model is still writing" |
| Stop during a tool call | `lifecycle.test.ts` "stopping during a command" |
| Model fails midway; resume | `lifecycle.test.ts` "a model that fails midway" |
| Tool hangs / exceeds its timeout | `sandbox.test.ts` "runs too long is stopped…" (both sandboxes) |
| Restart during a run | `chat.test.ts` "a round left running by a Myrmidon that is gone", `lifecycle.test.ts` "process died", "crash between a call…", `colony.test.ts` "recovery marks…" |
| Child process exits | `colony.test.ts` dev server tests (`server/stopped` on exit), "agents have all died" |
| Worker blocked / idle / holding a task | `chat.test.ts` "a worker assigned a blocked task sleeps…", "a worker that stops while holding its task is reminded" |
| Approval denied / times out / invalid / twice | `lifecycle.test.ts` "an approval answered no, timed out, or answered twice"; `apps/web/tests` for the route |
| Task finishes while a dependent waits | `chat.test.ts` "blocked task sleeps until its blockers are verified" |
| Same event or result twice | `protocol/tests/lifecycle.test.ts`; `chat.test.ts` "a double-clicked retry starts one round" |

## Known gaps

- `TURN_TIMEOUT_MS` and `APPROVAL_MS` are fixed constants; the paths they trigger are tested directly, not by waiting.
- A confined command left running when Myrmidon is killed outright (not shut down) is not leashed: it ends at its
  own timeout at most. Leashing every command would add a process per call.
- A chat message sent again after a dropped connection has no client id, so a manual retry can post it twice.
- The log keeps the first 8000 characters of a tool result; a step repaired on resume sees that much.
