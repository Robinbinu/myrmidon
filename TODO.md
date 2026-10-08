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
- [x] **A restart no longer strands a running round** (asked 2026-10-07: "unable to send message when the agents
      are working") — `bun --watch` restarts on every edit; the round stayed "running" in the log with nothing
      running it, so new messages were refused. Rounds now record their process; at startup an orphaned one is
      logged as stopped (Resume offered) and the chat takes messages again.
- [x] Live-run fixes: ordered `create_task` in one batch, blocked tasks don't wake assignees, numbered tasks not
      deduped, no peer-made "final answer" task, `task-final` points to `reply_user`.

## UX audit (2026-10-08)

From the product-readiness inspection: every screen at 1440×900 and 960×600, two code audits, and a hands-on run
of every flow (chat, coding with approvals, /plan, crew, @mention, attach, slash commands, every Settings form,
server down). Letters are fix groups; each group owns its files so they can be worked on in parallel.
`[decide]` items change product behaviour and wait for the person's call.

### A — Runtime bugs (`packages/runtime`)

- [x] **Shell commands write into the project** — `sandbox.ts:63` sets `HOME` to the working folder, so one
      `python3 -m unittest` left 68 files under `<project>/Library/Caches/…` ("71 files changed", Commit all
      would commit them). Give commands a private home outside the project.
- [x] **Plan mode never shows the plan** — plan mode says "present it with ask_user" (`prompts.ts:310`) but
      `ask_user` has nowhere to put a plan (`question` is "a short line"). Add a plan/detail field, render it above
      the choices.
- [x] **A worker's reply to an @mention never reaches the chat** — `@ion …` after a finished round: ion answered
      (visible only in the Crews console), the lead's thinking showed instead, and the observer stopped the round
      as "stalled: every agent is idle and the work is not finished".
- [x] **"Verified" on unreviewed rounds** — with No review, steps show "judge · Judge approved" and the console
      "crew COMPLETED (verified)" while the same console says "this round is not reviewed"; Compare says "judge
      passed" next to a score of "—".
- [x] **Status line says "Drafting …" while waiting for an approval** — show "Waiting for your approval".

### B — Composer & slash menu (`chat/Composer.tsx`, `chat/TeamControls.tsx`, `chat/CommandMenu.tsx`, `chat/ModelPicker.tsx`)

- [x] **Stop hides while you type during a run** (`Composer.tsx:634`) — show Stop next to Send.
- [x] **Esc in the slash menu erases the draft** (`Composer.tsx:529`) — Esc closes the menu only.
- [x] **`/mode` + Enter runs `/model`** — an exact command name wins over a prefix match.
- [x] **`/plan` listed twice** (recent + Round); **inapplicable commands crowd the menu** ("Nothing is running" ×5
      on a new task) — sink them below the applicable ones.
- [x] **`/help` reopens the same menu**; **`/export` gives no feedback** — a toast naming the file.
- [x] **Focus stays on the Steer/Queue toggle after clicking it**, so Enter flips it instead of sending.
- [x] **Files over the limit are dropped silently** (`Composer.tsx:300`, size only checked at send) — say so when
      they are added.
- [x] **Chips truncate their own labels** ("DeepSe…", "No pr…", "D") — collapse Thinking/Reviewer/Helpers into one
      Team chip when the composer is narrow; keep the model name readable.
- [x] **Helper naming drifts** — "Never" shows as "Solo", "Always" as "Team of 3", "Auto" as "2 helpers"; the
      `/team` popover says "2 helpers · called by the lead" while the chip says "Team of 3".
- [x] **Solo throws the helper roster away** (`TeamControls.tsx:321`) — keep it and flip a flag.
- [ ] **Model picker**: duplicate entries (Claude Haiku 4.5, Opus 4.5 under two ids), mixed naming ("Claude 4 Opus"
      vs "Claude Opus 4"), the sticky provider header covers half a row; helper model picker opens on top of the
      helpers popover.
      **Left:** duplicate dated ids and header overlap fixed; mixed names ("Claude 4 Opus" vs "Claude Opus 4") come from the model registry and were left alone.
- [x] **@mention menu** — show each agent's face; include the lead.
- [ ] **`/learn` on a trivial chat starts a paid job and never reports what it found.**
      **Left:** the result toast exists, but the "Reading this chat…" toast disappears after 3.5s while the job runs longer; needs a lasting progress line.

### C — Status, colour & time (`ui/primitives.tsx`, `chat/Sidebar.tsx`, `chat/AgentSheet.tsx`, `chat/Workspace.tsx`, `chat/StepRow.tsx`, `chat/AuditView.tsx`, `ColonyScreen.tsx`, `ColonyMap.tsx`, `Compare.tsx`, `legacy.css`)

- [x] **One status → tone map** — "waiting for you" is a red dot in the sidebar; every finished agent shows a red
      "stopped" badge above "completed"; the same state is stopped / Resting / completed on three screens; stopped
      is red, amber or grey depending on the screen. Awaiting = accent, stopped/idle = neutral, failed = red.
- [x] **Times are UTC** — `step.time.slice(11,16)` on ISO strings (`StepRow.tsx:71`, `Workspace.tsx`,
      `AuditView.tsx`, `ColonyScreen.tsx:493`); format in local time.
- [x] **Unknown cost shows `$0.000`** (Crews, Compare) — show "n/a"; durations as "23m 35s", not "1415s".
- [x] **Compare** — table overflows at 1440 (last column cut), run ids wrap over many lines, "solo · orchestrated",
      no warning when two different tasks are compared.
- [ ] **Map** — "lead lead", "stopped … stopped", no links between agents.
      **Left:** "lead lead" and repeated status fixed; links between agents not drawn.
- [x] **Accessible names include the sleeping "z"** ("z lead stopped …") from the pixel face.
- [x] **legacy.css uses the amber accent as text** (~1.9:1, `legacy.css:121,174`); `.pill`/`.dot` duplicate
      `Badge`/`Dot`.

### D — Chat stream & cards (`chat/RoundView.tsx`, `chat/Markdown.tsx`, `chat/QuestionCard.tsx`, `chat/ApprovalCards.tsx`, `chat/RoundChanges.tsx`, `chat/DiffView.tsx`, `chat/GitView.tsx`)

- [x] **Bold text containing code shows raw backticks** (`Markdown.tsx:28` doesn't parse inside `**…**`); markdown
      headings render as `<p>`.
- [x] **Question answers are lost if sending fails** (`QuestionCard.tsx:57` marks sent first); "Adjust the plan"
      should open its text box; two Skip buttons ("Skip", "Skip all, you decide").
- [x] **Approval cards** — an approved card vanishes from the chat; the card renders above the lead text that came
      before it; Approve/Deny are 22px tall.
- [x] **No "jump to latest"** once you scroll up during a run (`hooks.ts:124`).
- [x] **Screen readers re-read the reply on every streamed chunk** (`RoundView.tsx:559` aria-live).
- [x] **"No changes in <project>" rows** after every turn and before work starts — hide when nothing changed.
- [x] **Run stopped card + red Stopped banner** say the same thing twice — merge.
- [x] **"Checking…" can spin forever** when the changes fetch fails (`RoundChanges.tsx:50,89`).
- [x] **Diff / Git** — junk files listed first, no folder grouping or "binary" label, paths cut at the end (cut
      the middle), Git panel not refreshed after Rewind.

### E — Settings (`Settings.tsx`, `ui/primitives.tsx` Field, `chat/SpecialistEditor.tsx`, `chat/MadeTools.tsx`)

- [x] **One-click deletes with no confirm or undo** — credentials, custom providers, MCP servers, specialists,
      schedules, memories, kept tools (`MadeTools.tsx:150`); **Revoke device** has no confirm and shows for this
      device (`Settings.tsx:2153`). Reuse the plugin page's two-step remove.
- [x] **Validation fails silently** — custom endpoint: name silently lowercased ("my server!"), "not a url"
      accepted, Connect just stays disabled; `NumberField` snaps back; custom cron never checked. Inline errors.
- [x] **Form labels aren't linked to fields** (0 `htmlFor` across 36 `Field`s) — `Field` generates the id.
- [x] **Hooks lose unsaved edits silently** when you switch section; **a failed autosave** only toasts and the header
      returns to "saved" — keep "Couldn't save · Retry".
- [x] **Settings navigation** — 14 flat sections in an odd order; group into Setup (Models, Team & budget,
      Reviewer), Agents (Specialists, Instructions, Memory, Skills), Extend (Tools, Plugins, Hooks, Schedules),
      You (General, You & mascot, Devices); at 960 wide the nav and app sidebar leave ~400px.
- [ ] **New specialists get every tool** (Web, Shell, Files, Browser, MCP) — start from the least access; native
      select for hundreds of models → ModelPicker.
      **Left:** validation and ModelPicker done; the default tool set is unchanged, see [decide].
- [x] **Providers page** — jargon ("omp's provider stack in-process", models.dev), a raw folder path, 80 sign-ins,
      "Sign in again" but no Sign out; Devices offers "Pair a device" on a local-only install; the Hooks "run as
      you, outside the sandbox" warning is plain small text.
- [ ] **Skills page** — every `~/.claude/skills` skill is on by default, shown as walls of text with raw paths.
      **Left:** descriptions clamped and paths moved to tooltips; which skills are on by default is a [decide] item below.

### F — First run, loading & errors (`App.tsx`, `chat/Hero.tsx`, `api.ts`, `DeviceGate.tsx`, `chat/FolderPicker.tsx`)

- [x] **No path from first run to a model** — with no key the model picker says `No models match ""` and Send toasts
      "Choose a lead model first"; Settings can't be opened at Models. Setup card on the home screen, call to action
      in the picker, providers page pins the big providers when none is ready.
- [x] **No composer until `/api/models` succeeds** (`App.tsx:669`) — render it disabled with a retry.
- [x] **Server down shows raw "Failed to fetch"** banner + toast — "Reconnecting…" state; map HTTP errors to plain
      copy (`api.ts:44`); 401 on a remote gateway goes back to pairing.
- [x] **"Chats only" devices see everything** — `whoami().me.scope` is never read; hide Settings, Terminal, Devices,
      Plugins for that scope.
- [x] **Empty states flash before data loads** (sidebar, Crews, `?chat=` deep link; a bad id stays on the hero).
- [ ] **New chat resets the composer** to the default lead and helpers, dropping what the person picked.
      **Left:** could not reproduce in-session (choices persist via localStorage); fixed the one real loss (`helpers: always` dropped on reload). If it recurs, keep the last composer config on the server.
- [x] **Adding a project leaves the open chat** and lands on a new task.
- [x] **The home greeting quotes the last chat title** (`"Add a multiply(a,…" is done`); the "G 26×29" selection
      box over the greeting reads as a bug.
- [x] **960×600: the mascot pushes the composer off-screen** — shrink it on short windows.

### G — Workspace panel & sidebar (`chat/Workspace.tsx` rail, `chat/Sidebar.tsx`, `App.tsx` layout)

- [x] **The Files panel opens on every chat, even "No files yet"** (~440px) — open it when there is content.
- [x] **Rail of 10 unlabeled icons with "99+" badges**; Terminal does nothing without a project and doesn't say
      why; the rail doesn't scroll at 600px tall; Team tab has no empty state.
- [ ] **Search matches titles only** ("391" finds nothing); deleting a chat has no undo.
      **Left:** message search done; undo after deleting a chat skipped (delete removes the folder at once; undo needs a pending-delete state).
- [ ] **Chat titles are the prompt verbatim** ("Hi", "Hi", "hi") — short generated titles.
      **Left:** not done: short titles need a model call (cost), see [decide].
- [x] **Unexplained sidebar numbers** (5, 2, 3).
- [x] **Dead mobile code** contradicts the 960px minimum (`App.tsx:559-583`, Sidebar `md:` variants).

### H — Copy & design system (`copy.ts`, `tokens.css`, `styles.css`)

- [x] **Glossary pass** — crew/colony/team/helpers/peers, Judge/Reviewer/Verdicts/verifier, round, "Observer
      interval", "PASS on colony", Steer/Queue ("Send now" / "After this step"); raw backend strings rendered as-is.
- [x] **Tokens bypassed** — 12 arbitrary radii and no `--radius*` use, 7 sizes between 11–14px, `--scrim` unused,
      dark theme written twice; destructive fill ~2.9:1 white-on-red; hit targets under 24px.
- [x] **In-app Reduce motion** doesn't reach `useReducedMotion()` users (Hero, cursor, pixel); `.caret` blinks
      forever.
- [x] **Modals** — no focus trap; one Esc closes two stacked modals (`Modal.tsx:24`); AgentSheet doesn't move or
      restore focus.

### Follow-ups found while fixing

- [ ] Contrast below 4.5:1 left: dark avatar initials in the Git view (2.57:1), muted text on `fill-strong` (4.04:1).
- [ ] Hit targets under 24px remain in a few places outside the composer, chat and Settings.
- [ ] The crew console's Reviews list and activity still name the reviewer by its runtime id (`llm-judge#0`); the
      replay bar shows the raw `checkpoint/restored` event type.
- [ ] No test for the modal Escape stack and focus trap (needs a DOM test setup); the artifact viewer opened inside
      the crew console was not exercised by hand.
- [ ] `/learn`: keep a progress line while the review runs (the toast disappears after 3.5s).
- [ ] Message search scans the messages table with `instr`; move to FTS5 if chat history grows large (FTS5 trigram
      can't match queries under 3 characters).

### [decide] Product calls

- [ ] Default project permission is **Autonomous** (edits and commands without asking) — make "Ask first" the
      default?
- [ ] Spend limit per round defaults to **0 = no limit** (one stored run cost $6.90) — default cap?
- [ ] Helpers default to **Claude Opus 5.5**; pickers show no prices — cheaper default, show $/Mtok?
- [ ] **"Approve all for this chat"** on approval cards (7 approvals for one small fix).
- [ ] Desktop shell: native menu bar (⌘N new chat, ⌘K palette, ⌘, Settings window), window chrome inset for the
      traffic lights, dock badge when a chat waits, system folder picker, "Show in Finder" / "Save to project" on
      files.
- [ ] Merge Crews (ColonyScreen) into the chat Workspace so there is one console.
- [ ] New specialists start with every tool on (Web, Shell, Files, Browser, MCP) — start from the least access?
- [ ] Every `~/.claude/skills` skill is on by default for Myrmidon agents — off until switched on?
- [ ] Short generated chat titles (one cheap model call per new chat)?

## Next

Open work, in the order it will be done:

1. - [x] **Crew mail like a conversation** (done: messaging norms, threads, reply reminder, chat-style Mail tab) — agents see mail and ignore it; they should read and reply, coordinate
      like people in a chat (the person's words: "make it more human").
2. - [x] **Plugins phase 4: agents build plugins** (done) — create_plugin / test_plugin / propose_plugin and the speaker
      brief; a request for a Myrmidon feature becomes a plugin the person switches on (spec 2026-10-07-plugins).
3. - [x] **Per-tool MCP approvals** (done) (OpenDots) — tools a server marks read-only run on their own, others ask; each
      tool switchable and kept across refreshes; an approval binds to the exact tool and arguments.
4. - [x] **Stop a turn when a permission changes** (done) (OpenDots) — revoking a permission, disabling a tool or pausing
      aborts the agent's in-flight turn at once.
5. - [x] **Interrupted runs: review before retry** (done) (OpenDots) — a round stopped mid-way after side effects outside
      Myrmidon (MCP writes, shell) shows what it already did before resuming.
6. - [x] **Streaming replies** (lead-first step 2) — the lead's text appears as it is written.
7. - [x] **Helpers appear quietly** (lead-first step 3 remainder) — "Brought in nova (research) and kai (frontend)"
      as one compact line when the lead adds agents.
8. - [x] **Personal entry page + mascot customisation** — one smart headline (no subtext) in the mascot's voice,
      from what happened while the person was away, written by the lead model with a built-in fallback; name from
      the computer account, editable; Settings → You & mascot: eyes, look (pixel flower / pixel bow tie), colour,
      and what the screen shows (rotating clock / HI NAME / crew at work).
8b. - [x] **Crew group chats** (asked 2026-10-07) — besides one-to-one mail, agents can start group chats with some
      of the crew, and there is one team chat everyone is in; used like people use WhatsApp groups ("make it more
      human like"). The Mail tab shows them as conversations. Also fix the reminder's side effect seen on
      2026-10-07: agents send "✔ end of thread, please don't reply" / "sent only to clear the unanswered-mail flag"
      just to quiet it; a message that needs no answer (an ack, "no reply needed") should close the thread.
8d. - [ ] **Plugin reload test is flaky under load** — "editing the code reloads the plugin…" failed once in a full
      `bun run check` (15 s, fs.watch timing) and passes alone; make its wait condition-based.
8c. - [ ] **Browser flow test fails when run alone** (seen 2026-10-07; same on the commit before group chats; passes
      in the full `bun run check`): "a browser flow is saved after its test run and replays with new inputs", run
      with `-t`, gets "Protocol error (Accessibility.getFullAXTree): Session closed" instead of the failed-step
      message. Chrome 154.0.8037.98. Find why the page closes after a failed click in a fresh browser.
9. - [x] **Review-before-save cards** (OpenDots) — wherever Myrmidon already asks, the card shows the change in full
      (a file against what is there, a commit's patch, a command, a call's arguments); text can be rewritten before
      approving and a decline can carry a note; `propose` lets an agent show a file or commit first; approved writes,
      commits and MCP calls keep a receipt so the same call in the same round is not run twice. Not yet looked at
      in the browser (needs a live round waiting on a review).
9b. - [x] **@mention a worker from the composer** (asked 2026-10-07; the person chose: the worker replies directly,
      an idle crew starts a round with that worker) — typing @ offers the crew; the worker hears it (the lead is only
      told) and answers with reply_person under its own name; in a round opened that way its answer finishes it.
10. - [x] **Saved specialist agents** (OpenDots) — Settings → Specialists (name, specialty, instructions, model,
      tool groups); joined from the team picker, by the lead with spawn_worker(specialist), or saved from a worker's
      sheet; a kept specialist always works as currently saved.
11. - [x] **Learn skills from past chats** (OpenDots idea; built after Qwen Code's skill review) — a reviewer reads a
      finished round with 20+ tool calls (or any, with /learn or the round's button) and proposes a skill or an update
      to a learned one (`source: learned`, never the person's own); kept or discarded in the chat card or Settings →
      Skills; kept skills go to every chat.
11b. - [ ] **Retire stale learned skills** (Qwen Code's curator) — learned skills nobody used for 30 days marked stale,
      archived after 90; needs use counts from use_skill.
11c. - [x] **Remote gateways** (asked 2026-10-08, "like Hermes agent / OpenClaw"; research
      docs/research/2026-10-08-remote-gateways.md, spec docs/superpowers/specs/2026-10-08-remote-gateways-design.md)
      - [x] Step 1: remote server mode — --host/--public-url, exact Host/Origin allowlist, device pairing
        (`myrmidon pair`, single-use 10-minute codes), HttpOnly device cookies (`__Host-` over HTTPS), full/chat
        scopes, Settings → Devices with revoke, auth audit log, docs/remote.md.
      - [x] Step 2: previews from a remote gateway — --preview-port/--preview-url, per-device preview keys (revoke
        ends previews), preview Host allowlist, a note instead of a broken frame when a device has no preview address.
      - [x] Step 2b (asked 2026-10-08): set up a VPS gateway from the CLI alone — `myrmidon setup` wizard, `login`
        (device codes, pasted redirect or an SSH-forwarded callback; full auth URL instead of omp's loopback
        launcher), `key` (hidden or piped), `model` (saved once it answers), `doctor` (runs the sandbox, exits 1 on
        problems); SIGTERM shuts `serve` down cleanly for systemd.
      - [x] Step 3: one client, N gateways — Settings → Gateways (pair by link), gateways.json (0600) keeps tokens
        off the page, /gw/<id> forwards API calls and bridges sockets, previews through the hub's preview origin,
        sidebar switcher per window, HTTP + socket health, a "can't reach" screen; revoking a device now closes all
        its sockets (terminals too); Bun's stop() hang after server-closed sockets worked around.
11d. - [ ] **Channels** (asked 2026-10-08, "like OpenClaw and Hermes"; research docs/research/2026-10-08-channels.md,
      spec docs/superpowers/specs/2026-10-08-channels-design.md)
      - [x] Step 1: channel core + Telegram text — ChannelHub (pairing codes, owner/members, groups by approval and
        mention, one chat per conversation, /new /stop /status /help, status line, chunked answers, dedupe and saved
        offset), Telegram over plain HTTP, Settings → Channels, `myrmidon channels`, doctor, docs/channels.md.
      Asked 2026-10-08: "port everything they do" (OpenClaw + Hermes, both MIT; adapt onto ChannelHub, credit them).
      - [x] Step 2 (core parity): approve/deny and question buttons (text /approve fallback), delivery ledger with
        retries and restart replay, media in (photos, files) and out (round files), voice notes transcribed,
        streaming modes (progress | partial | final), access policies (pairing | allowlist | open | disabled for
        DMs and groups, mention on/off), group sessions per user, a `send_message` tool for agents, schedules that
        deliver to a channel, `ctx.channels.register` for plugins, webhook ingress for webhook-based platforms.
      - [ ] Step 3: WhatsApp (Baileys linked device; Meta Cloud API).
      - [ ] Step 4: Discord, Slack.
      - [ ] Step 5: Signal (signal-cli), iMessage (imsg / BlueBubbles), Matrix, Mattermost, email (IMAP/SMTP).
      - [ ] Step 6: Microsoft Teams, Google Chat, LINE, SMS (Twilio), Feishu/Lark, DingTalk, WeCom.
      - [ ] Step 7: IRC, Twitch, X, Nostr, Zalo, Synology Chat, Nextcloud Talk, ntfy, SimpleX, Tlon, WeChat, QQ, webhook.
12. - [ ] **Voice calls** (OpenDots, as a plugin) — a fast voice model that hands work to the lead.
13. - [ ] **Native UI phase 3+** — overlays, context menus, sheets, Settings as System Settings (spec
      2026-10-07-native-ui).
14. - [ ] **Agents' browser and private addresses** — decide a rule (e.g. only ports the round opened) and DNS-pinned
      fetching in omp to close rebinding (69456b5 notes).
15. - [ ] **Look over in the browser** — Settings → Plugins page and the rewind confirmation sheet were checked only
      through their endpoints (the browser pane was hidden).
16. - [ ] **M4.7 benchmarks** (deferred).

Earlier items:


- [x] **Take what fits from CopilotKit/OpenDots** — researched (MIT); SSRF gap fixed (69456b5); the rest is listed
      above as their own items (3-5, 9-12).

- [x] **Rewind only undoes the round's own files** (done) — rewinding the crew round that edited Myrmidon restored the whole
      project snapshot and rolled back unrelated, newer commits (5d75622's files). Restore only files the round
      changed; ask before overwriting files changed after it.
- [x] **Plugins, like DeepSeek Harness** (phases 1-3 done; phase 4 is item 2 above: folders, Claude Code parts, Settings → Plugins, server code with ctx, UI slots; next: phase 4, agents build plugins) — ~/.myrmidon/plugins/<name>/ with plugin.json;
      contributes tools, skills, hooks, prompt sections, settings, UI in defined slots; hot reload; Settings →
      Plugins; agents asked for a Myrmidon feature build a plugin with create_plugin instead of patching source (Myrmidon
      will ship compiled, so plugins are the only way to extend it).

- [x] **Interactive agent questions + ask before building** (done) (approved design): `ask_user` takes 1-4 questions
      (header, 2-4 options with descriptions, single/multi select); the chat shows option cards with "Other…" for a
      custom answer and Skip ("use your judgment"), one Send answers all; the round waits. The lead asks scoping
      questions with ask_user before building when the request leaves real choices open (audience, style, stack,
      scope), not when it is specific or the person says "just do it"; check_in only for small mid-work preferences.
      Answers reach the agent as "Question → Answer" lines, skipped ones marked. Starts after the strings/prompts
      refactor merges (same files: tools.ts, patterns.ts → prompts.ts, RoundView.tsx).

- [x] **One place for strings, config and UI decisions** (5d75622, 4e37220: copy.ts, tokens.css, ui-config.ts; prompts.ts, config.ts) — move user-facing copy to a single strings file, and
      tunable config + colours/UI decisions to single files, so wording and look are easy to edit later.

- [x] **Thinking time + thinking transcripts** ("Thought for 7s" above the reply; live clock) — the person reports the thinking timer not working and the model's
      thinking not visible (check the new one-on-one chat view's clock and where thinking text shows).

- [x] **Chat first, colony on demand** (2809593) — a message should get a plain chat reply, not a colony run card every
      time. The lead decides later to spin up a colony (a tool it calls) or the person opts in (an option). Needs a
      short design before building (extends lead-first steps 2-3: streamed reply, quiet helpers).
- [x] **Rename "colony" in the UI** (5c6f10f: "crew") — the person finds it boring; offer name options with the chat-first design.

- [x] **Light-mode status colours pop** (2f7f30b) — red/yellow/green look dull in light mode (dark mode is fine); use
      Apple's light system colours (systemRed/Orange/Green) for `--bad`, `--warn`, `--ok` and their soft fills.

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
- [x] **Model providers cannot be removed** (423c0e7: on/off switch for providers whose keys live elsewhere) (reported 2026-10-07) — removing a provider in Settings → Models does not
      work; reproduce and fix.
- [x] **Respect each model's context window; redesign the model-error card** (f902329, 51fb148, 3d4fac3) (reported 2026-10-07) — switching a long
      chat's lead to Apple's on-device model (8K window) sent its whole 125K-token history and failed; the error card
      shows the raw provider message and offers a retry that cannot help.
- [x] **Talk to one lead; helpers appear only when needed** (lead-first step 1 + chat-first 2809593; streaming is its own item) (asked 2026-10-07) — sending a message should feel like
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
