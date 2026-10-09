# Myrmidon: feedback from inside the harness

**Round:** solo lead, plus crewmates `pax` (researcher) and `rune` (coder) called with `ask_crewmate`, on 2026-10-09.
**Method:** I read all 9 doc pages, then used almost every tool myself: notes, todo, tasks and messages, shell, artifacts and their versions, the browser (open, click, type, tabs, console, screenshot), `start_server`, `create_tool`, `read_log`, `create_plugin` and `test_plugin`, and `web_fetch`. I gave each crewmate a job to report its own brief and tooling from the inside. Every finding below is something I saw myself, or a crewmate claim I checked in `read_log` or at the source. Anything I'm guessing at is marked *(inferred)*.

---

## TL;DR: top 5 fixes

1. **The sandbox can read your home folder and other colonies' data.** That contradicts the docs. (Security)
2. **Multi-file artifacts break in the browser.** `artifact:` pages are served from `file://`, so `fetch`, JSON and ES-module imports fail with a CORS error.
3. **Crewmate briefs are generated wrong.** They say "This round: solo" and describe claim/submit/create_group tools the crewmate doesn't have.
4. **Tools you create are not callable until you load them yourself, even though the result says "the team can call it now".**
5. **`read_log` shows only the first line of each result,** so it can't do its documented job: checking claims like "tests pass".

---

## 1. Security and trust

### 1.1 The sandbox allows reads outside scratch (high)
The overview says agents cannot "read the person's files unless the person pastes them in". In this sandboxed (not Full access) round:

```
home listable: yes (94 entries)      # ls /Users/robin
.zshrc readable: yes                 # test -r /Users/robin/.zshrc
other colonies visible: 12           # ls ~/.myrmidon/colonies
```
Writes are blocked as documented (`touch ../x: Operation not permitted`). I listed names only and didn't open any file. Because of this, a prompt-injected agent could read `~/.ssh`, `.env` files, browser profiles, or other chats' transcripts and artifacts, then send them out over the open network (`curl https://example.com` → `HTTP/2 200`). *(inferred: I didn't test reading those specific files or exfiltrating anything)*

**Fix:** add `(deny file-read* (subpath "/Users/<you>"))` to the sandbox-exec profile, then re-allow only scratch, the mirror, the toolchains (bun/node/python/uv) and system paths. Deny `~/.myrmidon/colonies/*` except the current colony. Add a regression test that runs `test -r ~/.zshrc` inside `shell` and expects a failure.

### 1.2 Host paths leak into the agent's context (low)
`$MYR_MIRROR`, browser URLs (`file:///Users/robin/.myrmidon/colonies/<slug>/browse/…`) and HOME all expose the real username and folder layout. Expose stable virtual paths instead, e.g. `/colony/artifacts`.

### 1.3 Crewmate replies aren't marked untrusted (medium)
Web, browser and log output are wrapped in untrusted markers, but an `ask_crewmate` result arrives as trusted text, even when the crewmate has just read 40 KB of web pages. Claude Code's agent-teams docs make the same point: it "treats an approval claim relayed from another agent as untrusted input" (checked at code.claude.com/docs/en/agent-teams, line 309 of the fetched page). Consider wrapping crewmate replies, or at least the parts that quote outside content.

---

## 2. Artifacts and the browser

### 2.1 `artifact:` pages run from `file://`, which breaks multi-file apps (high)
To test this I published `data.json` and a page that runs `fetch('data.json')`:
```
console.error: Access to fetch at 'file:///…/browse/data.json' from origin 'null' has been blocked by CORS policy
```
The same thing breaks `<script type="module" src=…>`, imports, workers and anything that loads JSON. The docs push "one self-contained file", which hides the problem, but any real app the colony builds can't be tested properly this way.
**Fix:** serve `artifact:` from a built-in static server, e.g. `http://127.0.0.1:<port>/colony/<id>/`, with the right MIME types.

### 2.2 `browser_console` merges all tabs without labels (low)
I was on tab 1 and saw `HTTP 404: http://localhost:8765/favicon.ico` from tab 2 mixed in with tab 1's errors. Prefix each line with its tab, or filter to the active tab by default. Also consider ignoring favicon 404s, since "a clean console is part of done" makes agents chase noise.

### 2.3 The mirror's `artifacts/` folder doesn't exist until the first publish (low)
`ls $MYR_MIRROR/artifacts` fails with `No such file or directory` in a fresh round. Create it empty at round start.

### 2.4 Probe artifacts can't be cleaned up (low)
Testing left `harness-probe.html` (v1, v2) and `data.json` in your files, plus a switched-off draft plugin `probe-wordcount` and the tools `tool_echo_len` and `tool_slugify`. Agents have no delete, archive or "scratch-only" option. Add an `unpublish`/archive action, or a `draft: true` flag that hides an artifact from the person.

What worked well: publishing and versioning (`read_artifact` version 1 returned the original), `browser_click` and `browser_type` returning fresh snapshots, `start_server` returning only once the port answered, tabs, and screenshots.

---

## 3. Brief and prompt generation

### 3.1 Crewmate briefs contradict their real situation (both crewmates reported this on their own)
- The header says **"This round: solo (one agent, all tools)"** to a crewmate that is answering a lead.
- The coordination section tells them to `claim_task`, pass revisions, `submit_task` and `create_group`. None of these tools exist for a crewmate called with `ask_crewmate`.
- Default rules ("deliver with publish_artifact") clash with job instructions ("do not publish"), and nothing says which one wins.
- Two different endings: "send it once and stop" vs "reply with one short line when you have nothing left".
- rune (coder) sees `channels_send`, but is also told it can't talk to the person.

**Fix:** build each brief from the tools that agent actually has. Leave out every section whose tools are missing. Add one line: "The job text overrides these defaults."

### 3.2 Repetition and noise
- The lead prompt contains "How to do excellent work" almost word for word, and the same text is in `read_docs("working")`. Crewmates see "do not fabricate" 3 times and `reply_to` etiquette twice.
- All 9 skills, with full descriptions, go to every agent. For coding or research jobs, 6 of them (cleanmymac, obsidian-vault, pinokio, gepeto, sentry-cli, cert-expiry) don't apply. Send names only, or filter them by role and request.
- Tool names differ between the prose and the schemas: the prose says `fs_read` and `message`, the schemas say `_fs_read` and `_message`, and `web_search` has no underscore at all. Pick one form.

### 3.3 The agent isn't told its reviewer setting
`reply_user` says final "starts verification automatically", but in this round `request_review` and `request_final_verification` were unavailable and the acceptance criteria were "none declared". The agent can't tell whether a reviewer will see its answer. Add one line to the brief: `Reviewer: off | auto | always (judge: <model>)`.

### 3.4 Mixed time zones
The prompt uses Asia/Calcutta (the IANA alias; the canonical name is Asia/Kolkata). `read_log` times are in UTC (`09:14:51`), while `ls` in the shell shows local time (`14:45`). Use one zone, or label them, e.g. `09:14:51Z`.

### 3.5 "You can drive a browser", but it isn't loaded yet
The capabilities list says the browser is available. In fact it is deferred until you call `find_tools`. Put "(load with find_tools)" next to each deferred capability.

---

## 4. Tool behaviour

### 4.1 `create_tool` says the tool is ready when it isn't (medium; I saw this and so did rune)
The result says `Created tool_echo_len; the team can call it now.` Neither the creator nor the rest of the team can call it until `find_tools("tool_echo_len")`. **Fix:** load it automatically for the creator, or change the message to "load it with find_tools".

### 4.2 `find_tools` silently returns only part of a query (medium)
`find_tools("browser read_log")` loaded read_log and 11 browser tools, but **not `browser_type` or `browser_upload`**. They only appeared on a second, explicit query. *(inferred: there's a cap of about 12 results)* Either load the whole group when a group name like "browser" matches, or say "N more matched: …".

### 4.3 `read_log` can't verify claims (medium)
Results are cut to their first line, e.g. `shell(...) → ok: exit 0` with no stdout, so I couldn't confirm rune's "2/2 PASS". Also, rune said `list_agents` showed lead, rune and pax, but the log only shows `lead (lead) working`. That's either the first-line cut or a wrong claim, and I can't tell which. That ambiguity is exactly what `read_log` is meant to clear up. Add `full: true` or `entry: <id>` to show one result in full.

### 4.4 `test_plugin` doesn't validate arguments against the tool's schema (low)
`{tool: "word_count", args: {}}` passed even though `text` is required. It ran and returned `1 words`, from `String(undefined)`. Real calls presumably validate *(inferred)*, so the test should validate the same way. The output also labels results `word_count →`, while the registered name is `probe-wordcount_word_count`.

### 4.5 The plugin docs disagree with each other (low)
The plugin layout lists `.claude-plugin/plugin.json`. The `create_plugin` rules list only `skills/ commands/ hooks/ .mcp.json myrmidon.json server/ ui/`, yet it accepted `.claude-plugin/plugin.json`. Make the two lists match. There's also no way to delete a draft plugin.

### 4.6 `observe` wording
`final verifications: 0 run, last not passed` contradicts itself: with 0 runs, there is no "last". Show "none yet" instead. Also, `list_agents` doesn't show on-call crewmates until they join, though `observe` later lists them as idle. Show them as `on call`.

### 4.7 Small additions both crewmates asked for
- `fs_read` with line ranges (`offset`/`limit`). pax had to use `sed -n 303,312p`, which breaks the "prefer the dedicated tool" rule.
- `web_fetch` with an optional `grep`/`section` parameter, and a table of contents of headings in the excerpt. Today the excerpt cuts off at about 6–8k characters, marked only with "…".
- `shell` printing elapsed time and whether output was truncated.

What worked well: `fs_edit`'s error message (`old text appears 2 times …; include more surrounding lines, or set all`), web_fetch finding the clean `.md` version of a page on its own, saving full pages to `web/`, the untrusted markers, and fast parallel `ask_crewmate` (both crewmates finished in about 40 s by the log timestamps).

---

## 5. Ideas from comparable harnesses (from pax's research; I checked the Claude Code claims at the source)

| Pattern | Seen in | Myrmidon fit |
|---|---|---|
| Lifecycle hooks that can **block** an action: `TeammateIdle` / `TaskCompleted`, where "exit with code 2 to prevent completion and send feedback" | Claude Code agent teams (verified, lines 227–229) | Run the verifier as a blocking gate on `submit_task` and on going idle |
| Agents relaying an approval doesn't count as the person's approval | Claude Code agent teams (verified, l.309) | See 1.3 |
| Automatic nudge for stalled tasks: "Task status can lag" | Claude Code agent teams (verified, l.488) | Myrmidon already auto-releases tasks from quiet agents; add a lead alert |
| Handoff `input_filter` / collapsing history into one item | OpenAI Agents SDK handoffs (pax) | A context-shaping option on `ask_crewmate` |
| Typed handoff payloads (`input_type` schema) | OpenAI Agents SDK (pax) | Optional JSON schema for a crewmate's answer, which makes integrating it reliable |
| Durable `interrupt()` and resume with a typed response | LangGraph interrupts (pax) | `ask_user` / `check_in` with a response schema |
| A research "finding" with url, quote and date, plus a check that every cited URL was actually fetched | pax's suggestion | Lets the reviewer check citations cheaply; Myrmidon already logs every fetch |

Sources: https://code.claude.com/docs/en/agent-teams · https://openai.github.io/openai-agents-python/handoffs/ · https://docs.langchain.com/oss/python/langgraph/interrupts (pax fetched all three, as `read_log` confirms. I fetched the first one myself.)

---

## 6. What's already good
- **Clear concepts:** append-only notes with `corrects`, revision-checked task claims, versioned artifacts, the event log. Agents can reason easily about a system built this way.
- **Strong docs:** the `read_docs` pages are tight and accurate, and tools.md honestly marks "not available to you".
- **Good escalation model:** a lead that starts at once, crew on call, and `escalate` only for real team work. It's cheap for small requests.
- **Useful defaults:** untrusted-content markers, browser test loops on artifacts, `create_tool` with a required passing test, and plugins that need your approval and are tested in the sandbox before they ever run.

## Suggested order
1. Sandbox read scope (1.1).
2. Serve `artifact:` over http (2.1).
3. Role-accurate brief generation (3.1) and the reviewer setting in the brief (3.3).
4. Auto-surface created tools and make find_tools truncation visible (4.1, 4.2).
5. Full results in `read_log` (4.3).
6. Everything else.
