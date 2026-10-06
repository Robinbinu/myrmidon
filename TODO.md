# TODO

Requests queued while other work is in progress. Top of each section is next.

## In progress

- [ ] **Two team modes + Fable's orchestration fixes** — Orchestrated (lead + specialist roster, per-role
      models, dormant workers, assigned tasks, lead has no shell/fs) and Swarm (seeded peers, one plan note,
      task dedupe, output ownership, lease release, speaker on `task-final`); triage tiers (answer / solo /
      team); auto-verify on the final answer; `ask_user` pause; harness docs + `read_docs` + capability
      summary in prompts. Runtime done; tests, team picker UI, and run/workspace views remaining.

## Next

- [x] **Send feedback in a new chat** — optimistic user bubble + PendingRound with the mascot thinking.
- [x] **Idle faces go to sleep** — agent avatars doze (closed eyes + drifting "z") after 15s idle.
- [ ] **Claude Code integration (from omp)** — omp can drive Claude models through the user's Claude Code
      login; find how omp does it (provider/auth in @oh-my-pi) and expose those models in Myrmidon's model
      picker so colonies can run on Claude.
- [ ] **Steer vs queue for messages to a running colony** — like Claude Code: a message can *steer*
      (interrupt the current turn and be read immediately, top priority) or *queue* (wait until the agent
      finishes its current step, like omp). Composer control + `chat/user` payload flag; agent.ts steer vs inbox.
- [ ] **Read receipts for messages sent mid-run** — when a steer/queued message is delivered to the lead, show it
      as read, and move the live run card below it in the transcript (chronological interleave of user messages,
      replies, and the run card); the lead can reply to it directly.
- [ ] **Attach files as context** (like omp) — attach files/images in the composer; carried into the round as
      artifacts or context the agents can read.
- [ ] **Markdown artifacts** — render `.md` artifacts as markdown in the artifact viewer, with a Source toggle
      to see the raw text and a copy button.
- [ ] **MCP support** — let colonies use MCP servers (stdio/HTTP) as tools: config in Settings (import from
      omp's mcp.json), tool discovery, per-server enable, sandbox/approval rules, docs for agents.

- [ ] **Resume after a shutdown or stop** — when the server restarts or a round is stopped, continue from
      where it was (re-create agents from the log, restore tasks/claims/notes/plan, re-deliver pending
      inbox items) instead of marking the round stopped. Explicit "Resume" action in the UI.
- [ ] **Bring over omp's harness features** — slash commands in the composer (e.g. /plan, /model, /team,
      /stop, /retry), modes (plan mode etc.), per-agent thinking level, and other controls; models should
      know how to use these (docs + prompts).
- [ ] **Agents create their own tools/plugins** — sandboxed `create_tool` (script + input schema), usable in
      the colony that made it; "Add to library" to reuse in future colonies; a gallery to browse them.
- [ ] **Eval harness** (`scripts/eval.ts`, real models, opt-in) — run the standard prompts ("what is life",
      "can you create plugins and tools?", "build a snake game", "compare Rust web frameworks with sources")
      in both modes; record wall time, tokens, tool calls, workers spawned, worker turns before first task,
      verification rounds, judge score; fail on tier mismatch or budget breach.
- [ ] Observer counts tool calls as progress (no stall warnings mid-research).
- [ ] Per-colony token budget (`budget.tokens`), enforced like the cost limit.
- [ ] Global chat/colony index in SQLite so the chat list doesn't open every colony log.
- [ ] Harden the two timing-sensitive chat tests that failed once under load.
