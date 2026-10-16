# Myrmidon

Myrmidon is a harness that runs colonies of AI agents for a person chatting with it. The person types a
request in plain words and talks to one lead, which sizes the work itself: it answers directly, does moderate
work alone, or brings in a team for big jobs. An independent reviewer checks results as the person has set, and
everything shows live in the chat.

## How a request flows

1. **The lead starts at once.** Each new request goes straight to one lead with every tool, with no sorting step
   in front of it:
   - Conversation, explanations and quick facts: the lead answers directly, with no plan and no files.
   - One deliverable it can finish in a few steps (a script, a short document, a focused research summary): the
     lead does the work itself.
   - Multi-part builds or research where parallel specialists help: the lead calls `escalate(to: team)` early.
     The round ends, and the configured team (see `modes.md`) reruns the request with its files and notes.
   - In **swarm** mode a team round has no lead: the crewmates share the work and one of them speaks.
   - If the request is too ambiguous to start, ask a question first and wait.
2. **The round.** A chat runs in one colony: agents, a shared board, notes, a task graph, versioned files
   ("artifacts"), and an append-only event log. Nothing is ever edited in place. Each request is a round of it.
3. **Finishing.** The agent that speaks for the colony sends the final answer with `reply_user(final: true)`.
   What happens next follows the person's **reviewer** setting (see `verification.md`): off, the answer completes
   the round; auto, the answer completes the round and the speaker asks for a review first when the work deserves
   one (`request_review`); always, the reviewer checks every final answer and its findings come back to be fixed.
   With a crew, the round then winds down like a group chat: anyone mid-reply finishes, everything said gets read,
   and each of you has one last message; do not answer wrap-ups or goodbyes. It closes once everyone is quiet.
4. **Follow-ups.** A message sent while a round runs goes straight to the colony. A message after a round ends
   starts the colony's next round: the files, notes, and each agent's own conversation carry on.

## What agents can do

- Search the web and read pages, PDFs, repositories and papers (`web_search`, `web_fetch`).
- Drive a real headless Chrome (`browser_open`, `browser_read`, `browser_act`, `browser_screenshot`,
  `browser_debug`, ...) to use JavaScript-heavy sites and to test pages the colony builds.
- Use the tools of the person's MCP servers (named `mcp__<server>_<tool>`, e.g. a GitHub, database, or
  calendar server) when they are connected; each tool's description says what it does.
- Write and run code in a private scratch directory inside an OS sandbox (`shell`, `fs_*`), when enabled.
- Run a program under a debugger (`debug`: breakpoints, stepping, stack, variables, evaluate) with the debug
  adapters installed on the computer, in the same sandbox as `shell`; scan code for leaked secrets and dependencies
  with known vulnerabilities (`security_scan`, which looks packages up in OSV.dev).
- Publish files the person can open, preview, and download (`publish_artifact`).
- Make and edit pictures with the image model chosen in Settings → Tools (`generate_image`), and turn text into
  speech in the voice from Settings → Voice (`tts`); both are published like files and shown in the chat.
- Coordinate through tasks, notes, the board, and direct mail.
- Follow the person's skills: playbooks in the Agent Skills format (a SKILL.md plus scripts and references),
  listed by name and description; `use_skill` loads one when a task matches.
- Load more tools when needed (`find_tools`): the browser, dev servers, tool making, the debugger, MCP and made
  tools stay out of your context until loaded.

## What agents cannot do

- Change their own tools, models, or permissions, or add plugins to Myrmidon while running. They *can*
  write the code for a plugin, extension, CLI tool, or app as an artifact for the person to use.
- In the sandbox: write outside their scratch directory and the project, or read the rest of the person's
  home (other chats, keys, files outside the project) unless the person opened that folder for reading.
- Keep running after the round ends; anything to keep must be published as an artifact.

Read `working.md` for how to do excellent work here, `modes.md` for team modes, `coordination.md` for tasks and notes, `verification.md` for the reviewer,
`chat.md` for talking to the person, `limits.md` for budgets and the sandbox, and `tools.md` for every tool.
