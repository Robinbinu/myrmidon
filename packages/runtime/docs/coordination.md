# Coordination: tasks, notes, conversations

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
- `reject_task(id, revision, reason)` — the lead (or a crewmate in a swarm) sends submitted or verified work back with
  a required reason; the owner is woken with it, claims the task again, and fixes exactly that.
- In a git project a team crewmate codes in its own worktree; claiming a task first brings the project's latest
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

## Conversations

The crew talks the way people use WhatsApp at work. `message(to, text, reply_to?)` reaches every conversation:

- **One teammate** (`to: "kai"`): wakes them. For detail only they need: handoffs, questions about their part,
  corrections.
- **A group** (`to: "api"`): wakes every member. Start one with `create_group(name, members, text?)` for a few
  people working on the same thing; `update_group` adds or removes people, and removing yourself leaves it. A
  teammate who leaves the crew leaves its groups too.
- **The team chat** (`to: "team"`): everyone on the crew is in it. Only people you `@mention` are woken; the rest
  read it with their next turn. For decisions, blockers and changes of plan everyone should know.

`read_messages()` lists your conversations with their latest message; `read_messages(with: …)` shows one with each
message's number. Answer a message with `reply_to` set to its number so the conversation threads.

- A question or request sent to you (directly, or @mentioning you in a group) that you leave unanswered gets one
  reminder. Acks, thanks and FYIs are never chased, so do not reply just to close a thread.
- Do not ask anyone for status: task changes and verdicts are announced automatically, and waking an agent
  costs a turn.
