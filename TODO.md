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
- [x] **Claude via subscription sign-in (from omp)** — omp's own claude.ai OAuth (provider `anthropic`), now
      a "Sign in with a subscription" card in Settings → Keys & providers (Claude, ChatGPT, Gemini, Copilot…).
      Your stored Claude login expired 2026-09-01 (refresh token invalid), so sign in again there.
- [x] **Steer vs queue for messages to a running colony** — Steer/Queue toggle in the composer while a round
      runs (Alt+Enter sends the other way); steer joins the agent's next step, queue waits until it finishes.
- [x] **Read receipts for messages sent mid-run** — "Read by lead" under the bubble once the agent actually
      ingests it; the run card sits below the latest mid-run message.
- [ ] **Attach files as context** (like omp) — attach files/images in the composer; carried into the round as
      artifacts or context the agents can read.
- [x] **Markdown artifacts** — Rendered / Source tabs and "Copy markdown" in the artifact viewer.
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
