# How strong agent harnesses write their prompts, and what that means for Myrmidon's

**Date:** 2026-10-09. **Why:** the person judged Myrmidon's model-facing prompts "very very bad". This document
studies how current harnesses write system prompts and tool descriptions (Part 1), pulls out the patterns that
matter (Part 2), critiques Myrmidon's prompts against them (Part 3), and gives a rewrite plan an implementer can
follow (Part 4). The assembled prompts it critiques are in
[2026-10-09-myrmidon-prompts-assembled.md](2026-10-09-myrmidon-prompts-assembled.md).

**Method.** omp's prompts were read from the installed package (`@oh-my-pi/pi-coding-agent` 18.6.1 in
`packages/runtime/node_modules`). Everything else was read from source or official pages fetched on 2026-10-09; each
section names the files, commits and licences. Quotes are short; text under a non-open licence (Anthropic's and
OpenAI's docs and blog posts, Claude Code's prompt text) is paraphrased. Where a fact comes from the live Claude Code
session that wrote this, it is marked *(observed)*; anything not checked at the source is marked *(inferred)*.

**Summary.** Myrmidon's prompts are not badly worded sentence by sentence; much of the text is in line with the
best harnesses. They fail on **assembly**: every agent receives blocks written for other roles, naming tools it does
not have and workflows that contradict its own brief (a crewmate is told it is the solo agent with every tool, and
to claim tasks it cannot claim). On top of that: rules are unranked and repeated, the role comes after generic text,
safety sits in an unheaded tail, nearly half of all tool parameters (65 of 139) are undocumented, tool descriptions do not change with
configuration, and delegation briefs are thinner than the task briefs right next to them. The fix is mostly
mechanical: replace the per-role strings with an assembler of guarded sections computed from the agent's real role,
tools, model family and round settings, in a fixed cache-friendly order with headings and one home per rule; then let
the sections evolve from measured evidence (prompt versions in every run's log, eval A/B before shipping, learned
rules and per-model blocks proposed from finished runs). Part 4 is the plan.

## Part 1. The harnesses

### 1.1 omp (oh-my-pi), the harness Myrmidon builds on

**Source.** `@oh-my-pi/pi-coding-agent` 18.6.1, MIT (Stencil Labs; contributor Mario Zechner, from pi). Files:
`src/prompts/system/system-prompt.md` (13 KB template), `subagent-system-prompt.md`, `project-prompt.md`,
`date-cwd-reminder.md`; tool texts in `src/prompts/tools/*.md` (`bash.md`, `todo.md`, `task.md`, `read.md`,
`grep.md`, `ask.md`, `yield.md`); assembly in `src/system-prompt.ts`. **Myrmidon does not use these prompts**: it
builds its own system prompt in `patterns.ts` and passes it to `pi-agent-core`'s `Agent`; it borrows only omp's
search, fetch, MCP and settings code (`omp/runtime.ts`, `mcp.ts`).

**Structure.** A Handlebars template whose sections are marked with `§`: Role → Runtime (Skills & Rules, Internal
URLs, Tool Inventory) → Scratchpad → Tool Policy (General, Tool I/O, Specialized Tools, Exploration, AST,
Delegation) → Workflow (1 Scope, 2 Research Before Editing, 3 Decompose, 4 Implement, 5 Verify or Hand-off,
6 Cleanup) → Delivery (`<contract>`, `<completeness>`, `<evidence-and-output>`, `<yielding>`) → Critical. Project
context (`project-prompt.md`) is a separate block: `<workstation>` (OS, arch, model…), `<repo-rules>` with the
context files, `<dir-context>` for nested AGENTS.md, `<workspace-tree>`, then a closing `<critical>`. Date and cwd
come as a `<system-reminder>` in the conversation, not in the system prompt.

**Tone.** Deliberately telegraphic. It opens by defining RFC 2119 keywords and uses MUST/NEVER/SHOULD throughout;
sentences are compressed to fragments ("Retry empty/partial/narrow results differently"). The changelog records
cutting the default prompt by about 150 tokens "while preserving its guidance". This style is dense and cheap but
reads like a spec; it suits models tuned on it and is the opposite of Anthropic's advice for Claude 4.x (1.3).

**Every line is conditional on the tools present.** Nearly every rule is wrapped in `{{#has tools "x"}}`: the
"use `edit`, never `sed`" rule exists only when `edit` exists; the delegation section only when `task` exists; the
verification section differs for a subagent. This is the single most important difference from Myrmidon (Part 3,
§3.1).

**Tool descriptions** are short and dense (bash is six lines; todo five; read is a list of path suffixes). They
carry mechanics (path syntax, paging, what is truncated and where the full output goes: "full result at
`artifact://<id>`") and hard when-not rules ("NEVER call todo alone: init with first work"). `ask.md` is a model of
restraint: ask only for "materially different tradeoffs the user must decide"; otherwise pick the conventional
choice, proceed and state it.

**Long-horizon work.** Todo must list "EVERY user item separately"; never a todo-only turn; a stop reminder fires
with open items. The Critical section forbids yielding while actionable work remains and forbids narrating budgets
or effort.

**Verification.** For the main agent: "Non-trivial work: NEVER yield without a smoke run", with "Tests alone are
not proof", and per-surface rules (web: open a browser tab and get visual proof; CLI: launch the program; bug:
reproduce before, confirm after). For subagents the opposite: do not run builds or tests; the main agent verifies
once, because parallel runs "storm the CPU and trip on siblings' half-finished edits".

**Delegation.** Gated by a setting (`delegationBias`): off unless asked, "inline first", or eager. Gates: map slices
and shared contracts first, never outsource the top-level plan, fan out in one batch, "Agents lack conversation:
supply full slice requirements", sequence only true dependencies, one integration owner for shared edits. The `task`
tool asks for a shared `context` (`# Goal`, `# Contract`) and per-task `task` with `# Target` (files, non-goals),
`# Change`, `# Acceptance`, plus a `solutionSpace` field saying how open-ended the problem is. The subagent prompt
says the assignment wins over the plan where they conflict, forbids progress reports to the parent ("never progress
or completion reports"), and requires a structured `yield` with an `error` path; "Giving up is a last resort".

**Environment.** OS, arch, model and other workstation facts in `<workstation>`; repo rules and nested rule files;
a depth-3 workspace tree by mtime; date and cwd as a reminder message, with "Do not repeat this information".

**Leaves out.** Personality (optional slot), anything about tools not present, re-reading AGENTS.md ("NEVER
`grep`/`glob` for `AGENTS.md`… relevant files already in context").

### 1.2 Claude Code (Anthropic)

**Source.** Prompt pieces as extracted per version by Piebald-AI/claude-code-system-prompts (MIT repository;
the text itself is Anthropic's), commit `e5fac17e`, Claude Code v2.1.295 (2026-10-08): `system-prompt-*` fragments
(harness instructions, executing actions with care, communication style, doing tasks, writing subagent prompts,
subagent delegation restraint and cost guidance) and `tool-description-*` (TodoWrite, Edit, Write, Bash, Agent,
TaskCreate). Docs: code.claude.com/docs/en/sub-agents and /agent-teams. Plus the environment block of the session
that wrote this document *(observed)*.

**Structure.** Assembled from many small conditional fragments (about 900 tracked strings), roughly: intro and
security policy → harness (output is Markdown, permission modes, system reminders, hooks, prefer dedicated tools,
`file_path:line_number`) → doing tasks (scope discipline: no unrequested features, error handling, abstractions or
compatibility shims) → executing actions with care → tool usage (subagents, task tracking, parallel calls) →
communicating with the user → environment, memory (CLAUDE.md) and git status. Individual fragments are small
(roughly 100-1,100 tokens); the tool descriptions carry much of the weight (TodoWrite about 2,000 tokens, Agent usage
notes about 2,000).

**Tone.** Second person, calm, explanatory; newer fragments give the reason for each rule and have almost no
capitals; older tool texts still use IMPORTANT/NEVER.

**Tools.** Bash is a one-line summary plus dozens of separately versioned bullets (dedicated tools over shell
equivalents, git safety, timeouts, sandbox). Edit explains the line-number prefix of Read output, uniqueness of the
old string, and `replace_all`. **TodoWrite** is the reference example of a judgement-heavy tool: when to use (7
cases), when not to (4 cases), four positive and four negative examples each with a reasoning note, exactly one item
in progress, never mark done while tests fail. The Agent tool: the agent types with descriptions, results are not
visible to the user (relay them), verify what a subagent claims, never poll or predict a background agent's result,
self-contained prompts, say whether to write code or only research.

**Safety.** Judge actions by reversibility and blast radius: local reversible steps are fine; destructive,
hard-to-reverse or shared-state steps need confirmation; an approval covers its scope only; no destructive shortcuts
(skipping hooks); investigate before deleting; uploading to third-party services counts as publishing; report
failures truthfully with their output.

**Long horizon.** Track work in todos/tasks and mark items done immediately; once a task is agreed, carry it
through; announcing a step without making the call hands control back with the work undone; for UI, run it in a
browser, and say so if you could not.

**Delegation briefs** (the writing-subagent-prompts fragment, paraphrased): brief the subagent like a capable
colleague who has just walked in; give the goal and why it matters, what is already known or ruled out, enough
context for judgement calls, a length limit, and the exact command for lookups. One line is worth quoting: "Never
delegate understanding." Do not write "based on your findings, fix it"; pass the paths and line numbers. Restraint:
delegate only independent, large or parallel work; never spawn just to re-verify; do not redo delegated work; a
subagent handed your hypothesis tends to confirm it, so give an independent reviewer the code, not your conclusion;
when in doubt, do not spawn.

**Environment** *(observed)*: a `# Environment` list (working directory, git repo or not, platform, shell, OS
version), the model name and exact id with its knowledge cutoff, today's date, and a git status snapshot (branch,
main branch, status, recent commits) labelled as a snapshot in time.

**Output style.** The user sees text, not tool calls; one short sentence before the first call; lead with the
outcome; readable beats compressed; tables only for short facts; `file_path:line_number`; no emojis; comments only for
constraints the code cannot show.

**Leaves out.** Planning or summary documents unless asked; speculative abstractions; validation for impossible
cases; new README or .md files unless asked.

### 1.3 Anthropic's published guidance

Sources (all © Anthropic, paraphrased): *Prompting best practices* (platform.claude.com/docs/en/build-with-claude/
prompt-engineering/claude-4-best-practices); *Building effective agents*, Appendix 2 (anthropic.com/research/
building-effective-agents); *Writing effective tools for agents* (anthropic.com/engineering/writing-tools-for-agents,
2025-09-11); *Effective context engineering for AI agents* (anthropic.com/engineering/
effective-context-engineering-for-ai-agents, 2025-09-29); *How we built our multi-agent research system*
(anthropic.com/engineering/multi-agent-research-system, 2025-06-13) with its example prompts in
anthropics/claude-cookbooks (`patterns/agents/prompts/research_lead_agent.md`, `research_subagent.md`, MIT).

- **Write for a capable newcomer.** Would a colleague with little context understand the prompt? Explain why a rule
  exists; the model generalises from the reason.
- **Say what to do, not only what not to do**; match the prompt's own style to the output you want; separate parts
  with XML tags or Markdown headings; use a few varied examples in `<example>` tags.
- **Drop aggressive emphasis.** Replace "CRITICAL: you MUST use this tool when…" with "Use this tool when…"; newer
  models over-apply shouted rules.
- **Set the default for action** explicitly (act vs. suggest), and for parallel tool calls.
- **Long tasks:** tell the model its context may be compacted so it does not stop early; keep state in files (progress
  notes, test lists) and git.
- **Overeagerness:** no extra files, abstractions or defensive code beyond the request; tests verify the solution,
  they do not define it; never speculate about code you have not opened.
- **Subagents:** newer models over-delegate; say when to and when not to.
- **Tools deserve as much prompt engineering as the prompt** (Appendix 2): write descriptions like docstrings for a
  junior developer (example usage, edge cases, input requirements, how the tool differs from similar ones); choose
  argument formats that make mistakes hard (absolute paths fixed a class of errors); test with many inputs.
- **Writing tools:** consolidate steps into one tool where agents need them together; namespace names; return
  human-readable values; offer concise vs. detailed responses; paginate and truncate with defaults and tell the agent
  how to narrow; errors that say what to do and give a valid example; unambiguous parameter names; improve
  descriptions from evaluations and transcripts.
- **Context engineering:** the "right altitude" between brittle if-else rules and vague guidance; the smallest set of
  information that fully defines the behaviour (small is not the same as short); start minimal and add rules for
  observed failures; a minimal tool set (if a human cannot say which tool fits, neither can the agent); canonical
  examples over lists of edge cases; load context just in time; subagents return condensed summaries.
- **Multi-agent research system:** each subagent needs an objective, an output format, guidance on tools and sources,
  and clear boundaries; vague briefs made subagents duplicate searches and leave gaps. Put effort-scaling rules in the
  lead's prompt (one agent and a few calls for simple questions, a handful of subagents for comparisons, more only for
  broad research). Early failures: too many subagents, endless searching, agents distracting each other with
  updates. Subagents write results to files and pass references back. A tool-testing agent that rewrote a flawed tool
  description cut later task time by about 40%. The cookbook lead prompt has sections for the research process,
  subagent count guidelines, delegation instructions (what a brief must include, avoid overlap, never delegate the
  final report), answer formatting and parallel calls; the subagent prompt has an explicit tool-call budget and a
  hard cap.

### 1.4 OpenAI Codex CLI

**Source.** openai/codex, Apache-2.0, main at `2351d9e1b6` (2026-10-09). The old `prompt.md` is now
`codex-rs/protocol/src/prompts/base_instructions/default.md` (about 21 KB); per-model variants in `codex-rs/core/`
(`gpt_5_codex_prompt.md` 6.6 KB, `gpt_5_1_prompt.md`, `gpt_5_2_prompt.md`, `gpt-5.1-codex-max_prompt.md`); the
orchestrator template `core/templates/agents/orchestrator.md`; permission templates
`prompts/templates/permissions/{approval_policy,sandbox_mode}/*.md`; tool specs in `core/src/tools/handlers/`
(`plan_spec.rs`, `apply_patch_spec.rs`, `multi_agents_spec.rs`) and the patch grammar `core/assets/tools/
apply_patch.lark`. AGENTS.md conventions: agents.md.

**Structure of `default.md`.** Identity and capabilities → How you work (Personality) → AGENTS.md spec →
Responsiveness (preamble messages) → Planning (with good and bad example plans) → Task execution → Validating your
work → Ambition vs. precision → Sharing progress updates → Presenting your work and final message (final answer
structure and style) → Tool guidelines (shell, `update_plan`). Sandbox and approval rules are separate developer
messages chosen by mode. **The Codex-tuned model gets a prompt a third the size** (`gpt_5_codex_prompt.md`), in line
with OpenAI's stated "less is more" for models trained on the task *(secondary source: the GPT-5-Codex launch, via
Simon Willison, 2025-09-23; the Codex prompting guide URL returned 404)*.

**Tone.** Second person, friendly and direct; capitals used sparingly, mostly for git safety ("STOP IMMEDIATELY"
when unexpected changes appear).

**Tools.** Tiny descriptions, policy in the system prompt. `apply_patch` is a freeform tool constrained by a Lark
grammar (the format is enforced, not described at length). `update_plan` has a three-sentence description; the
system prompt says when to plan (not for the easiest quarter of tasks), shows good and bad plans, allows one step in
progress, and says not to echo the plan (the UI shows it).

**Safety and approvals.** Per mode: what the sandbox allows, when and how to request escalation (with a one-line
justification), escalate before destructive commands, never ask for broad permanent rules. Never revert changes you
did not make; no `reset --hard`, no amend, no commit or branch unless asked.

**Long horizon.** Keep going until the query is completely resolved; GPT-5.1 adds: persist end to end, do not stop at
analysis. Validation: from the most specific test to the broadest; do not add tests to a repo without them; how
proactive to be depends on the approval mode.

**Delegation.** `spawn_agent` (in `multi_agents_spec.rs`) is off unless the user or AGENTS.md asks for subagents;
requests for "thoroughness" do not count as permission. Plan the critical path first and keep blocking work local;
delegate bounded side tasks with self-contained briefs; give each coding worker a disjoint write set and ask it to
list the paths it changed; wait sparingly. The orchestrator template takes the opposite default (prefer parallel
subagents) for a coordinator-only parent.

**Environment.** A user-role `<environment_context>` XML block (date, timezone, network policy, filesystem
permission profile, cwd, shell), re-sent only when something changes. AGENTS.md text arrives wrapped in
`<INSTRUCTIONS>` with explicit "these replace the earlier ones" messages. No git status or model name is injected.

**AGENTS.md rules.** Each file governs its directory tree; deeper files win; direct prompts win over AGENTS.md.

**Output style.** Short preambles before grouped actions; final answers about ten lines by default; optional bold
headers, flat bullets, backticks for paths and commands, `path:line` references; no "save the file" instructions.

**Leaves out.** Licence headers, inline comments, one-letter names, commits or new formatters unless asked; plans
for simple tasks; ambition in existing codebases ("surgical precision"), saving it for new projects.

### 1.5 Qwen Code

**Source.** QwenLM/qwen-code, Apache-2.0, `packages/core/src/core/prompts.ts` at `8e3f3923b8`, tool descriptions in
`packages/core/src/tools/`.

**Structure.** Identity → `# Core Mandates` → `# Task Management` → `# Primary Workflows` → `# Operational
Guidelines` (communication, tone, security, tool usage) → a sandbox section chosen by sandbox kind → `# Git
Repository` → `# Executing actions with care` (reversibility and blast radius, close to Claude Code's) → `# Examples`
(tool-call syntax per model family) → `# Final Reminder`. Environment (date, platform, directories) arrives in a
system-reminder envelope; git status and memory are appended after.

**Rules worth noting.** "Never assume file contents" (read relevant code before changing it). A denied tool call
must never be routed around through another tool, the shell, a script, an alias or a symlink (Myrmidon's
`system.common` has the same rule). "Report outcomes faithfully"; never claim a check that was not run. The final
reminder: keep going until the query is completely resolved, or report the specific blocker.

**Tools.** The shell description (~600 words) bans `find`/`grep`/`cat` in favour of the dedicated tools and covers
background processes (`is_background`) and stopping them. The agent tool (~1,000 words) has when and when-not,
disjoint write scopes, results are not visible to the user so relay them, and treat a subagent's output as evidence
to verify.

### 1.6 Gemini CLI

**Source.** google-gemini/gemini-cli, Apache-2.0, `packages/core/src/prompts/snippets.ts` at `f5dc904d21`.

**Structure, assembled in code.** Each section is `withSection(key, factory, guard)`: included only when its guard
holds. Order: preamble → `# Core Mandates` (security, context efficiency, engineering standards) → sub-agents →
skills → hook context → Primary Workflows or Plan mode → task management → Operational Guidelines → YOLO mode →
sandbox → git → memory.

**Rules worth noting.** A **directive vs. inquiry gate**: treat a request as a question unless it contains an
explicit instruction to change something (so "why does X happen" gets an explanation, not an edit). "Never call
tools in silence": one sentence of intent before tool calls. "Validation is the only path to finality." After more
than three failed fixes, step back and re-evaluate the approach. Untrusted data is wrapped in tags and described as
passive data. Fewer than three lines of text per response; never commit unless told.

**Environment goes in the first user turn** (`<session_context>`), not the system prompt, so the system prompt stays
cacheable across sessions.

**Subagent.** `codebase_investigator`: read-only tools, turn and time limits, one objective in, structured JSON out
via `complete_task`.

**A cautionary detail:** the assembled prompt both requires a summary after edits and says not to provide
summaries. Even a carefully assembled prompt needs an end-to-end read for contradictions.

### 1.7 Hermes Agent (Nous Research)

**Source.** NousResearch/hermes-agent, MIT, `agent/prompt_builder.py` at `d76cce4f11`, tools in `tools/*.py`.

**Structure: three cache tiers.** *Stable:* identity (`SOUL.md` persona), tool and model guidance, a coding brief.
*Context:* project files (AGENTS.md, CLAUDE.md, `.hermes.md`), a git snapshot, platform hints. *Volatile:* the skills
index, `MEMORY.md`, `USER.md`, timestamp and model, runtime environment (OS, home, cwd, scratch).

**Per-model-family guidance.** Blocks are gated by family. Families that tend to describe instead of act (GPT,
Gemini, Qwen, DeepSeek and others) get a tool-use enforcement block, with the line "Responses that only describe
intentions without acting are not acceptable"; the source notes Claude does not show this failure, so Claude does not
get the block.

**Persona** (~170 words), e.g. match the length of the reply to the weight of the ask.

**Coding brief.** Gather context; change things through tools, not in chat; verify, and know when to stop (after
about three failed lint fixes, stop and ask); never invent files or APIs; no commit or push unless asked. Finishing:
the deliverable is a working artifact backed by real tool output; "Reporting a blocker honestly is always better than
inventing a result."

**Delegation.** `delegate_task` is described as USE FOR / DO NOT USE FOR / RULES; children know nothing of the
conversation, so pass everything needed in `context`; "Child summaries are SELF-REPORTS, not verified facts";
results arrive between turns, so end the turn and never poll.

**Memory as declarative facts.** The memory tool asks for facts, not imperatives, because stored imperatives are
later re-read as directives. Context files are scanned for injection; dangerous commands are matched by regex and
need approval.

### 1.8 OpenHands

**Source.** OpenHands software-agent-sdk, MIT, prompt sections `static.py`, `dynamic.py`, `planning.py` at
`bec71283c1`.

**Structure: XML-tagged blocks.** `<ROLE>`, `<EFFICIENCY>`, `<FILE_SYSTEM_GUIDELINES>`, `<CODE_QUALITY>`,
`<VERSION_CONTROL>`, `<PROBLEM_SOLVING_WORKFLOW>` (explore, analyse, test, implement, verify), `<SECURITY>`,
`<SECURITY_RISK_ASSESSMENT>`, `<PROCESS_MANAGEMENT>`. Then a separate dynamic block: `<REPO_CONTEXT>` wrapping
`<UNTRUSTED_CONTENT>`, memory, skills, the names (not values) of available secrets, `<CURRENT_DATETIME>`.

**Consent taxonomy.** `<SECURITY>` sorts actions into three tiers: fine without consent, only with explicit consent,
never. Every tool call carries a `security_risk` of LOW/MEDIUM/HIGH, with escalation for supply-chain risks.

**Question vs. fix.** "If the user asks a question, like 'why is X happening', don't try to fix the problem."

**Tools.** `task_tracker` with when and when-not and never marking done while tests fail; a `think` tool; a `finish`
tool. Delegation says what to report back, but treats subagent results as authoritative (Hermes and Qwen treat them as
claims).

### 1.9 Cline and Roo Code

**Cline** (Apache-2.0). The new SDK prompt, `sdk/packages/shared/src/prompt/system/act.ts`, is flat and short
(~600 words) with an `<env>` block and parallel tool calls; "Don't ask for permission to do something when you can do
it!"; and a finishing rule on `submit_and_exit`: "Do not submit on the assumption that your solution works — submit
because you have observed evidence that it does." The legacy v3 prompt had twelve per-model variants, a tool spec
format with instructions for each parameter, and a `requires_approval` flag on each command.

**Roo Code** (archived). Orchestrator mode has no working tools of its own. Its `new_task` brief must carry all the
context, a clear scope, an instruction to "only perform the work outlined", and an instruction to finish with a
completion summary that the orchestrator treats as the source of truth; and it states precedence: the specific
instructions "supersede any conflicting general instructions". That precedence line is exactly what Myrmidon's
crewmate briefs lack (§3.2 C5).

### 1.10 Aider

**Source.** Aider-AI/aider, Apache-2.0, `aider/coders/base_prompts.py`, `editblock_prompts.py`,
`architect_prompts.py`.

No tools: the model edits through a SEARCH/REPLACE text format, specified in the system prompt, shown in few-shot
example exchanges, and **repeated at the end as a reminder**. Per-model flags add "lazy" or "overeager" corrections
("Do not improve, comment, fix or modify unrelated parts"). The architect/editor split is a delegation in miniature:
the architect is told "The editor engineer will rely solely on your instructions, so make them unambiguous and
complete."

### 1.11 Multi-agent frameworks: how they brief, hand off and finish

**Claude Code subagents and agent teams** (code.claude.com/docs/en/sub-agents, /agent-teams, /agent-sdk/subagents;
Anthropic docs, paraphrased). The parent picks a subagent from its `description` (writing "use proactively"
encourages it). A subagent starts with its own system prompt, the delegation message, CLAUDE.md and a git snapshot;
**not** the parent's conversation, so any rule it needs must be restated in the brief. Only its final message returns,
and the parent is told the user does not see it *(observed in this session's Agent tool)*. Limits: nesting depth,
concurrency, `maxTurns` with partial results. Messages from another agent count as task direction but never as the
person's approval *(observed)*. Agent teams add a shared task list with dependencies and file locking, per-agent
mailboxes, idle notifications to the lead, and hooks (`TeammateIdle`, `TaskCreated`, `TaskCompleted`) that can block
completion with feedback. Sizing advice: start with three to five teammates and avoid two editing one file.

**OpenAI Agents SDK** (openai/openai-agents-python v0.23.1, MIT; `src/agents/extensions/handoff_prompt.py`,
`handoffs/__init__.py`, `agent.py`). `RECOMMENDED_PROMPT_PREFIX` is one `# System context` paragraph explaining
agents, handoffs and `transfer_to_<agent_name>` functions, and to "not mention or draw attention to these transfers"
to the user. Handoff tools are generated: name `transfer_to_<name>`, description "Handoff to the <name> agent to
handle the request." plus the agent's `handoff_description`, no parameters unless `input_type` is set. The receiving
agent gets the whole history by default (`input_filter` trims it). Agents-as-tools (`as_tool`) is the other pattern:
a string input, the caller continues. No prompt-level loop rules; `max_turns` defaults to 10.

**CrewAI** (crewAIInc/crewAI, MIT, `lib/crewai/src/crewai/translations/en.json` at `d38ceaf`). Role prompt: "You are
{role}. {backstory}\nYour personal goal is: {goal}", a ReAct tools block, the task, and a pressure line ("your job
depends on it"). The manager has two tools, *Delegate work to coworker* and *Ask question to coworker*
(`task`/`question`, `context`, `coworker`), whose description tells it the coworker knows nothing about the task, so
"share absolutely everything you know, don't reference things but instead explain them". A repeated tool input
triggers a stop message. Its planning mode requires a DONE criterion per step and forbids standalone "thinking" or
"review" steps.

**AutoGen Magentic-One** (microsoft/autogen, MIT, `_magentic_one/_prompts.py` at `027ecf0`; AutoGen is now in
maintenance mode). The orchestrator has no system message; its behaviour lives in ledger prompts. The task ledger
first sorts facts into given or verified, to look up, to derive, and educated guesses, then writes a short plan, noting
"there is no requirement to involve all team members". Each step answers five JSON questions: is the request
satisfied, "are we in a loop", is progress being made, who speaks next, and the instruction for them (the brief).
After three stalls it replans, naming the root cause.

**LangGraph and deepagents** (langchain-ai, MIT). `langgraph-supervisor` generates parameterless
`transfer_to_<name>` tools ("Ask agent '<name>' for help") and its README now recommends tool-calling supervisors
instead. **deepagents** (v0.7.23, `deepagents/middleware/subagents.py`, `graph.py`) is the closest analogue to a
coding harness: its `task` tool says each call is stateless and the subagent "sees only the prompt you give it and
returns a single final report", to put full detail in the brief and say exactly what to return, and that the report
is not shown to the user. Subagents are told the caller sees only their final message. A validator rejects briefs put
under invented keys. Since 0.7.0 it ships no authored base prompt, only per-model profiles. LangChain's `write_todos`
description has When to use / How / When NOT to use / states (mark complete immediately; never while partial or
blocked) / and a closing reminder that marking the last todo done is not an answer to the user.

## Part 2. The patterns that matter most

Ranked by how much they would change Myrmidon. Each names the evidence in Part 1.

### 2.1 The prompt is generated from the agent's real situation

omp wraps almost every rule in a condition on the tools present; Gemini CLI assembles guarded sections
(`withSection(key, factory, guard)`); OpenHands keeps a registry of static and dynamic sections; Hermes orders blocks in
three cache tiers and gates guidance by model family; Claude Code assembles small fragments by mode and tool; Codex
picks permission text by sandbox and approval mode and re-sends environment context only when it changes; Cline's v3
prompt had twelve per-model variants. None of them tells an agent about a tool it does not have.
**A sentence about an absent tool is not neutral**: models try to call it, or follow the workflow around it.

### 2.2 Role and job first; one first move; one stopping rule

Every harness opens with identity and purpose. Multi-agent prompts add, near the top, who the agent answers to and how
it finishes: deepagents and Claude Code ("only your final message returns"), omp (`yield`, with an error path), the
Anthropic research subagent (a call budget and a hard stop). Codex and Claude Code state persistence ("keep going until
resolved") once, unambiguously.

### 2.3 Precedence is stated

Codex: deeper AGENTS.md wins, direct prompts win over AGENTS.md. omp's subagent prompt: the assignment wins over the
plan. Claude Code: the user's instructions override defaults; agent messages are direction, never the person's
approval. Without a precedence line, a model reconciles contradictions on its own each turn (OpenAI's GPT-5 guide
notes that contradictions cost reasoning).

### 2.4 Tool descriptions carry the tool's policy: when, when not, limits, examples

The best descriptions (Claude Code TodoWrite, deepagents `task` and `write_todos`, omp `ask`) say when to use the tool,
when not to and what to use instead, what it returns and how it truncates, and give examples for judgement-heavy
tools. Codex goes the other way (tiny descriptions, policy in the system prompt, format enforced by grammar); both
work, but **the policy must live in exactly one of the two places**. Anthropic's tool guidance adds: document every
parameter, make values self-explaining, return actionable errors.

### 2.5 Delegation briefs are complete, and returns are shaped

Converging list (Anthropic research post and cookbook, Claude Code, omp `task`, Codex `spawn_agent`, CrewAI,
deepagents, Hermes `delegate_task`, Roo `new_task`, Aider's architect): the goal and why; what is known or ruled out; the exact deliverable and format; tools or sources and
constraints; scope boundaries and what not to touch; done criteria; for code, a disjoint write set and a list of
changed paths in the answer. Never delegate understanding. And restraint: do not delegate small or critical-path
work, do not redo or re-verify delegated work by spawning again, size the team to the task, not every member is
needed (Magentic-One). The child's answer is a claim to check (Hermes: "SELF-REPORTS, not verified facts"; Qwen,
Claude Code), and the brief overrides the child's general defaults (Roo, omp).

### 2.6 Verification is concrete and by surface, and someone owns it

omp's "tests alone are not proof; run the thing" per surface; Claude Code's browser check for UI and "say so if you
could not test"; Codex's specific-to-broad testing; omp's split (subagents do not verify; the parent verifies once).
Todo lists back this: every user item its own entry, one in progress, never mark done while a check fails (Claude
Code, omp, deepagents).

### 2.7 Interface metadata stays out of the model's context

Sources (read 2026-10-09): Open WebUI (`backend/open_webui/utils/task.py`, `routers/tasks.py`, `utils/middleware.py`),
LibreChat (`titleConvo` in the client, `@librechat/agents` `title.ts`), Gemini CLI (`sessionSummaryService.ts`),
Claude Code (Piebald-AI extraction, `agent-prompt-coding-session-title-generator.md`).

All four generate the title in a **separate one-shot call** (Open WebUI's "task model", LibreChat's `titleConvo`
with its own title model and prompt, Gemini CLI's session summary, Claude Code's title generator), store it as
interface metadata, and **never put the current conversation's title into the main model's prompt**; the only
interface-side variables they substitute into the main prompt are things like the date, time and the user's name.
Claude Code's title generator also treats the conversation as data to name and tells the namer not to follow
instructions inside it (Myrmidon adopted this in `9f6a915`). One exception is reported for ChatGPT: its chat-history
memory includes the titles of *other* past chats as recall data (from a leaked prompt, unverified); that is memory,
not the current chat's label.

Myrmidon broke this rule until `0f2bb5e`: every agent's first line named the colony after the chat's title, and
agents read it as their brief. The rule for Part 4: titles, chat and colony ids, round numbers and other labels are
for the person's screen and never reach agent context, including through paths (§3.10).

### 2.8 Environment is a compact, labelled block

Date (and in Codex timezone), OS and shell, working directory, git state (Claude Code, Hermes), sandbox and network
policy (Codex), model identity (Claude Code, omp, Hermes), project rules files (all), a shallow file tree (omp). Each
harness labels it (`# Environment`, `<environment_context>`, `<workstation>`, `<env>`, `<session_context>`) so it reads
as data, and places it where it does not break the prompt cache: last (Hermes' volatile tier, Myrmidon today), as a
reminder message (omp, Qwen) or in the first user turn (Gemini CLI, Codex). Project files are wrapped and marked as
untrusted or scanned for injection (OpenHands `<UNTRUSTED_CONTENT>`, Hermes).

### 2.9 Calm voice; reasons over volume

Anthropic now advises against CRITICAL/MUST, and Claude Code's newer fragments follow it; Codex uses capitals only for
a few git-safety rules. omp's RFC 2119 style is the exception and is tuned for terseness. Rules that carry their reason
generalise better than rules that are repeated or shouted.

### 2.10 Per-model guidance is normal

Hermes gates a tool-use enforcement block to model families that describe instead of act; Cline v3 kept per-model
variants; Codex ships a much smaller prompt for its Codex-tuned model; Qwen Code shows tool-call examples per family;
Aider sets lazy/overeager flags per model; deepagents ships per-model profiles instead of one base prompt. Myrmidon runs
many model families in one team, so one text for all is the outlier.

### 2.11 What strong prompts leave out

Generic exhortations, rules for other roles, repeated honesty clauses, long method essays (Claude Code and Codex move
those into skills or docs loaded on demand), personality filler, and the interface's own labels.

## Part 3. Myrmidon's prompts, critiqued

Evidence: `packages/runtime/src/prompts.ts` and `patterns.ts` at develop `9f6a915`, assembled for seven roles in
[2026-10-09-myrmidon-prompts-assembled.md](2026-10-09-myrmidon-prompts-assembled.md) (the same calls the runtime makes,
with invented sample values), plus the in-harness report [2026-10-09-agent-feedback.md](2026-10-09-agent-feedback.md)
("feedback §n" below). Section names refer to keys in `prompts.ts` (`system.craft`, `roles.chatLead`, ...).

### What is already good (keep it)

Credit first, because a rewrite should not lose these:

- **Plain, calm voice.** Second person, no ALL-CAPS shouting except a few labels, no "you MUST" stacks. This is what
  Anthropic's Claude 4.x guidance asks for, and probably easier for a mixed team of model families to follow than
  omp's RFC 2119 telegraphese *(inferred; worth an eval)*.
- **The delivery contract** (`system.craft`, "Delivery contract") is the same idea as omp's `<contract>` and Claude
  Code's honesty rules: no fabricated output, report failed checks as failed, no silent scope shrink, no stubs.
- **The lead's task brief template** (`roles.chatLead`: Objective / Deliverable / Approach / Done when / Not in
  scope) is exactly what Anthropic's multi-agent research post found leads must give subagents (objective, output
  format, tool/source guidance, boundaries). It is also repeated in the `create_task` description, where it is used.
- **Untrusted-content spotlighting** with a per-round boundary id (`environment.untrusted`), and a voice prompt that
  treats crew updates as data. OpenHands (`<UNTRUSTED_CONTENT>`) and Gemini CLI tag untrusted content too; the
  per-round boundary id makes Myrmidon's markers hard for a page to forge.
- **Today's date with a "your training data is older" warning** (`environment.today`), in the volatile tail of the
  prompt so the stable head can be cached.
- **Project rules after Qwen Code / Claude Code** (`PROJECT_RULES`): scope, comments, other people's changes, git,
  irreversible actions. Concrete and well chosen.
- **Tool descriptions that say when, not only what**: `web_search` ("Skip it for things you know reliably"),
  `start_server` ("Never use shell for servers"), `grep`/`glob`/`fs_list` pointing at each other, `ask_user` vs
  `check_in`, `request_login` ("Never type passwords"). Better than most open-source harnesses.
- **The judge** (`judge.*`): independent, evidence-only, with per-kind rubrics, observed tool results, and a strict
  JSON reply. Its "an unfetched page is no evidence either way" rule is subtle and right.

The problems below are mostly not about wording quality sentence by sentence. They are about **assembly**: the same
blocks go to every role whether or not they apply, so most agents read rules about tools they do not have, roles
they are not in, and workflows that contradict their own brief.

### 3.1 Assembly: every role gets text written for another role

| # | Problem | Where | Evidence | Fix |
|---|---|---|---|---|
| A1 | **A crewmate called with `ask_crewmate` is told "This round: solo (one agent, all tools)".** | `capabilities()` picks the mode from `spec.tier`, which is still `solo` after the crewmate joins. | Assembled doc, "Crewmate called with ask_crewmate"; feedback §3.1 (both crewmates reported it). | Derive the mode line from the agent's role, not the round's tier: "You are a crewmate answering lead's request." |
| A2 | **The same crewmate is told to claim tasks, pass revisions, submit tasks and create groups**, none of which it has. | `system.common` goes to every agent once `spec.agents.length > 1`; `colony.ts` pushes the crewmate into `spec.agents`. | Its tool list has no `claim_task`, `submit_task`, `create_group`. Feedback §3.1. | Build each block from the tools the agent actually has (`toolsFor`). Split `common` into `log`, `tasks`, `messaging`, `refusals`, and include each only when its tools are present. |
| A3 | **The crewmate's first message is the person's whole request, marked `[user]`**, before its actual job arrives by mail. | `agent.run()` calls `kickoff()` for every agent that `startsAwake`, and `startsAwake` is true for every agent outside a team tier, so the joined crewmate gets `[user] <request>`. Then `askCrewmate` mails the job. | `agent.ts:229-232`, `patterns.ts:488-495`, `colony.ts:1346-1355`. From the code path; not exercised in a live round. | A joined crewmate's kickoff must be its job, nothing else. Pass the job as the kickoff text and drop the request (or label it "context: the lead's overall request; your job is below"). |
| A4 | **The answer tier is told how to build things it cannot build.** The speaker block says to ask scoping questions "before building a site, an app...", "deliverables that are files go into artifacts", and how to build plugins with `create_plugin`; the answer tier has no `publish_artifact`, no file tools and no plugin tools. | `system.speaker` is shared by answer, solo and team lead. | Assembled doc, "Answer tier": tools vs. text. With the sample request ("Build a landing page"), the role says "escalate early" and the speaker block says "ask first with ask_user": two different first moves. | Give the answer tier its own short speaker block: answer, or escalate; never scope a build. Move the plugin paragraph to agents that have `create_plugin`. |
| A5 | **The team lead is told to use `web_search`** ("Use web_search only when...") and to do the speaker's "ask first before building" step, while its own brief says "Your first move: append one note with section plan". | `system.speaker` vs `roles.chatLead`. The lead has no web tools. | Assembled doc, "Team lead". | Speaker text must not name tools the agent lacks. State one first move per role, once. |
| A6 | **Capability lines promise what the agent lacks.** The answer tier reads "drive a real headless browser, including pages you publish" (it cannot publish) and "Tools you make with create_tool exist in this colony" (it has no `create_tool`); the team lead reads the same `create_tool` line; deferred tools are listed as abilities without saying they must be loaded first. | `capabilities.limits` is unconditional; `capabilities.browser` mentions publishing. | Assembled doc; feedback §3.5. | Generate the "you can" line from tools present, mark deferred ones "(load with find_tools)", and drop sentences about absent tools. |
| A7 | **`reply_user` says `final: true` "starts verification automatically" even when review is off**, while the speaker block says "Your final answer is not reviewed". | `tools.reply_user` is static; `review.off` is dynamic. | Assembled doc, "Answer tier". Feedback §3.3 asked for the reviewer setting; it is now in the speaker block but the tool still contradicts it. | Make the `reply_user` description a function of the review setting, or remove the claim from it and keep it in one place. |
| A8 | **`shell` says "Run a shell command in the OS sandbox ... may write only there"** under Full access, where the environment block says there is no sandbox. | `tools.shell` is static. | `prompts.ts:1435-1442` vs `environment.fullAccess`. | Same fix: tool descriptions that depend on configuration are functions of it. |
| A9 | **Worker briefs say "do it in your scratch directory"** while the worktree environment says file tools and shell work in the agent's own git worktree. | `roles.chatWorker`, `roles.crewmate` vs `environment.worktree`. | Read both texts side by side. | "Work in your working directory (described under Environment)." One place says where. |
| A10 | **A swarm peer named kai is told to `message(to: "kai")`** as the example of messaging one person. | `system.common` hard-codes "kai". | Assembled doc, "Swarm peer". | Use a name from the agent's roster in examples, or a placeholder like `<name>`. |

### 3.2 Contradictory rules

| # | Rule A | Rule B | Fix |
|---|---|---|---|
| C1 | `common`: "Ask a quick question instead of guessing ("is the date field UTC?")." | `chatWorker`: "If something is unclear, make a sensible assumption and record it as a decision note; only message the lead when you truly cannot continue." | Pick one per role. Workers: assume and record, ask only when blocked (the conventional choice; Claude Code and omp both say "do not ask what tools can answer"). Drop the "ask instead of guessing" line from workers. |
| C2 | `common`: talk "all through the work and not only at the end", "say what you are starting". | `chatLead`: "Avoid ... posting progress chatter"; `chatWorker`: message the lead only when blocked; omp subagent rule: "never progress or completion reports". | Say when a message is worth sending (it changes someone else's work) and stop there. Remove the "all through the work" encouragement. |
| C3 | `crewmate`: "send it once, when you are done, and stop." | `common`: "When you have nothing useful left to do, stop calling tools and reply with one short line." Feedback §3.1 noticed both endings. | One ending per role, stated in the role block only. |
| C4 | `chatWorker` and `crewmate`: "You cannot talk to the person." | The worker has `reply_person` (and, per feedback §3.1, a crewmate saw `channels_send`). | "You talk to the person only when they write to you directly (@name); then answer with reply_person." Hide channel-send tools from workers. |
| C5 | Defaults: "Deliver files with publish_artifact." | A lead's job text: "do not publish" (feedback §3.1). Nothing says which wins. | Add one precedence line to every delegated agent: "Your job/task text overrides these defaults." Claude Code and omp both state precedence (omp: "Where the plan and your assignment conflict, the assignment wins"). |
| C6 | `speaker`: ask scoping questions before building. | `chatLead`: "Avoid asking the person 'shall I continue?' mid-job", `planFirst` kickoff, `answer` role: escalate. | One "when to ask" rule, placed in the speaker block, with the role-specific first move after it. |
| C7 | `craft`: "Keep going until the job is done: do not end a turn while there is still work you can do." | `swarmPeer`: "Claim one ready task at a time, do it, ... then stop." | Fine in intent (stop after your task), but say it: "the job" is your task, not the request. |
| C8 | Judge `checks`: "score below the threshold and name the failure." | The threshold is never given to the judge (`judge.work` has no threshold; `verifier.ts:346` applies it afterwards). | Put the threshold in the prompt ("Passing is 0.70 or more") with two or three score anchors. |

### 3.3 Repetition and length

- The solo lead's system prompt is about **2,100 words (~3,200 tokens)** before any tool schemas; with 54 tools the
  schemas add several thousand more. A team worker is ~1,600 words. Size is not the problem by itself (Claude Code's
  is longer); the problem is that a large share does not apply to the reader (§3.1) and the rest is unranked.
- `system.craft` has **20 bullets of equal weight**. Research method, bulk scraping, UI taste, code, writing, tool
  preferences and stop rules sit side by side; nothing says which matter most. It is also near-duplicated in
  `read_docs("working")` (feedback §3.2) and partly in `PROJECT_RULES` and `environment.project` ("read before you
  change anything... run its own build or tests") which appears twice in a project prompt.
- "Do not fabricate" appears three times for a working team member (`craft` delivery contract, `common`, and the
  judge rubric for the lead). Final-answer instructions ("what was delivered, where, how to use it, and any caveats")
  appear in both `speaker` and `chatLead`.
- Every skill, with its description, goes to every agent (feedback §3.2: 9 skills, 6 irrelevant to the job).
- The kickoff repeats the request: `[user] <request>` and then `REQUEST: <request>` in the snapshot.
- **Fix:** one canonical place per rule. Generic method moves to a skill-like doc loaded on demand (the docs already
  exist); the system prompt keeps only rules that change behaviour every turn. Skills go as names plus one line, and
  only to agents with `use_skill`.

### 3.4 Ordering and structure

Current order (`systemPrompt()`): identity → capabilities → role → craft → common → speaker → the person's
instructions → plugins → environment (date, project, project rules, untrusted content, permissions, skills,
on-demand tools, memory, layout, checks, project instructions, shell).

- **The role comes third, after a generic capabilities block.** Every strong harness opens with who you are and what
  this session is for. Put the role brief directly after identity.
- **Safety and permissions are buried in the last block**, between the date and the project layout, with no
  heading. Claude Code puts its security and destructive-action rules near the top; Codex puts sandbox and approval
  mode in its own clearly named section. The untrusted-content rule, the permission mode and the irreversible-actions
  rule should be one "Safety and permissions" section near the top (they are stable, so caching is unaffected).
- **`PROJECT_RULES` is stable text glued into the volatile tail.** Only values that change per round belong at the
  end (date, paths, branch, layout, memory, checks).
- **No headings or delimiters.** Sections are separated only by blank lines and pi-ai's block boundaries; the
  environment block is one run of paragraphs. Claude Code, Codex, Qwen Code and omp all use headings (`#`) or XML
  tags (`<env>`, `<project-context>`, `<critical>`) so the model can find and weigh sections. Use short `#` headings
  and wrap injected data (project instructions, memory, layout, skills) in tags.
- **The person's own instructions come late and without precedence.** "Additional instructions for you" sits after
  the harness rules; nothing says whether they override them. Codex and Claude Code state that user/AGENTS.md
  instructions override defaults (except safety). Say so.
- **Hard line breaks at ~115 columns** inside sentences (template literals copied from source formatting). Harmless
  to most models, but it makes the text look like code and costs tokens; prefer one line per bullet.

### 3.5 Tool descriptions

- **65 of 139 parameters have no description** (assembled doc, appendix). Among them the ones that matter most:
  `fs_read.path`, `fs_write.path`/`content`, `fs_edit.old`/`new`/`all`, `shell.command`/`timeoutSeconds` (default and
  maximum unstated), `reply_user.text`/`final`, `create_task.subject`/`description`, `claim_task.id`/`revision`,
  `submit_task.artifacts`, `browser_type.ref`/`text`/`submit`, `update_todo.items` (its item shape is undocumented),
  `create_tool.inputs`/`source`.
- **Enums are not explained**: `remember.kind` (no description at all), `remember.scope` (only "project" explained),
  `propose.kind`, `escalate.to`, `browser_extract.what`, `browser_network.only`. Anthropic's tool guidance: make
  parameter names and values self-explaining, and document each.
- **Output shape and limits are rarely stated.** `fs_read` does not say it truncates or how to read more (it has no
  line ranges, which pushed agents to `sed -n` against the "prefer dedicated tools" rule, feedback §4.7); `shell` does
  not say what happens to long output or how long it waits; `read_log` does not say results are cut to one line
  (feedback §4.3); `find_tools` does not say it returns at most 12 matches (feedback §4.2).
- **Tool results that tell the agent something false.** `create_tool`'s result says "the team can call it now" when
  it must still be loaded with `find_tools` (feedback §4.1). Result strings are prompts too and need the same review.
- **Few examples.** Only `grep`, `browser_extract`, `browser_eval` and `create_tool` give one. Claude Code gives
  `<example>` blocks for its judgement-heavy tools (TodoWrite, Task); Anthropic recommends examples for any tool whose
  correct use is not obvious from the schema. Ours that need them: `create_task` (a full brief), `ask_crewmate` (a
  good job), `message` with `reply_to`, `ask_user` with `questions`, `update_todo`.
- **When-not guidance is uneven.** Good on web and server tools; missing on `ask_crewmate` (when not to delegate:
  small jobs, a slice you already have open, anything faster to do than to explain; omp's "NEVER delegate one slice"),
  `append_note` (when a note is noise), `publish_artifact` (drafts are covered; intermediate data is not),
  `request_review` (mentions skip for simple answers; good), `create_group` (when one message is enough).
- **Names in prose vs schema.** Feedback §3.2 saw `_fs_read`/`_message` in the schemas while the prose says `fs_read`.
  That prefix comes from below the prompt layer (inferred: a provider adapter); if it is real, the prose must use the
  name the model is given, or the adapter must not rename.

### 3.6 Long-horizon work, verification and finishing

- **Todo use is thin.** `update_todo` exists and a reminder fires on stop with open items (good, like omp's stop
  reminder), but the description gives no item shape, no "one item in progress", no "mark done immediately", no
  "list every part of the request separately". omp's `todo` and Claude Code's TodoWrite both spell these out, and both
  insist every user-listed item becomes its own entry.
- **Verification rules are scattered**: `craft` (run what you write, browser test pages), `environment.project` (run
  its build or tests), `environment.checks` (run_checks), `chatWorker` ("check them against Done when"), the speaker's
  review line. None says what counts as proof. omp's rule is the clearest model: "Tests alone are not proof ... run
  the thing, exercise the changed path, observe the result", by surface (web, CLI, investigation).
- **No split between who verifies.** In a team every worker is told to run the project checks in its worktree, and the
  harness verifier runs them again; omp tells subagents not to verify and lets the parent run checks once, because
  parallel runs "storm the CPU and trip on siblings' half-finished edits". Myrmidon's worktrees avoid the second
  problem but not the first. Decide per mode and say it.
- **The finishing rule for the speaker is good** ("what you delivered, where, how to use it, and any caveats"), but
  there are no output-style rules for the final answer: length, markdown use in the chat UI, how to reference files
  (artifact names, `path:line`), no preamble. Claude Code and Codex both have a dedicated output-style section.

### 3.7 Delegation briefs

- **`ask_crewmate` asks for much less than `create_task`.** The job should "stand on its own: what to do, what to hand
  back, and when it is done". It omits why (the goal it serves), what the lead already knows or has read (so the
  crewmate does not redo it), constraints and non-goals, and the answer format. Use the same five-part brief as
  `create_task`, shortened.
- **The crewmate's answer has no shape.** "What you found or made, where the files are, and anything unfinished" is a
  good start; add evidence (what was run or read, and what was only inferred), and a size limit. Anthropic's research
  post: subagents return condensed findings; omp: a structured `yield` with an error path.
- **No guidance on how many crewmates, or when one is enough.** `chatLead` sizes the plan ("a small job is one task");
  the solo lead's crewmate section does not.
- **Crewmate answers come back as trusted text** (feedback §1.3), even when the crewmate just read the web. Wrap them,
  or at least tell the lead that a crewmate's answer is a claim to check (the team lead is told this; the solo lead is
  not).

### 3.8 Environment context

- **Present:** date, weekday, IANA zone; project name and path; worktree path and branch; permission mode; layout; project
  checks; project instructions (AGENTS.md etc.) and nested ones; shell platform and runtimes (only with a shell);
  memory; skills; on-demand tools.
- **Missing or weak:** the time of day (only the date; logs are in UTC and the shell in local time, feedback §3.4); the
  OS for agents without a shell; the model the agent runs on (only crewmates are told); git state for a project
  outside a worktree (branch, clean/dirty, recent commits, which Claude Code and Codex inject); whether the reviewer is
  on, and which model judges (partly fixed); the round's budget (wall time, turns) up front, which the observer only
  reports later.
- **One text for every model family.** A team mixes Claude, GPT, Gemini and local models, and all get the same
  words; there is no per-family guidance, although the failures differ (some families end turns describing a plan
  instead of calling tools, which Hermes counters with a family-gated block, 1.7). See 4.2 and 4.11.
- `Asia/Calcutta` is the deprecated alias of `Asia/Kolkata` (feedback §3.4); print the canonical name and an offset.

### 3.9 The judge and the call assistant

- **Judge:** strong overall. Fix the missing threshold (C8); add score anchors (what 0.3, 0.7 and 1.0 look like) so
  scores are comparable across models; the role line "You judge only the artifacts shown" should also cover the reply
  text it is given. The per-task review (`judge.task`) passes only subject and description: give it the task's
  "Done when" explicitly so it judges against the acceptance checks the lead wrote.
- **Call assistant:** the best-written prompt in the file: one job, concrete speech rules, a clear split between what
  it answers and what it hands off, approvals handled one at a time, crew updates treated as data. Small gaps: no date
  or time; no rule for when the person interrupts while it is speaking or asks for something the crew is already
  doing; tool descriptions are minimal but adequate.

### 3.10 Smaller things

- `roles.lead`, `roles.worker` and `roles.peer` (non-chat YAML colonies) are one-line briefs from an earlier design
  and say almost nothing about how to work; either retire them or build them from the same parts as chat roles.
- **Interface metadata in the prompt.** Until `0f2bb5e` the identity line was `You are agent "lead" in Myrmidon
  colony "<chat title>"` and the call assistant was told `This call is in the chat "<title>"`; the title is written
  from the person's first message, so agents read it as their brief and kept repeating it. Develop now says
  `You are "<name>", an agent in Myrmidon.` and the call prompt has no title. **The title still reaches agents
  through paths:** the colony id is a slug of `spec.name`, which is the title (`packages/core/src/ids.ts:13`,
  `colony.ts:297`), and that id is part of the scratch directory, `$MYR_MIRROR` and the `file:///…/colonies/<slug>/
  browse/…` URLs of `artifact:` pages (feedback §1.2 saw these paths). Fix: an opaque colony id (no slug), and the
  rule in 4.1 (interface metadata never goes into agent context).
- "Like texting at work" / "the way people use WhatsApp at work": a vivid metaphor that invites chatty messages,
  which other rules then forbid (C2). Describe the rule instead.
- Labels in caps (`LEAD`, `CREWMATE`, `REVIEW PASSED`, `THE REVIEWER FOUND PROBLEMS`) are fine for tool results but
  unnecessary in role briefs.

## Part 4. Rewrite plan

This is a plan for an implementer. Its rule is: **every sentence an agent reads must be true for that agent**. Most
fixes follow from building prompts from the agent's real tools and role, not from rewording.

### 4.1 Principles (each traced to Parts 1-2)

1. **Generate from facts, not from tiers.** Every block is a function of `(role, tools, round settings)`. If a
   sentence names a tool, include it only when `toolsFor()` has that tool. Add a unit test that fails when a
   generated prompt mentions a tool name the agent lacks (scan the text for `\b[a-z]+_[a-z_]+\b` that matches a known
   tool name not in the agent's list). This one test would have caught A1-A8.
2. **Role first, then rules, then reference, then volatile facts.** Identity and job in the first lines; safety and
   permissions next; working method; tool-specific guidance lives in tool descriptions; environment last.
3. **One home per rule.** A rule appears once, in the block of the role it applies to, or in the tool it is about.
   Method that is not needed every turn goes to `read_docs` pages or skills.
4. **State precedence.** "The person's instructions and your job text override these defaults, except safety and
   permissions."
5. **Say when, when not, and what done means.** For the role (first move, stopping rule), for each tool, and for each
   delegation.
6. **Explain the reason in a clause** where a rule is not obvious (Anthropic guidance: models generalise from the
   why). Keep the calm voice; no new ALL-CAPS.
7. **Sections with headings; injected data in tags.** `# Heading` per section; `<project_instructions>`, `<memory>`,
   `<skills>`, `<layout>` around data, so the model knows what is instruction and what is reference.
8. **Interface metadata never goes into agent context.** Chat titles, chat and colony ids, round numbers, folder
   and session names, sidebar labels and the like are for the person's screen. They are not in system prompts,
   kickoffs, tool descriptions, tool results or paths the agent sees. Titles are made by a separate call (the
   `chatTitle` prompt, as Open WebUI's task model and LibreChat's `titleConvo` do; see 2.7) and stay in the UI. What
   the agent needs to know about its situation is said in words ("this chat round", "your scratch directory"), never
   by quoting a label. Concretely: replace the title slug in the colony id with an opaque id, and add the title and
   colony id to the "unknown text" test in principle 1 (generate a prompt for a chat whose title is a unique marker
   string and assert the marker appears nowhere in any agent's system prompt, kickoff, tool list or environment
   paths).

9. **Dynamic and evolving.** No fixed prompt string per role: an assembler renders guarded sections from facts
   (4.2), and sections change from measured evidence, never by untested hand edits (4.11).

### 4.2 Architecture: a prompt assembler of guarded sections (dynamic)

The person's direction: the prompt logic should match the best of the other harnesses, "no static, always dynamic
and evolving". Dynamic means **there is no fixed prompt string per role**. Every agent's prompt is computed from facts
about this agent in this round, by an assembler of small guarded sections. Evidence: Gemini CLI's
`withSection(key, factory, guard)` (1.6), OpenHands' static/dynamic section registry (1.8), Hermes' cache tiers and
model-family gates (1.7), omp's `{{#has tools}}` conditions (1.1), Claude Code's per-mode fragments (1.2), Codex's
per-mode permission templates and changed-only environment context (1.4).

#### Modules

```
packages/runtime/src/prompt/
  facts.ts        PromptFacts: everything a section may depend on, computed once per agent per round
  sections.ts     the registry: Section[] in their order, each { key, tier, guard(f), render(f) }
  tools-guide.ts  tool guidance generated from the live tool list (pairs, when-not, deferred tools)
  families.ts     per-model-family guidance blocks and their guards
  learned.ts      learned prompt rules (4.11): load, select by facts, render as declarative lines
  assemble.ts     assemble(facts) -> { system: string[], kickoffPrefix: string, manifest: PromptManifest }
  lint.ts         checks every assembled prompt (unknown tool names, interface metadata, size budgets)
packages/runtime/src/prompts.ts   stays the home of the words (central strings rule); sections call into it
```

`patterns.ts` keeps `toolsFor()` (what an agent may do) and drops `roleBrief`, `capabilities`, `environment` and
`systemPrompt`, which become sections. `agent.ts` calls `assemble(factsFor(host, spec))` where it now calls
`systemPrompt(...)`.

#### `PromptFacts` (the only input; sections never read the spec directly)

```ts
interface PromptFacts {
  agent: { name: string; role: 'speaker' | 'lead' | 'worker' | 'crewmate' | 'peer' | 'answer'; specialty?: string;
           answersTo?: string; personInstructions?: string; jobText?: string }
  mode: { tier: 'answer' | 'solo' | 'team'; team?: 'orchestrated' | 'swarm'; crewmatesOnCall: CrewmateInfo[];
          roster: CrewmateInfo[]; canAddCrewmates: number; escalateTo: ('solo' | 'team')[]; planFirst: boolean }
  tools: { loaded: ToolInfo[]; deferred: ToolInfo[] }   // the live list after toolsFor + disabled + MCP + made tools
  model: { ref: string; family: ModelFamily; vision: boolean; reasoning: boolean }
  access: { sandbox: 'sandbox-exec' | 'bubblewrap' | 'none' | 'unconfined'; project?: { path: string;
            permissions: 'read-only' | 'ask' | 'write'; allow: string[] }; worktree?: { path: string; branch: string } }
  review: { setting: 'off' | 'auto' | 'always'; judge?: string; threshold?: number }
  audience: { owner: boolean; channel?: string; voice: boolean }   // channel member or owner; spoken round
  env: { now: Date; zone: string; os: string; cwd: string; scratch: string; git?: GitSnapshot; runtimes: string[];
         budget: { wallMs: number; maxTurns: number } }
  context: { projectInstructions?: InstructionFiles; nested: string[]; layout?: string; checks: ProjectCheck[];
             memory: string[]; skills: SkillInfo[]; plugins: string[]; learned: LearnedRule[] }
}
```

No field holds a title, chat id, colony id or round number (principle 8). `factsFor()` is the one place that reads
`ColonySpec`, `ColonyHost` and `Environment`; it is unit-tested on its own.

#### `Section`

```ts
interface Section {
  key: string                       // 'you', 'finish', 'safety', 'method', 'project-rules', 'team', 'speaker', ...
  tier: 'stable' | 'context' | 'volatile'
  guard: (f: PromptFacts) => boolean
  render: (f: PromptFacts) => string // returns words from prompts.ts, with facts filled in
}
```

The registry order is the skeleton in 4.3. `assemble()` renders every section whose guard holds, groups them by tier
(stable → context → volatile, as Hermes does), and returns them as separate `systemPrompt` blocks so pi-ai can cache the
stable prefix. Two options for the volatile tier, to measure with the eval (4.11): keep it as the last system block
(today), or move it to the first user turn as Gemini CLI and Codex do, which keeps the whole system prompt identical
across rounds.

Guards are what make the prompt truthful. Examples:

| Section | Guard |
|---|---|
| `team` (messages, groups) | the agent has `message`; the group lines only with `create_group` |
| `tasks` (claim, revision, submit) | the agent has `claim_task` |
| `crewmates` | `mode.crewmatesOnCall.length > 0` and the agent has `ask_crewmate` |
| `speaker` | `agent.role` is `speaker` or `lead` and the agent has `reply_user` |
| `scoping` (ask before building) | speaker with a building tool (`publish_artifact` or `fs_write`) |
| `plugins` | the agent has `create_plugin` |
| `project-rules` | `access.project` with write or ask permission |
| `full-access` | `access.sandbox === 'unconfined'` |
| `channel-member` | `!audience.owner` (a channel member opened the round: approvals go to the owner) |
| `voice` | `audience.voice` |
| `family:<f>` | `model.family` matches (4.2, below) |

#### Tool guidance generated from the live tool list

`tools-guide.ts` produces the "prefer the dedicated tool" lines, the on-demand list and the capability line from
`facts.tools`, never from hard-coded names: each `ToolDef` gets optional metadata, e.g. `{ replaces: ['cat', 'head',
'sed -n'], group: 'files', deferred: true, loadWith: 'files' }`, and the guide renders only pairs whose tool is present.
MCP and made tools join the same list with their own descriptions. Tool descriptions that depend on configuration
(`shell`, `reply_user`, `fs_*`, `publish_artifact`) become `describe(facts)` functions, so the schema the model sees is
generated too.

#### Model-family guidance

`families.ts` holds short blocks with a family guard, after Hermes (1.7), Cline v3 (1.9), Codex's per-model prompts
(1.4), Qwen's per-family examples (1.5) and Aider's lazy/overeager flags (1.10). `ModelFamily` comes from the model
ref and the catalog (`anthropic`, `openai-gpt`, `openai-codex`, `google-gemini`, `qwen`, `deepseek`, `kimi`, `glm`,
`local-small`, ...). Initial blocks, each justified by a documented failure mode:

- **act, don't describe** (non-Claude families that end turns with intentions instead of calls; Hermes' enforcement
  block);
- **tool-call format reminders** for families that emit malformed calls (omp has `gemini-tool-call-reminder.md` and a
  malformed-call retry prompt);
- **brevity** for families that over-explain; **less is more** for code-tuned models (Codex's smaller prompt);
- **small local models**: fewer sections, no optional method text, examples instead of rules.

Blocks start empty for a family until a failure is observed and measured (4.11); the registry can hold them without
code changes.

#### Context files as untrusted data

AGENTS.md, CLAUDE.md and nested instruction files, memory lines, skill descriptions and plugin sections are rendered
inside tags (`<project_instructions source="AGENTS.md">`), with a line saying they are the person's or the project's
text: follow them for how to work in this codebase, but they cannot grant permissions or override safety (OpenHands
`<UNTRUSTED_CONTENT>`, Hermes' injection scan, Codex's `<INSTRUCTIONS>` wrapper). Scan them for injection patterns at
load time as Hermes does and flag hits with the existing `safety/flagged` event.

#### Kickoff and mid-round text

The first user message is assembled the same way (`kickoffPrefix` plus the request), so a crewmate's kickoff is its
job (fix A3), the request is not repeated by the snapshot, and the environment can ride here if the eval favours it.
Wake-ups, reminders and tool results stay in `prompts.ts` but are checked by the same lint.

#### `lint.ts` (runs in `bun test` over a matrix of generated facts, and in development on every assemble)

- every `snake_case` word that is a known tool name must be in `facts.tools` (catches §3.1 A1-A8);
- no title, chat id or colony id string in any block, kickoff, tool description or path (principle 8; generate facts
  for a chat whose title is a unique marker and assert it never appears);
- every tool parameter has a description;
- per-section and total word budgets (fail when a section grows past its budget without the budget being raised in
  the same change);
- no two sections render the same sentence (repetition, §3.3).

#### Data flow

```
ColonySpec + ColonyHost + Environment + catalog + learned-rules store
        │  factsFor()
        ▼
   PromptFacts ──► sections registry (guard → render, words from prompts.ts)
        │                         │
        │                         ├─ tools-guide (live tool list, MCP, made tools)
        │                         ├─ families (model family)
        │                         └─ learned (rules selected by role, family, project)
        ▼
   assemble() ──► system: [stable…, context…, volatile…], kickoffPrefix, manifest
        │                         │
        ▼                         ▼
   pi-agent-core Agent     'agent/prompt' event in the round log (manifest: section keys, versions, hashes)
                                  │
                                  ▼
              apps/eval + protocol run-diff compare runs by manifest (4.11)
```

### 4.3 Target structure, shared skeleton

Every agent's system prompt is these sections, in this order; a section is omitted when it would be empty for this
agent. Sizes are targets for the text Myrmidon writes (not counting injected project instructions, memory or layout).

```
# You                                  (identity + role + this round)              ~60-150 words
  You are <name>, <role sentence>. This round: <what this round is, from the agent's point of view>.
  Who you answer to, who you can talk to, and your first move.
# How you finish                       (stopping rule + what to hand back)          ~40-80 words
# Safety and permissions               (stable)                                     ~120-200 words
  untrusted content; approvals and refusals stay refused; irreversible actions; full access or sandbox;
  read-only / ask mode; credentials.
# How to work                          (role-specific method, ranked)               ~150-300 words
# Working with others                  (only if the agent has message/tasks tools)  ~80-200 words
# Talking to the person                (only for the speaker)                       ~120-200 words
# The person's instructions            (agent.instructions, specialist text; precedence stated)
# Plugins                              (env.plugins)
# Environment                          (volatile; last, for caching)
  <environment> date+time+zone, OS, model, round budget, reviewer setting, working directory, project path,
  branch + clean/dirty, sandbox kind </environment>
  <project_instructions> … </project_instructions>, <memory> … </memory>, <layout> … </layout>,
  checks line, skills (names + one line, only with use_skill), on-demand tools (with "load first").
```

The project rules (`PROJECT_RULES`) move out of the environment block into "How to work" for agents that edit a
project (they are stable). The "Delivery contract" stays as the core of "How you finish" for every agent that works.

### 4.4 Per-role targets

Below: what each role's "You", "How you finish" and "How to work" must say. Text in quotes is direction for the
writer, not final copy.

**Answer tier** (target ~350 words plus environment)
- You: "You answer the person's message yourself in one reply. You have the web, the browser for quick lookups,
  and (in a project) read-only file search. You cannot write files or run commands."
- First move: answer directly; search only when facts may have changed; "if the request needs files, code, a
  build or more than a few lookups, escalate at once instead of asking scoping questions or doing a thin
  version".
- How you finish: one `reply_user(final: true)`; the review setting in one line (off/auto/always).
- Drop: scoping questions, plugin building, artifacts, `remember` "about this project" when there is no project.

**Solo lead** (target ~900-1,100 words plus environment)
- You: "You are the person's lead in this chat. You do the work yourself with every tool, and you can ask your
  crewmates for pieces of it."
- First move, one rule: answer directly if it is a question; ask scoping questions (one `ask_user`) only when the
  result depends on the person's choices; otherwise plan briefly and start.
- How to work: the ranked core of `craft` (see 4.5), the project rules when in a project, verification by surface
  (4.6).
- Crewmates (only with `ask_crewmate`): when to ask (independent piece, a specialty you lack, parallel time), when
  not (small, faster to do than to explain, a slice you already have open, a step on your critical path); the job
  brief template (4.7); "a crewmate's answer is a claim: read its files and check what it says it ran
  (`read_log`)".
- Escalate (only with `escalate`): when, and that it ends the round.
- How you finish: review line, the final-answer shape (4.8).

**Team lead** (target ~700-900 words plus environment)
- You: "You lead a team of <n> crewmates and speak for it. You plan, assign, check and integrate; you have no web,
  shell or file tools, so crewmates do all research and building."
- First move: the plan note and all independent tasks in one step (or one `ask_user` if the result depends on the
  person's choices; never both). Plan sizing table (1 / 2-4 / more), as now.
- The task brief template (keep it; it is the best part of the current prompts) with one worked example in the
  `create_task` description.
- While they work: no polling; message only when the plan changes; answer messages.
- Checking: read files yourself; `reject_task` with the exact gap; a done is a claim (`read_log`).
- How you finish: when all tasks are verified, the final answer (4.8).
- Drop: the craft block (it does no hands-on work), `web_search` mentions, claim/submit rules written for workers
  (keep `HOLD` tools only if the lead really claims tasks; otherwise remove them from `toolsFor`).

**Team worker** (target ~600-800 words plus environment)
- You: "You are <name>, the team's <specialty>, working for lead. You work only on tasks assigned to you; you do
  not plan for the team and you talk to the person only when they write to you directly (reply_person)."
- First move: claim the assigned task with its revision.
- How to work: craft core, project rules, "your working directory is <worktree or scratch>" (from the environment,
  not hard-coded "scratch").
- Ambiguity rule, one version: "make a sensible assumption, record it as a decision note, carry on; message the lead
  only when you cannot continue or your work changes someone else's".
- How you finish: check against the task's Done when, publish the named outputs, `submit_task`, one line, stop. "Your
  task text overrides these defaults."

**Crewmate on call** (asked with `ask_crewmate`; target ~500-700 words plus environment)
- You: "You are <name>, <specialty>. lead asked you for one piece of work; its text is your first message. You
  answer lead, not the person."
- Kickoff = the job text only (fix A3), optionally followed by "Context: the person's overall request was …".
- No tasks, groups or team chat text (fix A2).
- How you finish: one `message(to: lead)` with: what you did, the files (names), evidence (what you ran or read; what
  is inferred), anything unfinished; under ~300 words unless the job asks for more; then stop. "The job text
  overrides these defaults."

**Swarm peer** (target ~800-1,000 words plus environment)
- You: "You are <name>, one of <n> equal crewmates; nobody leads. <strength line>."
- First move: the huddle (one proposal to the team chat, then stop), as now; who merges the plan.
- Working with others: the messaging rules (only those that apply), task claiming, no duplicates.
- How you finish: per task, as for a team worker; only the holder of the final task replies to the person, and its
  speaker rules arrive with that task (add the speaker block to the `finalTask` description, since swarm peers do
  not get `system.speaker`).

**Reviewer (judge)** (target ~350-450 words)
- Keep the current structure. Add: the pass threshold and three score anchors; that the reply text is judged too;
  for per-task review, the task's Done when as the checklist.

**Call assistant** (target ~400 words)
- Keep. Add the date and time; one line for when the person asks about work already running ("say it is in progress
  and offer an update with task_status") and for interruptions.

### 4.5 The working-method core ("How to work")

Replace the 20 flat bullets of `system.craft` with a ranked core of about eight, each with its reason, and move the
rest to `read_docs("working")` or to the tool they are about:

1. Pin down what done looks like before acting (keep the "world class raises the bar" clause).
2. For three or more steps, keep `update_todo`, one item per part of the request (see 4.9).
3. Independent calls in one step; dependent calls in order.
4. Read before you change; follow the project's conventions (project agents only).
5. Prefer the dedicated tools to the shell, and why (the log shows them; they are checked). Move the tool-by-tool
   pairs ("fs_read, not cat") into each tool's description.
6. When a call fails, read the error and change approach; one failure is not a blocker; three failures, switch
   approach.
7. Verify by surface before you deliver (4.6).
8. Re-read the request and check your output against it point by point.

Move to the tools: research method → `web_search`/`web_fetch`; bulk work in code → `shell`/`create_tool`; large pages
saved to scratch → `web_fetch` result text (already there); browser test loop → `browser_open`; UI taste → a skill
or `read_docs("working")`.

### 4.6 Verification, by surface (one block, used by every agent that works)

- Code: run the project's checks (`run_checks`) and exercise the changed path; tests alone are not proof.
- Web page or app: open it (`browser_open("artifact:...")` or the dev server), use the main interactions, read the
  console, look at a screenshot.
- Script or data: run it on real input and look at the output.
- Research: every key claim has a source you opened; numbers checked twice.
- If you could not verify something, say so in your answer; never imply it passed.
- Teams: decide who runs the full checks. Recommended: workers run the checks that cover their change in their
  worktree; the verifier runs the full set once after merge (as now). Say this in the worker and lead blocks.

### 4.7 Delegation brief template (for `create_task.description`, `ask_crewmate.job`, voice `start_task`)

```
Goal: what to achieve and why it matters to the request (1-2 sentences).
Context: what is already known, decided or ruled out; files or notes to read first (names).
Deliverable: exact files (names, format) or the answer's shape; size limit if any.
Approach: constraints, sources or tools to use, the quality bar.
Done when: observable checks.
Not yours: what another task or crewmate covers; what not to change.
```

Rules that go with it (in the lead/solo-lead block and the tool description): never delegate understanding (do not
write "based on what you find, fix it"; give the paths and the hypothesis); one integration owner per shared file;
do not redo delegated work; a crewmate's answer is a claim to check. Give one complete example in the `create_task`
description (about 80 words).

### 4.8 Final answer to the person (speaker only)

- Lead with the outcome in one or two sentences, then what was delivered (artifact names), how to use it, what was
  verified and how, and caveats or what is missing.
- Plain Markdown the chat renders: short paragraphs, a list when there are several items, code only when asked; no
  preamble ("Great question"), no recap of every step.
- Length: as short as the request allows; a direct question gets a direct answer.
- On a voice call: the spoken rules (already in `chat.spoken`).

### 4.9 Tool description template

Every entry in `prompts.tools` follows this shape; target 40-120 words, longer only for judgement-heavy tools
(`create_task`, `ask_crewmate`, `update_todo`, `ask_user`, `create_tool`).

```
<What it does, in one sentence, with the object it acts on.>
<When to use it: the situations, in one or two sentences.>
<When not to: the nearest wrong use, and which tool to use instead.>
<What it returns, and its limits: size caps, truncation and how to get the rest, defaults.>
<One example call, for tools whose correct use is not obvious from the schema.>
```

And for every parameter: a description that says the unit, the default, and the allowed values with what each
means (enums especially: `remember.kind`/`scope`, `propose.kind`, `escalate.to`, `browser_extract.what`,
`browser_network.only`, `read_artifact.version`, `shell.timeoutSeconds`). A unit test can assert that every
parameter in `TOOL_DEFS` has a description.

Descriptions that depend on configuration become functions: `shell` (sandbox vs full access), `reply_user` (review
setting), `fs_*` (project vs scratch), `publish_artifact` (project or not). Tool **results** that instruct the agent
(`prompts.toolResults`, `prompts.colony`) get the same review; start with `create_tool`'s "the team can call it
now" (feedback §4.1).

Example, `fs_read` rewritten (also needs the `offset`/`limit` parameters feedback §4.7 asks for):

```
Read a text file from your working directory or scratch, with line numbers. Use it instead of cat, head or sed in the
shell. For a large file, read the part you need with offset and limit (lines); output past <MAX_READ_CHARS>
characters is cut, and the cut is marked with how to read on. Pages you fetched are saved under web/ in scratch and
can be read the same way.
  path: file path relative to your working directory (or web/… for a saved page)
  offset: first line to read, 1-based (default 1)
  limit: number of lines (default: the whole file, up to the size cap)
```

Example, `update_todo` rewritten:

```
Your checklist for work of three or more steps. Send the whole list each time; each item is one part of the request
or one step, written as an action ("Write the pricing section"). Keep exactly one item in_progress, mark an item done
as soon as it is done (not in a batch at the end), and never mark it done while its check fails. List every part the
person asked for as its own item. Skip it for a single-step answer. Stopping with open items gets you a reminder.
  items: [{ text, status: "pending" | "in_progress" | "done" }]
```

### 4.10 Environment block

```
<environment>
Date: 2026-10-09 (Friday) 14:45, Asia/Kolkata (UTC+05:30). Log times are UTC.
Model: anthropic/claude-sonnet. OS: darwin. Sandbox: sandbox-exec (writes: project, scratch).
Round: solo, 30 min, 40 turns. Reviewer: always (judge: <model>).
Working directory: <worktree path> (branch myr/rune, from main; clean)   or   <project path> (branch main; 2 files changed)
Scratch: <scratch path>
</environment>
```

Keep the training-data warning (one sentence) next to the date. Git state for a project: branch, clean or dirty, and
the last three commit subjects, as Claude Code and Codex inject.

### 4.11 Evolving: how prompts improve without hand edits

"Evolving" means the prompt changes from evidence, under the person's control, and every change can be measured.
Five mechanisms, each with its source evidence and what Myrmidon already has to build on.

**1. Prompt versions recorded in every run.** Each section has a `version` (bumped when its words change) and the
assembler emits a manifest: `{ agent, sections: [{ key, version, hash }], family, learnedRuleIds, totalTokens }`,
appended to the log as an `agent/prompt` event when the agent starts and when the prompt changes mid-round (model
switch, permissions change). *Evidence:* omp's `scripts/measure-prompt-tokens.ts` and Claude Code's per-fragment
version tracking (Piebald's `ccVersion` per piece) show the harnesses version prompt pieces; Anthropic's
multi-agent post evaluates end states across prompt changes. *Builds on:* the append-only log; `run-diff.ts` in
`@myrmidon/protocol`, which already compares two runs ("the same request before and after a prompt change") on
outcome, cost, tools and files and only lacks the prompt manifest to say what changed.

**2. A/B prompt changes in `apps/eval` before they ship.** A prompt change is a variant (a section version or a
learned rule set); `bun run eval` runs the standard cases against both with `--trials` and `--compare before.json
after.json`, and the change ships only if pass rate, judge score and cost do not regress. Add a `--variant` flag
that pins section versions through a settings override, so one server can run both arms. *Evidence:* Anthropic's
tool guidance (improve descriptions from evaluations and transcripts; held-out sets) and the research post's
tool-testing agent that rewrote a description; Gemini CLI's internal contradiction (1.6) as an example of what only
an end-to-end check catches. *Builds on:* `apps/eval` (cases, trials, a judge model, `--compare`, exit 1 on wrong
tier or budget breach) and `report.ts`.

**3. Learned rules from finished runs and the person's feedback.** A reviewer (the same pattern as skill learning)
reads a finished round's log, its verdicts and the person's corrections ("no, don't do X"; a rejected proposal; a
failed review) and proposes **declarative** rules scoped by facts: `{ id, text: "In this project, tests run with
bun test --bail; full runs take 4 minutes.", scope: { project?, role?, family?, tool? }, evidence: [event ids],
status: proposed | kept | discarded }`. Kept rules render in the `learned` section for matching agents only. They are
facts, not imperatives, because stored imperatives get re-read as directives (Hermes' memory tool, 1.7). Rules unused
or contradicted go stale and are archived. *Evidence:* Hermes' memory and skill curator; Qwen Code's skill review;
Anthropic's context-engineering advice to start minimal and add instructions for observed failures. *Builds on:*
`skill-learning.ts` (a separate reviewer after a round, `SkillProposalStore`, learned skills with `source: learned`),
the skills usage curator in `skills.ts` (after Hermes: unused learned skills go stale, then to the archive), and
`memory.ts` with the `remember` tool (the person keeps or discards each memory). Learned prompt rules are a third
store beside memories and skills, with the same keep/discard UI.

**4. Per-model guidance tuned from observed failure modes.** The log already shows the signals: turns that end with
no tool call while todos are open (the todo reminder fires), malformed tool calls, repeated identical calls,
`find_tools` loops, turns that describe a plan without acting, injection flags. A weekly (or on-demand) job counts
these per model family across runs; when a family's rate is high, it proposes enabling or editing that family's block
in `families.ts` (as a variant), and the eval decides (mechanism 2). *Evidence:* Hermes' tool-use enforcement only for
families that need it; omp's dedicated retry prompts (`malformed-function-call-retry.md`, `empty-stop-retry.md`,
`tool-call-loop-redirect.md`, `gemini-tool-call-reminder.md`); Cline's per-model variants; Aider's per-model flags.
*Builds on:* the observer, the stall and todo reminders in `colony.ts`, model metadata in the catalog.

**5. Tool descriptions improved from transcripts.** When a tool's error rate or misuse is high (wrong parameters,
the shell used for what a dedicated tool does, `sed -n` instead of `fs_read`), a reviewer proposes a new description
or a schema change, run through the eval. *Evidence:* Anthropic's writing-tools post (let the model analyse
transcripts and rewrite descriptions) and the research post's 40% gain from a rewritten description; the in-harness
agent report (feedback §4) is a hand-run instance of exactly this. *Builds on:* `read_log` and the tool call/result
events.

**Guardrails for all five.** Nothing learned can add a permission, remove a safety section or change the precedence
line; learned text renders inside a tagged, data-only section; every change is a proposal the person can see and
undo; and every shipped change has an eval result attached.

### 4.12 Order of work for the implementer

1. **The assembler, behaviour-preserving** (4.2): `facts.ts`, `sections.ts`, `assemble.ts`, `lint.ts`; port today's
   blocks into sections with today's words, and the `agent/prompt` manifest event. The lint will fail on today's text
   (that is the point); record the failures as the to-do list for steps 2-3. Record an eval baseline
   (`bun run eval --trials 3 --out baseline.json`).
2. **Guards that make every prompt true** (§3.1 A1-A10): `team`, `tasks`, `speaker`, `scoping`, `plugins`,
   `crewmates` guarded by the live tool list; crewmate kickoff = its job; per-role "You" section;
   configuration-dependent tool descriptions (`describe(facts)`); an opaque colony id so the title stops reaching
   paths (principle 8). Lint passes for unknown tool names and interface metadata.
3. **Resolve the contradictions** C1-C8 with the rules given in 3.2; add the precedence line.
4. **Order, headings, tiers** (4.3): stable → context → volatile; `PROJECT_RULES` into "How to work"; context files
   wrapped as data.
5. **Rewrite `craft`** as the ranked core (4.5) and the verification block (4.6); move the rest to docs and tools.
6. **Tool descriptions** to the template (4.9), generated tool guidance (`tools-guide.ts`), starting with `fs_read`
   (+ ranges), `shell`, `update_todo`, `ask_crewmate`, `create_task`, `reply_user`, and every undocumented parameter.
7. **Delegation**: the shared brief (4.7) in `create_task`, `ask_crewmate` and voice `start_task`; the crewmate's
   answer shape.
8. **Environment** (4.10) and the judge threshold and anchors (C8).
9. **Measure**: eval against the baseline with `--compare`; regenerate
   [2026-10-09-myrmidon-prompts-assembled.md](2026-10-09-myrmidon-prompts-assembled.md) (the script is described
   there), read each role's prompt top to bottom as that agent, and rerun the in-harness probe of the agent-feedback
   report (a solo lead with two crewmates reporting their own briefs).
10. **Evolving** (4.11), in this order: model-family blocks with the first two measured blocks (act-don't-describe,
    tool-call format); the eval `--variant` flag; learned prompt rules (store, reviewer, keep/discard UI); failure-mode
    counting per family; transcript-driven tool description proposals.
