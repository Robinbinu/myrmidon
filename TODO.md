# TODO

Requests queued while other work is in progress. Top of each section is next.

## In progress

- [ ] **Two team modes + Fable's orchestration fixes** — Orchestrated (lead + specialist roster, per-role
      models, dormant workers, assigned tasks, lead has no shell/fs) and Swarm (seeded peers, one plan note,
      task dedupe, output ownership, lease release, speaker on `task-final`); triage tiers (answer / solo /
      team); auto-verify on the final answer; `ask_user` pause; harness docs + `read_docs` + capability
      summary in prompts. Runtime done; tests, team picker UI, and run/workspace views remaining.

## Next

- [ ] **Send feedback in a new chat** — clicking send in a fresh chat shows nothing until the round starts
      (triage + preflight take seconds). Show an immediate optimistic user bubble, a "starting the colony…"
      state with the mascot thinking, and disable double-send.
- [ ] **Steer vs queue for messages to a running colony** — like Claude Code: a message can *steer*
      (interrupt the current turn and be read immediately, top priority) or *queue* (wait until the agent
      finishes its current step, like omp). Composer control + `chat/user` payload flag; agent.ts steer vs inbox.
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
