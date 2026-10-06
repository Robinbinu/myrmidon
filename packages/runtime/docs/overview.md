# Myrmidon

Myrmidon is a harness that runs colonies of AI agents for a person chatting with it. The person types a
request in plain words; Myrmidon decides how much machinery it needs, runs the agents, checks the result
with an independent judge, and shows everything live in the chat.

## How a request flows

1. **Triage.** Each new request is classified before any agent starts:
   - **answer** — conversation, greetings, explanations, quick facts, questions about Myrmidon itself.
     One agent replies directly (web search allowed, at most a couple of searches). No judge.
   - **solo** — one deliverable that one agent can finish in a few steps (a script, a short document,
     a focused research summary). One agent with every tool; the judge checks the result.
   - **team** — multi-part builds or research where parallel specialists help. The configured team runs
     (see `modes.md`); the judge checks the result.
   - In **swarm** mode there is never a lead: solo work goes to the whole swarm, and a direct answer is
     given by one peer.
   - If the request is too ambiguous to start, Myrmidon asks a question first and waits.
2. **The round.** A round is one colony: agents, a shared board, notes, a task graph, versioned files
   ("artifacts"), and an append-only event log. Nothing is ever edited in place.
3. **Finishing.** The agent that speaks for the colony sends the final answer with `reply_user(final: true)`.
   Verification then runs automatically. A round is *completed* only when the judge accepts it; otherwise the
   findings come back and the colony fixes them.
4. **Follow-ups.** A message sent while a round runs goes straight to the colony. A message after a round ends
   starts a new round that inherits the files, the plan, and the conversation.

## What agents can do

- Search the web and read pages, PDFs, repositories and papers (`web_search`, `web_fetch`).
- Use the tools of the person's MCP servers (named `mcp__<server>_<tool>`, e.g. a GitHub, database, or
  calendar server) when they are connected; each tool's description says what it does.
- Write and run code in a private scratch directory inside an OS sandbox (`shell`, `fs_*`), when enabled.
- Publish files the person can open, preview, and download (`publish_artifact`).
- Coordinate through tasks, notes, the board, and direct mail.

## What agents cannot do

- Change their own tools, models, or permissions, or add plugins to Myrmidon while running. They *can*
  write the code for a plugin, extension, CLI tool, or app as an artifact for the person to use.
- Write outside their scratch directory, or read the person's files unless the person pastes them in.
- Keep running after the round ends; anything to keep must be published as an artifact.

Read `working.md` for how to do excellent work here, `modes.md` for team modes, `coordination.md` for tasks and notes, `verification.md` for the judge,
`chat.md` for talking to the person, `limits.md` for budgets and the sandbox, and `tools.md` for every tool.
