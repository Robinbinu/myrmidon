# TODO

Requests queued while other work is in progress. Top of each section is next.

## Done this session (not listed below)

- [x] **Projects** (b67c0f1 + UI): pick a folder (folder browser, since the page can't open a native picker); a
      chat started in it works there (shell cwd, fs tools read/edit the real files, escapes refused) and follow-ups
      inherit it; the sidebar nests each project's chats under a collapsible folder row with "new chat here".
- [x] **Manus-style research habits** (00fead2, d04e3cb): update_todo recitation, long pages saved to scratch with
      an excerpt, scripts/APIs for bulk data, stale-knowledge guard (remembered models/prices lose to sources,
      past-year search note), stop/publish discipline.
- [x] **Model errors** (af3abfd): refusals and hard errors pause the round with the error shown and "Continue with
      <model>"; failed replies never enter context; transient errors retry quietly.
- [x] **Two team modes + Fable's orchestration fixes** — orchestrated (lead + specialist roster, per-role models,
      dormant workers, lead has no web/shell/fs) and swarm; triage tiers; auto-verify; `ask_user`; harness docs,
      `read_docs`, capability summary; team picker UI; run/workspace views.
- [x] **Swarm never spins up a lead** — one-agent swarm rounds use a peer; solo-tier work goes to the whole swarm.
- [x] **Context stored and reused on resume** — per-agent JSONL transcripts (like omp/Claude Code sessions).
- [x] Live-run fixes: ordered `create_task` in one batch, blocked tasks don't wake assignees, numbered tasks not
      deduped, no peer-made "final answer" task, `task-final` points to `reply_user`.

## Next

- [x] **One colony per chat** — follow-ups are rounds of the chat's colony (`round/started` in its log): agents keep
      their conversation, files keep their versions; tasks, plan, budgets and snapshots are per round. Older chats
      with a colony per round still read, and their next round continues the latest colony.
- [x] **A livelier start for a new chat** — the wait was ~7s of a static card: every message re-probed each model
      with a test call before starting. Probes are now cached for 15 min (wait ~3s, the triage call), and the card
      ticks off its steps with a running clock and a progress sweep.
- [x] **Should all tools be MCP?** No: Claude Code, omp and Codex keep built-ins native and use MCP for outside
      services. Taken instead: tools load on demand (omp's essential/discoverable split) — browser, dev server,
      tool making, MCP and made tools stay out of model calls until find_tools loads them or the request plainly
      needs them; ~5.5k → ~2.8k tokens of tool definitions per call. Serving colony tools over MCP (so outside
      harnesses can join) is open for later.
- [ ] **Model providers cannot be removed** (reported 2026-10-07) — removing a provider in Settings → Models does not
      work; reproduce and fix.
- [ ] **Respect each model's context window; redesign the model-error card** (reported 2026-10-07) — switching a long
      chat's lead to Apple's on-device model (8K window) sent its whole 125K-token history and failed; the error card
      shows the raw provider message and offers a retry that cannot help.
- [ ] **Talk to one lead; helpers appear only when needed** (asked 2026-10-07) — sending a message should feel like
      talking to a single lead agent. Simple tasks stay with that one agent; for bigger ones the lead brings in more
      agents as the work calls for it. Drop "picking the right team" and anything that puts workers in the person's face
      up front; make it feel intuitive and intelligent.
- [x] **Web UI crash** ("q/U is not a function", window goes black) — Chrome 152's scrollIntoView returns a Promise,
      and the agent terminal's effect returned it (`useEffect(() => el.scrollIntoView())`); React called it as a cleanup
      on unmount and tore the whole tree down. Effects now have block bodies, and a test fails on any that does not.
      Found with `bun run dev`, which prints the browser's errors with component names.
- [x] **Collapsible terminal tabs and task tabs** — each agent command and each task folds (newest/running commands
      and active tasks start open), with Expand all / Collapse all, like the Git view.
- [x] **Design fixes** (ui-ux-pro-max audit; web-artifacts-builder's anti-slop rules) — AA contrast for muted and
      status text in both themes, stronger control borders, an 11px floor for tiny text, hover-only actions visible
      on touch, reduced-motion for pulsing animations, a dark-mode bubble instead of a white slab, one result card
      per round (verdict, files, changes), and a phone layout (no rail, view picker, panel starts closed).
- [x] **Replay the agent's computer** (2a81043) — a timeline scrubber in the Computer view: keyframes per
      browser action (screenshot + cursor + highlight, stored as blobs and logged), step back through what an
      agent did, "jump to live".
- [x] **Computer view for non-browser work** (e919d1a) — show the agent's terminal and the file it is editing live in the
      same panel when it is not browsing (Manus shows the terminal/editor too).
- [x] **Smarter harness prompts** (9440c44: craft + delivery contract, lead brief template, date/env, thinking
      levels, tool when/when-not, `working` doc, stop-with-task reminder; A/B measured) — agents (even Opus 5.5) act dumb in Myrmidon. Study the system prompts, tool
      descriptions and agent docs of strong harnesses (omp's own prompts in node_modules, Claude Code, Codex,
      OpenHands, Aider) and rewrite ours: role briefs, tool descriptions with when/when-not and examples,
      planning and verification habits, how to read the snapshot, how to use the board/notes/mail well.
      Update the harness docs (`packages/runtime/docs/*.md`) agents read via `read_docs` to match.
      Measure before/after with the eval prompts.
- [x] **Slash commands and omp's controls** (a9abbe1: /plan /steer /queue /stop /resume /retry /new /rename /mode /model /thinking /team /attach /export /mcp /settings /help; plan mode; thinking setting. model switch mid-round: `/model` or POST /api/chats/:id/model, logged as agent/model. compaction: near the model's window, older messages are summarized for the model (pi's generateSummary, folded forward), the log keeps everything. checkpoints/rewind: project rounds are snapshotted at start and end in a shadow git repo (the project's own git untouched); each round shows its changes with a diff, Rewind restores the folder, Undo reverts that) — slash commands in the composer (/plan, /model, /team, /mode,
      /stop, /retry, /resume, /thinking, /attach, /clear …) with an autocomplete menu; plan mode (show the plan
      for approve/edit before an expensive team round); per-agent thinking level; other omp session controls
      worth copying (compaction, checkpoints/rewind, model switch mid-chat). Agents learn them from the docs.
- [x] **Real browser for agents** (0980c14: puppeteer-core + system Chrome, browser_* tools, artifact: URLs) — proper web access: rendered pages, clicking,
      forms, screenshots, JS-heavy sites, and dev features for web apps the colony builds (open the built
      page, read console/network errors, run checks, screenshot for the judge). Research options first:
      Playwright, omp's built-in browser relay, browser-use, Stagehand, chrome-devtools MCP.
      First look (2026-10-06): Playwright's accessibility-snapshot model is the agent-friendly default (text-only,
      fast, cross-browser; Playwright MCP is built on it); Chrome DevTools MCP is better for debugging (console,
      network, Web Vitals, traces). Plan: playwright-core in-process (TS, no Python), snapshot/click/type/eval
      tools, plus CDP for console/network; live view via CDP Page.startScreencast frames over the existing
      websocket, takeover by forwarding mouse/keyboard (Input.dispatch*).
- [x] **Watch and take over the agent's browser** (28ad606, 7e12c96: Computer view, live screencast, agent cursor + element highlight, take control/hand back, full screen, IDE-style workspace bar) — when an agent browses, the person can see the live page
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
- [x] **MCP support** (b28de8d, 871c787) — let colonies use MCP servers (stdio/HTTP) as tools: config in Settings (import from
      omp's mcp.json), tool discovery, per-server enable, sandbox/approval rules, docs for agents.

- [x] **Resume after a shutdown or stop** — when the server restarts or a round is stopped, continue from
      where it was (re-create agents from the log, restore tasks/claims/notes/plan, re-deliver pending
      inbox items) instead of marking the round stopped. Explicit "Resume" action in the UI.
- [x] **Agents create their own tools** — `create_tool` (script + typed inputs, sandboxed, must pass a test run)
      → `tool_<name>` for the colony, carried into later rounds; "Keep" in the Files view adds it to the library
      (`<home>/tools`), which every new round loads; library in Settings → Tools.
- [x] **Eval harness** (`bun run eval`, apps/eval): six cases across the pillars (answer, build, research, coding in
      a fixture project, browser) with code-based checks plus the colony judge; trials → pass@k / pass^k and
      medians; JSON reports, `--compare`; exits 1 on tier mismatch or budget breach. First run (DeepSeek V4 Pro):
      3/3 pass, but reading one page heading took 132s and 11 tool calls on the solo tier.
- [x] **Fast path for small browser tasks** — answer tier gets a read-only browser (open + snapshot) and triage
      routes "open X and tell me Y" there; the judge sees what agents observed and is told its memory may be stale
      (it had failed a correct answer from memory). Eval `browser-heading`: 132s → 9s, 98k → 6k tokens.
- [x] Observer counts tool calls as progress (no stall warnings mid-research).
- [x] Per-round token budget (`budget.tokens`) and, for chat rounds, spend and token limits in Settings → Team &
      budget; at 80% agents are told to wrap up, at 100% the round stops.
- [x] Chat index (`<home>/chat-index.sqlite`): the list re-reads only logs whose files changed (53 colonies:
      16–21ms per poll → ~1ms); full folds only for the chat being acted on.
- [x] Harden the timing-sensitive tests: five tests waited on wall-clock (a 1s stall tick that ignored `quietMs`,
      and an 8s quiet wait after `ask_user`); the round now pauses as soon as a question is open and everyone is
      idle. Suite 52s → 18s, passes 3× in parallel.
- [x] **Terminal and Git views in the workspace** — Terminal: your own login shell in the project folder (Bun PTY +
      xterm.js; the socket only opens for the dashboard's own origin), kept alive across tabs; the agents' sandboxed
      commands moved to "Agent commands". Git (project chats): branch, ahead/behind, uncommitted changes with diffs,
      history with each commit's diff — read-only. Answer-tier agents in a project can now read its files.
- [x] **Workspace bar always visible** — the right icon rail stays on screen even when the panel is closed;
      clicking an icon opens that view's panel, and the panel has a close button that collapses back to the rail.
- [x] **Git view, advanced** — collapsible Uncommitted changes and History sections; VS Code Source Control
      (staged / unstaged / untracked groups, file tree, inline diff) meets GitLab (commit graph-like history with
      authors and dates, commit detail with file tree + side-by-side or unified diff, stats).
- [x] **Slash menu redesign** — a command palette: Recent + grouped commands (Round / Team & model / Chat / App) with
      icon tiles and current values, fuzzy match with highlighted letters, commands that can't run now dimmed with
      the reason, and omp-style argument completion (/model lists models, /mode and /thinking their choices, current
      one checked); ↑↓ ↵ Tab Esc with a hint footer.
