# Writing a Myrmidon plugin

A plugin is a folder in `~/.myrmidon/plugins/<name>/`. Add one in Settings → Plugins from a folder or a git URL;
switch it on and off there.

## Layout

```
my-plugin/
  .claude-plugin/plugin.json   { "name", "version", "description", "author" }
  skills/<skill>/SKILL.md      skills agents load by name (Agent Skills format)
  commands/<name>.md           slash commands: a prompt, with $ARGUMENTS / $1 for what follows the name
  hooks/hooks.json             hooks around tools (Claude Code format)
  .mcp.json                    MCP servers (Claude Code format)
  myrmidon.json                Myrmidon only: { "server": "server/index.ts", "settings": { … } }
  server/index.ts              Myrmidon only: code that adds tools, prompt sections and listeners
  ui/index.tsx                 Myrmidon only: UI for the app's plugin slots
```

Every part is optional. Claude Code plugins work as they are; `${CLAUDE_PLUGIN_ROOT}` in hooks and server configs
is the plugin's folder.

## Code

`server/index.ts` exports `activate(ctx)` (and optionally `deactivate()`). Myrmidon bundles it with Bun, so it can
import npm packages from the plugin's own `node_modules`. Whatever it registers is removed when the plugin is switched
off, and saving a file reloads it.

```ts
export function activate(ctx) {
  ctx.tools.add({
    name: 'word_count',
    description: 'Counts the words in a text',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (args, call) => `${String(args.text).split(/\s+/).filter(Boolean).length} words`,
  })
  ctx.prompts.add('Writing style', 'Keep sentences under 25 words.', 'all')
  ctx.events.on('chat/reply', (event, colonyId) => ctx.log(`reply in ${colonyId}`))
}
```

| `ctx` | What it does |
|---|---|
| `tools.add({ name, description, parameters, run })` | A tool agents can call, named `<plugin>_<name>`. `parameters` is JSON Schema. `run(args, { colonyId, agent, signal })` returns a string or `{ text, isError }`; a throw reaches the agent as an error. Calls go through the person's approvals, permission rules and hooks like any tool. |
| `prompts.add(section, text, scope?)` | A section in agents' system prompts; `scope` is `lead`, `worker` or `all` (default). Applies from the next message. |
| `events.on(type, listener)` | Every event appended to any round's log (`*` for all). |
| `events.emit(colonyId, type, data)` | Adds a `plugin/event` to a round's log. |
| `settings.get()` | The plugin's settings: what the person set, over the defaults in `myrmidon.json`. |
| `log(message)` | A line in the plugin's log, shown in Settings → Plugins. |
| `onDispose(fn)` | Runs when the plugin unloads: stop timers, close connections. |

## UI

`ui/index.tsx` exports `slots`, naming the spots it fills. It runs on the app's own React and UI kit, so it looks
native and follows the theme. Style with the kit's components and the app's colour variables (`var(--fg)`,
`var(--ok)`, …, all in `tokens.css`); Tailwind classes work only where the app itself already uses them, since the
app's stylesheet is built from its own source.

```tsx
import { useState } from 'react'
import { Button, Pill } from '@myrmidon/ui'

function Board(props: { colonyId: string }) {
  const [n, setN] = useState(0)
  return <Button onClick={() => setN(n + 1)}>Clicked {n}</Button>
}

export const slots = {
  'workspace.tab': { title: 'Board', component: Board },
}
```

| Slot | Where | Props |
|---|---|---|
| `chat.card` | Under each `plugin/event` the plugin emitted in a round | `event` (`type`, `data`), `state`, `send(text)` |
| `workspace.tab` | A tab in the workspace panel | `colonyId`, `state` |
| `composer.chip` | The composer toolbar | `insert(text)`, `send(text)` |
| `settings.page` | Under the plugin in Settings → Plugins | `values`, `save(values)` |

`@myrmidon/ui` offers `Button`, `IconButton`, `Pill`, `Switch`, `TextInput`, `TextArea`, `Select`, `Segmented`,
`Skeleton`, `Empty`, `Markdown` and `cn`. A component that throws shows a short note in its own slot; the rest of the
window keeps working. Saved UI files reload in a few seconds.

## Settings

Declare them in `myrmidon.json`; the person edits them in Settings → Plugins.

```json
{
  "settings": {
    "apiKey": { "type": "string", "secret": true, "description": "Your Acme API key" },
    "maxResults": { "type": "number", "default": 10 }
  }
}
```

Types are `string`, `number` and `boolean`. Secret values are never sent back to the page.

## Agents building plugins

Asked for a feature of Myrmidon itself, the lead builds it as a plugin; it never edits Myrmidon, which ships
compiled.

1. `create_plugin(name, description, files)` writes a draft into the plugins folder, switched off. Calling it again
   with the full set of files replaces the draft. Paths must be plugin files (`skills/`, `commands/`,
   `hooks/hooks.json`, `.mcp.json`, `myrmidon.json`, `server/`, `ui/`).
2. `test_plugin(name, tests)` checks that the files read, the code and UI build, and runs `activate(ctx)` with each
   tool on its test input (`[{ tool, args }]`) in the OS sandbox. Plugin code never runs inside Myrmidon before
   approval.
3. `propose_plugin(name, summary)` shows the person what the plugin adds. Only their yes switches it on; from then
   on it is theirs, and no round can rewrite it.


A plugin's hooks, MCP servers and code run as you, with your files and network. Add only plugins you trust.
