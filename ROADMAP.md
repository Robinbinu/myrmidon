# Roadmap

Myrmidon is four things at once: a **coding harness**, a **browser agent**, a **swarm orchestrator**, and an
**agent harness** underneath all three. This plan orders the work so each step makes the next one measurable.
It folds in the open items from TODO.md and the best-in-class review (2026-10-06); TODO.md stays the queue for
small requests.

Reference points (October 2026): Claude Code (hooks, skills, subagents, worktree isolation, checkpoints),
Codex and Cursor (parallel agents on git worktrees, background/cloud agents that return a reviewable diff),
Manus (browser operator on the person's own logged-in browser), and the WebVoyager / BrowseComp / GAIA /
SWE-bench leaderboards.

## Where we stand

| Pillar | Have | Biggest gaps |
| --- | --- | --- |
| Coding harness | Projects (agents work in a real folder), shell, fs read/write/edit, terminal + editor in the Computer view, plan mode, slash commands, resume with transcripts | No git awareness: no checkpoints or rewind, no diff review, no per-agent isolation. No project instructions file, code search, or diagnostics. The judge doesn't run tests. |
| Browser agent | Real Chrome over CDP, aria snapshot with refs, click/type/press/eval/console/screenshot, live view with cursor and highlight, take over, replay | No login handoff or per-project profiles, one tab per agent, no downloads, fetched pages not treated as untrusted, no saved workflows |
| Swarm orchestrator | Orchestrated (lead + roster) and swarm (huddle, then claim), persistent workers, mail, task board, judge, model-error pause | Parallel coders share one folder, no mid-round escalation, judging isn't tailored to the type of work, no spend visibility, coordination gaps |
| Agent harness | Event-sourced log, transcripts, MCP, sign-ins, thinking levels, prompts tuned by A/B, docs agents can read | No eval suite, no memory across chats, no hooks, no self-made tools or skills, no budgets, no audit trail |

## Milestone 0: Measure first — done

Status (2026-10-07): all done. Eval harness is `bun run eval` (apps/eval); budgets, run-card spend/time-left, chat index, timing-test fix; spawn cap is `maxWorkers`.

Every later milestone changes prompts or tools. Without numbers, we can't tell whether a change helped.

1. **Eval harness** (`scripts/eval.ts`, opt-in, real models). Fixed prompts per pillar:
   - one coding task in a fixture repo
   - one browsing task
   - one research task with sources
   - one swarm build

   Run each in both modes. Record wall time, tokens, $, tool calls, workers, verification rounds and judge
   score, and write a JSON report so runs can be diffed.
2. **Spend and budgets**:
   - Show live $ and time left in the run card.
   - Add `budget.tokens` per round, enforced like the cost limit.
   - Cap `spawn_worker` per round.
   - Wind down gracefully near a limit: publish what's done and say what's missing.
3. **Global chat index** in SQLite, so the sidebar doesn't open every colony log. Projects make the list grow
   faster.
4. **Harden the two timing-sensitive chat tests.**

## Milestone 1: Coding harness core — done

Status (2026-10-07): all done — checkpoints + rewind, round diffs and the Git view (stage/commit), AGENTS.md/CLAUDE.md, grep/glob/run_checks + project outline, judge runs checks and returns graded findings, per-project permissions (autonomous / ask / read-only), dev servers, compaction.

This makes a project chat as trustworthy as Claude Code or Codex in the same folder.

1. **Checkpoints and rewind.**
   - Before a round's first write to a git project, snapshot the work tree (stash-like commit on a hidden ref).
   - Per-round "Rewind to here" in the transcript.
   - For non-git folders, keep a copy of each file before its first edit.
2. **Diff review.**
   - A Changes view in the workspace shows a per-file diff of what the round changed in the project.
   - Accept (keep), revert per file or per hunk.
   - Optional "commit with message" (never push).
3. **Project instructions.** Read `AGENTS.md` / `CLAUDE.md` / `.myrmidon.md` from the project root into the
   environment section at kickoff.
4. **Code tools.**
   - `grep` (ripgrep) and `glob` tools that respect `.gitignore`.
   - A `diagnostics` tool: typecheck/lint via the project's own scripts first, LSP later.
   - A cheap repo map (files + exported symbols) for the lead's first look.
5. **Verification for code.** For code work, the judge runs the project's test/check script and reads the
   failures. Its findings are graded (file, problem, severity) and go back as targeted fix tasks.
6. **Permissions.**
   - Per-project policy: shell in the project may be allow, ask, or deny.
   - Writes outside the scratch area are allowed or need asking.
   - "Ask" uses the existing `ask_user` pause with an Approve/Deny card.
7. **Dev-server preview.**
   - A `serve` tool starts the project's dev server in the sandbox and registers its port.
   - The agent browser opens it, and the person sees it in the Computer view.
8. **Compaction.** Summarize old turns when an agent nears its context window (transcripts already store
   them; `compactTranscript` is the start).

## Milestone 2: Browser agent — done

Status (2026-10-07): all done — login handoff, untrusted-content spotlighting, tabs/downloads/uploads,
`browser_extract`, `browser_network`, saved browser flows, and browser evals on local fixture sites (shop search,
form fill, table lookup; all three pass). The evals showed answer-tier agents needed the full browser toolset and
that a broken MCP server could eat a round, so MCP servers now trip a breaker after 3 failures in a row.

1. **Login handoff.**
   - The agent calls `ask_user` with "sign in here"; the person takes control in the live view and signs in,
     then hands back.
   - The profile persists per project, so the sign-in survives.
   - The agent never types passwords.
2. **Untrusted content.**
   - Fetched pages and snapshots are wrapped and labeled as data.
   - The prompt says instructions found in them are not to be followed.
   - Tool calls that follow a page's instructions get flagged in the log. (Review: safety.)
3. **Tabs and downloads.**
   - `browser_tabs` / `browser_switch`; several tabs per agent.
   - Downloads land in scratch as artifacts.
   - `browser_upload` sends a scratch file to a file input.
4. **Structured extraction.** `browser_extract(schema)` returns JSON from the current page (a model call on
   the snapshot) for tables and listings, instead of long snapshots in context.
5. **Network panel.** A `browser_network` tool (failed requests, XHR bodies on demand) for debugging the web
   apps the colony builds.
6. **Saved workflows.** A successful browser sequence can be saved as a replayable tool with parameters
   (ties into self-made tools in Milestone 4).
7. **Browser evals.** A WebVoyager-style subset in the eval harness, with replays from keyframes.

## Milestone 3: Swarm orchestrator — done

Status (2026-10-07): 1 (worktree per coding worker), 2 (escalate), 3 (judging by kind of work) and 4
(coordination: reject_task, check_in, worktrees refreshed on claim; final verification was already lead/speaker
only) done. 5 done: `read_log` for agents, and a run diff in Compare runs (`/api/compare`). 6 done: the Tasks panel has a
live board (lanes by status, time in each, stacked when narrow). Milestone 3 complete. Eval `coding-team-git` passes in both modes; the swarm
run hit a real conflict (two peers fixed the same file) that the worker resolved in its worktree.

1. **A worktree per coding agent.**
   - In a git project, each worker that writes code gets its own `git worktree` on a round branch.
   - The lead (or a merge step) integrates the branches and resolves conflicts, then the judge runs tests on
     the merge.
   - This is how Cursor and Claude Code run parallel agents safely.
2. **Escalate mid-round.** An `escalate(to: solo|team, reason)` tool for answer/solo agents. The round
   restarts at the higher tier and keeps artifacts, notes and conversation (reuses carryOver).
3. **Judging by type of work.**
   - The judge picks its method by kind of work: tests for code, citation fetches for research, a rubric
     plus "did it answer the ask" for writing.
   - It defaults to a different model or provider than the workers.
   - Fix the answer-tier contradiction in verification.md.
4. **Coordination hardening.**
   - `reject_task` with a required reason.
   - `request_final_verification` only for the lead or speaker.
   - Non-blocking `check_in` for the person alongside blocking `ask_user`.
5. **Log for agents.**
   - A read-only, filtered event-log tool, so a lead can see what a worker actually did.
   - Run diff in Compare runs.
6. **Live board.** The task board streams in the workspace while the round runs.

## Milestone 4: Agent harness

Status: 1 (memory across chats: agents propose, the person keeps; Settings → Memory), 2 (self-made tools) and 3
(skills: Agent Skills format from Myrmidon's folder, ~/.claude/skills and the project; harness docs stay in
read_docs) and 4 (hooks: Claude Code's format, before/after tools and at round end, Settings → Hooks) done;
the rest open.

1. **Memory across chats.**
   - Per-user preferences and decisions, with provenance and an editor in Settings.
   - Per-project "lessons learned" that the lead reads at kickoff.
   - Agents propose new memories; the person sees them.
2. **Self-made tools.**
   - `create_tool` (script + input schema, sandboxed) usable in the colony that made it.
   - "Add to library" to reuse it in later colonies, plus a gallery.
3. **Skills.** Packs of docs and scripts (like Claude Code skills) that agents load by name when a task
   matches; the harness docs become the first skills.
4. **Hooks.** Deterministic rules the person configures, for example "after every fs_edit run the formatter"
   or "before shell, check the deny list". They run in the harness, not in the prompt.
5. **Background and scheduled rounds.** Start a round from the CLI or a schedule, and get notified when it is
   done and verified.
6. **Safety and audit.**
   - Secrets kept out of scratch and out of logs.
   - A per-tool permission list (generalizing Milestone 1's project policy).
   - An audit view of every file, URL and command each agent touched (the event log already has the data).
7. **Benchmarks.** SWE-bench Verified, GAIA, BrowseComp subsets, plus our own suite. Report accuracy and $
   per solved task, with replays.

## Later: native apps

The browser app is the first client, not the last: OS-agnostic native UIs come later. So the server's HTTP and
WebSocket API and the event protocol (`@myrmidon/protocol`) are the contract every client builds on. Behaviour
belongs in the runtime and server, not in web-only client code, and new features should be reachable through
that API so a native client gets them too.

## Order and why

- Milestone 0 comes first because the A/B on prompts showed how easily changes trade quality for time; we
  need the numbers on every later step.
- Milestone 1 comes next because projects just landed and editing a real folder without checkpoints and diff
  review is the riskiest gap right now.
- Milestone 3's worktrees depend on Milestone 1's git layer.
- The browser work (Milestone 2) is mostly independent and can run alongside Milestone 1.
- Milestone 4 builds on everything: hooks need the permission layer, and memory and skills need evals to
  prove they help.
