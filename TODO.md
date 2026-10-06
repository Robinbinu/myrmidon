# TODO

Requests queued while other work is in progress. Top of each section is next.

## Done this session (not listed below)

- [x] **Two team modes + Fable's orchestration fixes** — orchestrated (lead + specialist roster, per-role models,
      dormant workers, lead has no web/shell/fs) and swarm; triage tiers; auto-verify; `ask_user`; harness docs,
      `read_docs`, capability summary; team picker UI; run/workspace views.
- [x] **Swarm never spins up a lead** — one-agent swarm rounds use a peer; solo-tier work goes to the whole swarm.
- [x] **Context stored and reused on resume** — per-agent JSONL transcripts (like omp/Claude Code sessions).
- [x] Live-run fixes: ordered `create_task` in one batch, blocked tasks don't wake assignees, numbered tasks not
      deduped, no peer-made "final answer" task, `task-final` points to `reply_user`.

## Next

- [ ] **Smarter harness prompts** — agents (even Opus 5.5) act dumb in Myrmidon. Study the system prompts, tool
      descriptions and agent docs of strong harnesses (omp's own prompts in node_modules, Claude Code, Codex,
      OpenHands, Aider) and rewrite ours: role briefs, tool descriptions with when/when-not and examples,
      planning and verification habits, how to read the snapshot, how to use the board/notes/mail well.
      Update the harness docs (`packages/runtime/docs/*.md`) agents read via `read_docs` to match.
      Measure before/after with the eval prompts.
- [ ] **Slash commands and omp's controls** — slash commands in the composer (/plan, /model, /team, /mode,
      /stop, /retry, /resume, /thinking, /attach, /clear …) with an autocomplete menu; plan mode (show the plan
      for approve/edit before an expensive team round); per-agent thinking level; other omp session controls
      worth copying (compaction, checkpoints/rewind, model switch mid-chat). Agents learn them from the docs.
- [ ] **Real browser for agents (Playwright or alternative)** — proper web access: rendered pages, clicking,
      forms, screenshots, JS-heavy sites, and dev features for web apps the colony builds (open the built
      page, read console/network errors, run checks, screenshot for the judge). Research options first:
      Playwright, omp's built-in browser relay, browser-use, Stagehand, chrome-devtools MCP.
- [ ] **Watch and take over the agent's browser** — when an agent browses, the person can see the live page
      in the UI (screencast), follow what the agent clicks, and take control (pause the agent, drive it, hand
      back), like Claude's browser pane.
- [x] **Workers persist across a chat's messages** — later rounds reuse the same workers (names, specialties,
      models, and their transcripts) instead of spawning new ones; the lead keeps or dismisses workers
      (`dismiss_worker`), and spawns new ones when needed.
- [x] **Swarm negotiates before executing** — on a new request every peer wakes, discovers the others
      (list_agents, roster), and they agree on the plan and who does what (proposals on the board/notes,
      claim by agreement) before anyone starts work. No single seed executing straight away.
- [x] **Mail view** — a Mail tab showing the agent-to-agent conversation (mail/sent, board posts, @mentions),
      threaded by participants.
- [x] **Show agents' thinking** — "Thought" rows in the run card expand to the full reasoning (the agent sheet and
      colony console already showed it). Live token streaming is not logged, so it appears per step.
- [x] **Send feedback in a new chat** — optimistic user bubble + PendingRound with the mascot thinking.
- [x] **Idle faces go to sleep** — agent avatars doze (closed eyes + drifting "z") after 15s idle.
- [x] **Claude via subscription sign-in (from omp)** — omp's own claude.ai OAuth (provider `anthropic`), now
      a "Sign in with a subscription" card in Settings → Keys & providers (Claude, ChatGPT, Gemini, Copilot…).
      Your stored Claude login expired 2026-09-01 (refresh token invalid), so sign in again there.
- [x] **Steer vs queue for messages to a running colony** — Steer/Queue toggle in the composer while a round
      runs (Alt+Enter sends the other way); steer joins the agent's next step, queue waits until it finishes.
- [x] **Read receipts for messages sent mid-run** — "Read by lead" under the bubble once the agent actually
      ingests it; the run card sits below the latest mid-run message.
- [x] **Attach files as context** — paperclip / drop / paste in the composer; files become `uploads/…` artifacts,
      the agent is told to read them, images reach vision models through read_artifact.
- [x] **Markdown artifacts** — Rendered / Source tabs and "Copy markdown" in the artifact viewer.
- [ ] **MCP support** — let colonies use MCP servers (stdio/HTTP) as tools: config in Settings (import from
      omp's mcp.json), tool discovery, per-server enable, sandbox/approval rules, docs for agents.

- [x] **Resume after a shutdown or stop** — when the server restarts or a round is stopped, continue from
      where it was (re-create agents from the log, restore tasks/claims/notes/plan, re-deliver pending
      inbox items) instead of marking the round stopped. Explicit "Resume" action in the UI.
- [ ] **Agents create their own tools/plugins** — sandboxed `create_tool` (script + input schema), usable in
      the colony that made it; "Add to library" to reuse in future colonies; a gallery to browse them.
- [ ] **Eval harness** (`scripts/eval.ts`, real models, opt-in) — run the standard prompts ("what is life",
      "can you create plugins and tools?", "build a snake game", "compare Rust web frameworks with sources")
      in both modes; record wall time, tokens, tool calls, workers spawned, worker turns before first task,
      verification rounds, judge score; fail on tier mismatch or budget breach.
- [x] Observer counts tool calls as progress (no stall warnings mid-research).
- [ ] Per-colony token budget (`budget.tokens`), enforced like the cost limit.
- [ ] Global chat/colony index in SQLite so the chat list doesn't open every colony log.
- [ ] Harden the two timing-sensitive chat tests that failed once under load.

## Roadmap from the best-in-class review (2026-10-06)

Reviewer's top three: escalation (2), judging by type of work (1), budget visibility (3).
"Have:" marks what already exists, so only the gap needs building.

- [ ] **Escalate mid-round** — an `escalate(to: solo|team, reason)` tool for answer/solo agents; the round
      restarts at the higher tier keeping artifacts, notes and conversation (reuse carryOver).
- [ ] **Verification suited to the work**
      - Fix the docs contradiction: verification.md says only the verifier completes a round, but answer tier
        is not judged (it records a `delivered` verdict). Either say so plainly or add a cheap answer check.
      - The judge picks its method by work type: run tests for code, fetch citations for research, rubric
        plus "did it answer the ask" for writing.
      - Graded findings (what failed, where, severity) instead of a bare score, fed back as targeted fixes.
      - Default the judge to a different model (or provider) than the workers. Have: judge model is configurable.
- [ ] **Cost/time visibility and limits** — live spend + time left in the run card; per-round token/$ budget
      (overlaps "per-colony token budget" above); cap spawn_worker per round with a cost check; graceful
      wind-down near the limit (publish what is done, say what is missing). Have: `observe` for team agents,
      wall-time and cost limits, maxWorkers.
- [ ] **Coordination hardening** — `reject_task` with a required reason; restrict `request_final_verification` to
      the lead/speaker. Have: claim leases expire after 120s idle (LEASE_MS), and a released task wakes the lead
      (orchestrated) or the idle peers (swarm).
- [ ] **Use the event log** — read-only filtered log view for agents; replay/step-through and run diff in the
      UI (Compare runs exists, extend it); replay saved rounds against new models/prompts as an eval set
      (ties into the eval harness above).
- [ ] **Memory across rounds** — per-user preferences/decisions store with provenance and an editor; per-chat
      "lessons learned" note the lead reads at kickoff. Have: plan note and files carry between rounds.
- [ ] **Stronger tools** — code execution wherever needed; CSV/JSON/spreadsheet tools; browser automation for
      dynamic pages (omp has a browser); MCP + plugins with per-round permissions (MCP item above). Have: file
      uploads.
- [ ] **Human in the loop** — non-blocking `check_in` alongside blocking `ask_user`; show the plan before an
      expensive team round for approve/edit (fits plan mode in the omp-features item); live board streaming.
- [ ] **Public benchmarks** — SWE-bench, GAIA, BrowseComp + own suite; report accuracy and cost per solved
      task with replays from the log.
- [ ] **Safety** — label fetched web content as untrusted in prompts and keep it from triggering tool calls;
      keep secrets out of scratch; per-tool permission list; full audit trail of what each agent touched.

