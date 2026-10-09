# Permissions — design

The person, 2026-10-09: "we need a global project and session setting for allow tool use, mcp similar to how claude
code and codex does I cannot keep approving tool calls mcp calls ect the ui should be well thought out". Later the same
day: "if lead has all should have this is a permission issue again i dont have a control to give or set permissions".

Settled choices (not re-asked):

1. **Presets + rules.** A Codex-style preset is the main switch — **Read only · Ask · Auto · Full access** — at
   global, project and chat level, the nearer level overriding the one above (chat > project > global). Under the
   presets, Claude Code-style **allow / ask / deny rules** per tool, per MCP server, per MCP tool, and per shell
   command prefix, stored per level. One Permissions screen shows the effective result for the current context.
2. **Approval cards**: "Allow once" is the default button; a small menu remembers the answer for this chat, this
   project or everywhere. Shell offers the command prefix (`bun test`), MCP the tool or its whole server (as Claude
   Code's "Yes, and don't ask again for …"). Deny likewise once / always.
3. **Default = Auto** for a new chat with nothing set: reads, searches, edits inside the project or scratch and
   ordinary commands run without asking; anything destructive, anything outside the workspace and any MCP tool not
   marked read-only asks (Codex Auto / Claude Code accept-edits).
4. **Who may use what** (added mid-build): rules and tool access can name who — everyone, the lead, or the crew — and
   the lead gets every tool group the crew gets by default (a hands-on lead), with switches per level to turn groups
   off for it again.

## Prior art (research)

| | Codex CLI | Claude Code |
|---|---|---|
| Main switch | `/permissions` presets: **Read Only** (read-only sandbox + `on-request`), **Auto** (`workspace-write` + `on-request`), **Full Access** (`danger-full-access` + `never`) | Modes: Manual (`default`), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, auto |
| Approval policy | `untrusted` (ask unless a rule or a known-safe command), `on-request` (model asks to escalate), `on-failure` (deprecated), `never` | Prompt per tool type; read-only Bash commands never prompt |
| Rules | exec-policy `prefix_rule(pattern, decision=allow·prompt·forbidden)`; the strictest matching decision wins | `permissions.allow/ask/deny`, `Bash(npm test *)`, `mcp__server`, `mcp__server__tool`; **deny, then ask, then allow — first match in that order, specificity does not matter** |
| Compound commands | split at `|`, `&&`, `||`, `;`, subshells; each segment evaluated; redirection, substitution, variables and globs are never matched against rules | split at `&&`, `||`, `;`, `|`, `&`, newlines; an allow rule must match every segment, a deny/ask rule any segment; known wrappers (`timeout`, `nice`, `nohup`, `time`) stripped |
| Scopes | `config.toml` profiles; per-project trust | user → project → local settings, managed on top |
| Remembering | approval offers a `prefix_rule` to persist | "Yes, and don't ask again for: `npm test *`"; MCP per tool or server |
| Removing a tool | — | a bare-name deny removes the tool from the model's context; a scoped deny refuses at call time |

Sources: `prompt-library/codex-cli/raw/codex-rs/protocol/src/protocol.rs` (`AskForApproval`, `SandboxPolicy`),
`prompts/templates/permissions/approval_policy/*.md` (segment rules); `prompt-library/claude-code/raw/system-prompts/
skill-update-config-settings-file-locations.md`, `skill-generate-permission-allowlist-from-transcripts.md` (rule
syntax, read-only command set); [Claude Code: Configure permissions](https://code.claude.com/docs/en/permissions);
[Codex: Sandboxing](https://developers.openai.com/codex/concepts/sandboxing); Codex `approval_presets.rs` (mirror,
[forge.lthn.ai](https://forge.lthn.ai/core/core-agent-ide/src/commit/f01f2ec9ee4ca92870afaebfb137bdfd88d89ace/codex-rs/common/src/approval_presets.rs)).

What we take: Codex's three-plus-one presets as the one switch everybody understands; Claude Code's rule precedence
(deny > ask > allow), its rule targets (tool, MCP server, MCP tool, command prefix) and its prompt options; both
tools' segment-wise command matching with no rule ever matching through substitution or redirection; Claude Code's
built-in read-only command set (so Ask does not ask for `ls`).

## Model (`packages/protocol/src/permissions.ts`, pure)

```ts
type PermissionPreset = 'read-only' | 'ask' | 'auto' | 'full'
type RuleDecision = 'allow' | 'ask' | 'deny'
type RuleKind = 'tool' | 'edit' | 'command' | 'mcp-server' | 'mcp-tool'
type RoleScope = 'all' | 'lead' | 'crew'
interface PermissionRule { kind: RuleKind; target: string; decision: RuleDecision; who?: RoleScope }
type AccessGroup = 'files' | 'shell' | 'web' | 'browser' | 'mcp' | 'computer' | 'messaging' | 'plugins'
interface PermissionLevel {
  preset?: PermissionPreset                    // absent: use the level above
  rules: PermissionRule[]
  access?: { lead?: Partial<Record<AccessGroup, boolean>>; crew?: Partial<Record<AccessGroup, boolean>> }
}
interface PermissionLevels { global: PermissionLevel; project?: PermissionLevel; chat?: PermissionLevel }
```

Rule targets: `tool` — a built-in, plugin or made tool by name; `edit` — `*`, every file change (`fs_write`,
`fs_edit`, a proposed file); `command` — a command prefix, or `*` for every command (shell, dev servers, made tools);
`mcp-server` — a server's name, or `*` for every MCP tool; `mcp-tool` — the full `mcp__server_tool` name. `who` is
everyone when absent. *Lead* is the agent that speaks for the chat; *crew* is everyone else (workers, crewmates the
lead asks, swarm peers).

The engine is one function, used by every approval in the colony and, for the explainer, by the UI:

```ts
decide(levels, call, { askAll?, role? }) → { decision: 'allow' | 'ask' | 'deny', source, preset }
call = { tool, kind: 'read'|'colony'|'web'|'edit'|'command'|'mcp'|'proposal'|'other',
         command?, mcp?: { server, readOnly }, outside?, readOnly? }
source = { by: 'read-only', scope } | { by: 'askAll' } | { by: 'rule', scope, rule } | { by: 'preset', scope, preset }
```

### Precedence

1. **Effective preset** = chat ?? project ?? global (global always has one; `auto` when unset). A **read-only project
   is a floor**: a chat in it cannot loosen the preset (the project's own sheet changes it). This keeps the old
   guarantee that a read-only project is untouchable whatever else is set.
2. **Hard limits first.** Under an effective Read only preset every file change inside the project is **denied**, and
   no rule lifts it (the sandbox also keeps the project unwritable). Computer use keeps its own per-app approvals;
   reading outside the sandbox keeps `request_read`; hooks keep `ask`/`block`.
3. **Deny rules, at any level, win.** A chat cannot allow what the project or global level denies (as in Claude Code
   and Codex, where the strictest match wins).
4. **`askAll`** (a channel member started or wrote into the round): every call that is not read-only asks. Only deny
   rules and the Read only floor are stricter; no preset and no allow rule lifts it.
5. **Ask and allow rules: the nearest level with a match decides** (chat, then project, then global); inside one
   level ask beats allow. So "Allow `bun test` in this chat" overrides a global "ask before shell", which is what the
   approval card's menu is for.
6. **The preset decides** when no rule matched:

| call | Read only | Ask | Auto | Full access |
|---|---|---|---|---|
| reads, colony tools (notes, tasks, messages), web | allow | allow | allow | allow |
| file change in the workspace (project, worktree, scratch) | **deny** (project) | ask | allow | allow |
| file change outside the workspace (full access only) | deny | ask | ask | allow |
| command | allow (read-only sandbox) | ask, except known read-only commands | allow, except destructive ones | allow |
| MCP tool marked read-only | allow | allow | allow | allow |
| other MCP tool | ask | ask | ask | allow |
| proposal (`propose`) | ask | ask | ask | ask |
| other tools (plugins' tools, browser) | allow | allow | allow | allow |

Destructive commands (Auto asks): `rm -r`/`-rf`, `git push`, `git reset --hard`, `git clean`, `git checkout --`,
`git restore`, `git branch -D`, `git rebase`, `git stash drop/clear`, `sudo`, `npm/bun/pnpm/yarn publish`, `dd`,
`mkfs`, `shutdown`, `reboot`, `kill -9`, `chmod -R`, `chown -R`, and any `curl … | sh`. Known read-only commands
(Ask runs them): Claude Code's set — `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `which`, `diff`, `stat`,
`du`, `df`, `grep`, `rg`, `tree`, `file`, `find` (without `-exec`/`-delete`), and `git status|log|diff|show|blame|
branch|rev-parse|ls-files`. Both lists live in `permissions.ts`.

### Command matching

A command is split into segments at `&&`, `||`, `;`, `|`, `&` and newlines (outside quotes); leading `VAR=value`
assignments and the wrappers `timeout N`, `time`, `nice`, `nohup`, `env` are stripped. A prefix rule matches a segment
equal to it or starting with it and a space. **Deny and ask** rules apply when **any** segment matches; an **allow**
rule (and Ask's read-only set) only when **every** segment matches and the command has no substitution (`` ` ``,
`$(`) or redirection (`<`, `>`). Destructive detection checks every segment, simple or not.

### Hidden tools

A deny rule that names a whole tool (`tool`, `mcp-tool`) or a whole server (`mcp-server`) removes the matching tools
from the agent it applies to (by `who`), at any level — deny always wins, so the agent could never use them in that
chat and listing them would only cost context and invite refused calls. Command-prefix and `edit` denies leave the
tool and refuse matching calls with `ERROR: <what> is denied by <scope> permissions (<rule>)`, which tells the agent not
to retry it another way.

### Who may use what

`access` per level holds, for the **lead** and the **crew**, which tool groups they get: files, shell (commands, dev
servers, tool making), web, browser, MCP, computer use, messaging, plugins. Each cell takes the nearest level that
sets it, else on. `toolsFor()` stays the one place that computes an agent's tools and applies it:

- **Hands-on lead (new default).** In a team round the lead now also gets the build tools of every group its lead
  column allows (files, shell, browser, MCP, computer), keeping its planning and assigning tools.
- A group switched off for the lead removes it **when the lead has someone to hand the work to** (a team round, or
  crewmates on call). An agent working entirely alone keeps every group the crew column allows, so the switch cannot
  leave a solo chat without hands. Turning files and shell off for the lead restores the old delegate-only lead.
- A group off for the crew removes it from workers, crewmates and peers.
- The old global group switches (Settings → Tools: shell, web, files, messaging, MCP, browser) become the global
  level's access for both columns.

## Full access and the sandbox

Full access is the **Full access preset**: no OS sandbox, file tools reach any path, the web any address. It holds
when the effective preset is Full access and the round is not `askAll` (`fullAccessIn`). The Read only floor makes
it impossible in a read-only project. The global "Turn off sandbox" switch disappears into the global preset.

## Persistence

- **Global**: `settings.json` → `permissions: { preset, rules, access? }` (`preset` always set; default `auto`).
  The folders sandboxed agents may read stay in `sandbox.read` / `sandbox.readHome`.
- **Project**: `projects.json` → `permissions: { preset?, rules, access?, read? }` (absent preset = use global).
- **Chat**: the chat's latest round log, event `chat/permissions` with the chat level after the change (whole set,
  like `chat/allowed`), folded into `ColonyState.chatPermissions`, so it survives restarts and follows the chat
  across rounds.
- A round's spec carries `permissions: PermissionLevels` (re-read every round, and applied at once to running rounds
  when any level changes; see Events).

## Migration (on load; nothing is lost)

| old | new | why |
|---|---|---|
| `settings.permissions` dict `{ tool: allow·ask·off }` | global rules: `mcp` → `mcp-server *`; `mcp__…` → `mcp-tool`; else `tool`; `off` → `deny` | same meaning; `off` removed the tool, a whole-tool deny hides it |
| `settings.sandbox.enabled: false` | global preset **Full access** | the only way to set it was a confirmed switch: a deliberate choice |
| `settings.sandbox.enabled: true` or absent | global preset **Auto** | `true` is the schema default and is written into every saved file, so it never meant a choice |
| `settings.tools[group] = false` | global `access.lead[group]` and `access.crew[group]` = false | the same switch, now per role |
| project `mode: 'auto'` | preset **unset (use global)** | old `auto` meant "what the global sandbox allows": with the sandbox off it already ran with full access, so "use global" keeps both cases exactly |
| project `mode: 'ask'` / `'read-only'` / `'full'` | preset `ask` / `read-only` / `full` | |
| project `allow: ['bun test']` | `command` allow rules | |
| project without `permissions` (before projects asked) | preset unset | it was autonomous, i.e. global |
| chat grants `file` / `command` (event `chat/allowed`) | chat rules `edit *` / `command *` allow | read in the fold until the chat's first `chat/permissions` event, which starts from them |

Note on the brief: it says today's default has full access on. In this codebase `sandbox.enabled` defaults to `true`
(`settings.ts`), i.e. full access **off**, and the person's own `settings.json` has it on. So the migration only gives
Full access to people who confirmed turning the sandbox off.

Behaviour changes, deliberate: workers get their own git worktree only under Auto (as only "Autonomous" projects did);
the setup assistant no longer pre-selects Ask for git folders, it shows "Use global" first; Auto now asks before
destructive commands (today nothing asked outside "Ask first"
projects); Ask runs known read-only commands without asking; an "Ask first" project under a sandbox-off global used to
run unsandboxed — Ask is sandboxed, so it now runs in the sandbox (the stricter direction); new projects start on "Use
global" instead of Ask first; a team lead gets build tools by default.

## Events and API

- `approval/requested` gains `offer` (rule targets the card may remember: the command prefix and `command *`; the MCP
  tool and its server; `edit *`; the tool), `why` (the deciding source, shown on the card) and `call` (to re-decide
  it). `grant` stays readable in old logs.
- `POST /api/colonies/:id/approvals/:approval` takes `remember: { scope: 'chat'|'project'|'global', rule | rules }`:
  the call is decided, then the rules are saved at that level, which re-decides every other waiting call of the round
  (allowed ones approve, denied ones refuse) — "Allow `bun test` everywhere" clears the queue. A compound command
  remembers each part's prefix together (at most five), as Claude Code saves a rule per part.
- `POST /api/chats` takes `permissions` for a new chat: the level chosen in the composer before the first message,
  logged as the chat's first `chat/permissions` event.
- Devices paired for chats only may answer cards and remember an answer for the chat (as they could allow a kind of
  step for the chat before); a chat's preset and rules, a project's and the global ones need a full-access device.
- `chat/permissions` (new) and `PUT/GET /api/chats/:chatId/permissions`; `PUT /api/projects/:id/permissions` takes
  the new project level; the global level saves with `PUT /api/settings`. `GET /api/permissions?chat=&project=`
  returns the three levels, the effective preset with its source, and the catalog (tools, MCP servers and their
  tools with the read-only hint) for the rules editor and the explainer.
- Any level changing calls `ChatService.permissionsChanged()`: each running round takes the new levels at once; if
  they got stricter (a deny, a new ask, a stricter preset, full access taken back), agents mid-turn are interrupted
  and told (`permissions/changed`, as today).
- Channels: "Always" on a channel approval saves the card's first offer globally (it used to allow the bare tool).

## UI

All text in `copy.ts`, tunables in `ui-config.ts`; one icon per feature (`FEATURE_ICONS`).

- **Settings → Permissions** (new section in the "Set up" group, replaces Tools' sandbox banner, group switches and rules
  table): the global preset as a four-way choice with a one-line explanation each (Full access confirms); **Who can
  use what** — a matrix, rows = tool groups, columns = Lead / Crew, each a switch showing the effective value and, when
  it comes from another level, where; **Rules** — grouped by kind (Tools, Files, Commands, MCP servers, MCP tools),
  search, add (kind, target with suggestions from the catalog, who, decision), change decision inline, remove;
  **Readable folders** (moved from Tools); **Check a tool** — the explainer.
- **Project permissions sheet**: the same preset choice with **Use global (Auto)** first, the project's rules and
  access overrides, readable folders.
- **Chat control**: a compact pill in the composer showing the effective preset ("Auto", "Ask", "Read only", "Full
  access") with its icon. It opens a popover: the preset for this chat (with "Use project/global" first), this chat's
  remembered rules with remove, a line naming where the effective preset comes from, and a link to the full screen.
  It replaces the grant chips (readable-folder chips stay).
- **Approval card**: `[Deny ▾] [Allow once ▾]` — the primary is a split button; its menu picks *what* to remember
  (the offers) and *where* (This chat · This project · Everywhere). Deny's menu does the same with deny rules. The card
  says why it asked ("Auto asks before destructive commands", "Rule: ask before mcp__github · global"). Keyboard: the
  menus are `role=menu` popovers with arrow keys; Escape closes; motion follows reduced motion.
- **Explainer** ("Check a tool"): pick a tool (or type a command), see allow/ask/deny for lead and crew, and the level
  and rule or preset that decided it, using the same `decide()`.

## Not in scope

Path-scoped edit rules (`Edit(src/**)`), network domain rules, a model-side "request escalation" tool, managed
(organisation) settings.
