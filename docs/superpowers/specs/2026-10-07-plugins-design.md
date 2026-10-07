# Plugins — Design Spec

- **Date:** 2026-10-07
- **Status:** Approved; phases 1-2 built ("Protect + plugins": the person asked for a spec before building; the source guard was
  dropped because Myrmidon will ship compiled)
- **Scope:** how Myrmidon is extended without changing its own code, and how agents add features as plugins

## 1. Problem

Asked for a feature inside Myrmidon ("I want a UI like Claude Code, where I can pick the options"), a crew edited
Myrmidon's own source in place: half-finished changes to `packages/protocol` that broke the typecheck and had to be
rewound. Once Myrmidon ships as a compiled app there is no source to edit at all. Features people want should arrive
the way DeepSeek Harness does it, where "everything is a plugin" and there is no privileged core to patch: as a
plugin that is added, switched on, and removed without touching Myrmidon.

Myrmidon already has extension pieces, each in its own format and folder: made tools (`<home>/tools`), skills in the
Agent Skills format, hooks in Claude Code's format, and MCP servers in omp's `mcp.json`. Nothing bundles them, nothing
can add UI, and agents have no way to package a feature.

## 2. Goal

- A plugin is one folder that can add tools, skills, hooks, MCP servers, prompt sections, settings, slash commands,
  and UI, and can be switched on and off as one unit.
- Plugins written for Claude Code work unchanged where the pieces overlap (skills, hooks, commands, MCP).
- When the person asks for a feature for Myrmidon itself, the lead builds a plugin, tests it, and asks the person to
  switch it on. It never edits Myrmidon.
- Plugins load and reload while Myrmidon runs, including in the compiled app.

## 3. Design

### 3.1 The plugin folder

`<home>/plugins/<name>/`, laid out like a Claude Code plugin, plus two Myrmidon additions:

```
nova-cards/
  .claude-plugin/plugin.json   name, version, description, author (Claude Code's manifest)
  myrmidon.json                Myrmidon additions (optional): entry points, slots, settings, permissions
  skills/<skill>/SKILL.md      Agent Skills, as today
  commands/<name>.md           slash commands (Claude Code format: a prompt with front matter)
  hooks/hooks.json             hooks (Claude Code format, as <home>/hooks.json today)
  .mcp.json                    MCP servers (Claude Code format)
  server/index.ts              Myrmidon only: runtime code (tools, prompt sections, event listeners)
  ui/index.tsx                 Myrmidon only: UI for the slots it names
```

- A folder with only Claude Code parts is a valid plugin. `myrmidon.json` and `server/`/`ui/` are optional.
- Plugins from a project's `.claude/plugins` are not loaded automatically (hooks and code run as the person). The
  person adds them from Settings, as with hooks today.

### 3.2 Runtime code (`server/index.ts`)

The module exports `activate(ctx)`, where `ctx` is a small, versioned API. Everything registered through it is undone
when the plugin is switched off or reloaded (DeepSeek Harness's lifecycle-managed effects):

- `ctx.tools.add({ name, description, parameters, run })`: tools agents can call, named `<plugin>_<tool>` so they never
  shadow Myrmidon's own; same approval tiers and permission rules as built-in tools.
- `ctx.prompts.add(section, text)`: a section appended to agents' system prompts (e.g. house style for a design
  plugin), scoped to `lead`, `worker`, or `all`.
- `ctx.events.on(type, listener)`: read-only subscription to colony events (`tool/result`, `chat/reply`, …).
- `ctx.events.emit(type, payload)`: appends a plugin event, `plugin/<name>/<type>`, that UI slots can render.
- `ctx.settings`: the plugin's settings, from the schema in `myrmidon.json`, edited in Settings → Plugins.
- `ctx.log`: messages shown in the plugin's row in Settings, not the terminal.

The code is bundled with Bun when the plugin loads (Bun's bundler is available in the compiled app) and imported
in-process. It runs with the person's privileges, like a VS Code extension or a Claude Code hook, which is why
switching a plugin on is always the person's decision (3.5).

### 3.3 UI (`ui/index.tsx`)

`myrmidon.json` names the slots the plugin fills; the UI module exports a component per slot. Slots in v1:

| Slot | Where | Gets |
|---|---|---|
| `chat.card` | under an agent message, or in place of a plugin event in the chat | the event or message, a `send(text)` to answer |
| `workspace.tab` | a tab in the workspace panel, beside Files and Terminal | the round's state |
| `composer.chip` | a chip in the composer toolbar | the team config and a setter |
| `settings.page` | a page in Settings → Plugins | the plugin's settings and a setter |

- Myrmidon bundles `ui/index.tsx` with React and Myrmidon's UI kit (buttons, chips, menus, tokens) marked external,
  served at `/plugins/<name>/ui.js`, and loads it with `import()`. Plugins share Myrmidon's React and look native by
  using the same components and `tokens.css` variables.
- A slot that throws renders a small "plugin failed" note instead of taking the window down (an error boundary per
  slot).

### 3.4 Loading and switching

- Settings → Plugins lists every plugin with its parts, version, source, an on/off switch, and its log.
- Plugins load at start and reload when their folder changes (a file watcher, debounced). A failed load leaves the
  plugin off with the error in its row; Myrmidon keeps running.
- Rounds pick up a plugin's tools, prompt sections, skills and hooks from their next round, as made tools and skills
  do today.

### 3.5 Agents build plugins

- Speaker brief: a request for a feature of Myrmidon itself ("add a …", "I want Myrmidon to …") is met with a plugin.
  Myrmidon's own code is not in the project, and the brief says so.
- New tools for the lead:
  - `create_plugin(name, description, parts)`: scaffolds `<home>/plugins/<name>/` (off) with the chosen parts and
    gives the agent write access to that folder only.
  - `test_plugin(name)`: loads it in a sandboxed check, the same way it would load for real, and reports load
    errors, typecheck errors, and each tool's result on its declared test input (as made tools are tested).
  - `propose_plugin(name, summary)`: asks the person to switch it on with an approval card listing what it adds
    (tools, slots, hooks, commands) and what it can reach. Nothing runs until they approve.
- The approval card links to the plugin's files. Turning it off later, or deleting it, is one click in Settings.

## 4. Phases

1. **Plugin folder and Claude Code parts:** load skills, commands, hooks and MCP from plugin folders; Settings →
   Plugins with switches. No custom code yet.
2. **Runtime code:** `server/index.ts` with `ctx.tools`, `ctx.prompts`, `ctx.events`, `ctx.settings`; hot reload.
3. **UI slots:** the four slots, bundling, error boundaries.
4. **Agents build plugins:** `create_plugin`, `test_plugin`, `propose_plugin`, and the speaker brief.

Each phase ships on its own, with the next starting after the person has tried the last.

## 5. Testing

- A plugin made only of Claude Code parts (a skill, a command, a hook) loads, shows in Settings, and its parts reach
  the next round; switching it off removes them.
- A runtime plugin's tool is callable by agents, named `<plugin>_<tool>`, and gone after the plugin is switched off;
  editing its file reloads it.
- A UI plugin renders in each slot; a throwing slot shows its note and the rest of the window keeps working.
- Asked "add a button that …" in a chat, the lead scaffolds a plugin, tests it, and proposes it; Myrmidon's source is
  untouched, and nothing runs before approval.
- The compiled app loads a plugin with server and UI code (Bun's bundler inside the compiled binary).

## 6. Open questions

- Distribution: install from a git URL or a directory listing (Claude Code marketplaces, a DeepSeek-style hub), or
  only local folders for now? The proposal is local folders and git URLs in phase 1, a directory later.
- Permissions: should a plugin declare what it reaches (network, files outside its folder, shell) and be held to it,
  or is the person's approval enough for v1? The proposal is to declare and show in v1, and enforce later.
