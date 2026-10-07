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

## Trust

A plugin's hooks, MCP servers and code run as you, with your files and network. Add only plugins you trust.
