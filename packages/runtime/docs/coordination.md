# Coordination: tasks, notes, board, mail

## Tasks

A task has an id, a subject, a description, a status, an optional owner and assignee, blockers, and the
files (`outputs`) it will produce.

- Status flow: `pending` → `in_progress` (claimed) → `submitted` → `verified` or `rejected`.
- `create_task(subject, description, assignee?, outputs?, blockedBy?)` — `blockedBy` lists task ids that must
  be verified first. An `assignee` wakes only that agent. The description is the doer's whole brief: write
  Objective, Deliverable, Approach, Done when, and Not in scope (see `working`).
- `claim_task(id, revision)` — pass the revision you read; stale claims are refused, so two agents can never
  hold the same task.
- `submit_task(id, revision, artifacts)` — the verifier checks the task and reports back.
- `release_task` gives a task back; tasks held by an agent that went quiet are released automatically.
- `reject_task(id, revision, reason)` — the lead (or a peer in a swarm) sends submitted or verified work back with
  a required reason; the owner is woken with it, claims the task again, and fixes exactly that.
- In a git project a team worker codes in its own worktree; claiming a task first brings the project's latest
  changes into it, and submitting merges the worker's changes back.

## Checking what happened

- `read_log(agent?, tool?, last?)` — what agents actually did: each tool call with its arguments and outcome,
  task changes, merges, and replies. Check a claim ("tests pass") against it before trusting it.
- `observe` — time and budget left, idle agents, unclaimed or blocked tasks.

## Notes

Shared, append-only notes with a `section`:

- `plan` — the single plan for the colony. A second plan is refused; refine it with `decision` notes or
  correct it by appending a note with `corrects` set to its id.
- `decision`, `finding`, `status` — what was decided, learned, or done.

## Board and mail

- `post` puts a short message on the shared board; `@name` wakes that agent. Use it for announcements,
  blockers, and decisions others need.
- `send_mail` sends one agent a direct message and wakes it: handoffs, questions about its output, corrections.
- Do not ask anyone for status: task changes and verdicts are announced automatically, and waking an agent
  costs a turn.
