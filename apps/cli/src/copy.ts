/** What the terminal setup commands say, in one place so it is easy to change. */
export const setupCopy = {
  noServer: (home: string) =>
    `no running Myrmidon for ${home}: start it first (\`myrmidon serve\`, or the systemd service in docs/remote.md), then run this again`,
  serverRunning: (home: string) =>
    `a Myrmidon server is already running for ${home} (its address is in server.json there): use it, stop it first, or start this one with another --home`,

  wizard: {
    title: 'Set up this Myrmidon',
    notInteractive: [
      'setup asks questions, and nothing is typing here. To script it instead:',
      '  myrmidon key <provider> < key.txt     store an API key (read from stdin)',
      '  myrmidon model <provider/model>       set the default model (tested first)',
      '  myrmidon pair                         make a pairing link for a device',
      '  myrmidon doctor                       check everything',
    ],
    checking: 'Checking this machine…',
    noModels: 'No model can answer yet. Sign in with a subscription, or add an API key:',
    haveModels: (n: number) => `${n} models can answer. Add another sign-in or key?`,
    choices: {
      login: 'Sign in with a subscription (Claude, ChatGPT, Gemini, Copilot…)',
      key: 'Add an API key',
      skip: 'Skip',
    },
    pairNow: 'This is a remote gateway with no devices yet. Pair one now?',
    yes: 'Yes',
    no: 'No',
    done: 'Set up. Run `myrmidon doctor` any time to check again.',
  },

  pick: {
    prompt: 'Number',
    invalid: 'Pick one of the numbers shown.',
    filter: 'Type part of a model name (Enter for all)',
    none: (q: string) => `No ready model matches "${q}".`,
    more: (n: number) => `…and ${n} more; type more of the name to narrow it down.`,
  },

  login: {
    pick: 'Which sign-in?',
    ready: 'signed in',
    open: 'Open this on any device with a browser (your laptop or phone is fine):',
    headless: [
      'This machine has no browser here, so the sign-in may end on a page that does not load (127.0.0.1…).',
      'That is expected: copy the whole address from that page and paste it below.',
    ],
    tunnel: (port: string) =>
      `Or forward its callback first, and it finishes by itself: ssh -N -L ${port}:127.0.0.1:${port} <you>@<this server>`,
    waiting: 'Waiting for the sign-in…',
    done: (who?: string) => `Signed in${who ? ` as ${who}` : ''}.`,
    failed: (why: string) => `Sign-in failed: ${why}`,
    unknown: (id: string, ids: string[]) => `no sign-in called ${id}; one of: ${ids.join(', ')}`,
  },

  key: {
    pick: 'Which provider?',
    custom: 'Another provider (type its id)',
    providerId: 'Provider id',
    enter: (provider: string) => `API key for ${provider} (hidden)`,
    empty: 'No key given; nothing changed.',
    saved: (provider: string) => `Saved the ${provider} key in Myrmidon's vault.`,
    testing: (ref: string) => `Testing it with ${ref}…`,
    kept: (provider: string) => `The key is kept; replace it with \`myrmidon key ${provider}\`.`,
    noModel: (provider: string) =>
      `No ${provider} model is listed yet, so the key was not tested; \`myrmidon model\` shows what is ready.`,
  },

  model: {
    current: (ref?: string) => (ref ? `Default model: ${ref}` : 'No default model yet.'),
    none: 'No model can answer yet: run `myrmidon login` or `myrmidon key <provider>` first.',
    testing: (ref: string) => `Testing ${ref}…`,
    works: (ms: number) => `It answers (${(ms / 1000).toFixed(1)}s).`,
    fails: (why: string) => `It did not answer: ${why}`,
    notSaved: 'The default was not changed.',
    saved: (ref: string) => `Default model set to ${ref}; new chats use it for the lead, workers and judge.`,
    unknown: (ref: string) => `${ref} is not a ready model; \`myrmidon model\` lists them`,
  },

  channels: {
    usage:
      'usage: myrmidon channels [<channel> [on|off|set …] | approve <channel> <code> | revoke <channel> <name, @handle or id>]',
    status: {
      off: 'off',
      connecting: 'connecting…',
      on: (account: string) => `connected as ${account}`,
      retrying: (error: string) => `reconnecting: ${error}`,
      error: (error: string) => error,
      linking: 'scan this code with your phone to link it',
    },
    notSet: (id: string) => `not set up: run \`myrmidon channels ${id}\``,
    people: (names: string[]) => `approved: ${names.join(', ')}`,
    nobody: 'no one approved yet: message the bot, then approve the code it sends',
    waiting: (who: string, expires: string) => `waiting: ${who} (expires ${expires})`,
    field: (label: string, secret: boolean, optional: boolean) =>
      `${label}${secret ? ' (hidden)' : ''}${optional ? ' (optional, Enter to skip)' : ''}`,
    setUsage:
      'usage: myrmidon channels <channel> set dm pairing|allowlist|open|disabled | groups approve|open|disabled | mention on|off | per-person on|off | stream progress|partial|final | allow @a,@b | project <id>',
    setDone: (name: string, value: string) => `Set ${name} to ${value || '(none)'}.`,
    connected: (label: string, account: string) =>
      `${label} is connected as ${account}. Message it, then approve the code it replies with:`,
    approveHint: (id: string) => `  myrmidon channels approve ${id} <code>`,
    turned: (label: string, on: boolean) => `${label} is ${on ? 'on' : 'off'}.`,
    approved: (name: string, owner: boolean) => `Approved ${name}${owner ? ' as the owner' : ''}.`,
    revoked: (name: string) => `Revoked ${name}.`,
    noMatch: (who: string) => `no approved person or group matches ${who}`,
    unknown: (id: string, ids: string[]) => `no channel called ${id}; one of: ${ids.join(', ')}`,
  },

  doctor: {
    title: 'Myrmidon doctor',
    server: {
      ok: (url: string, remote: boolean) => `running at ${url}${remote ? ' (remote gateway)' : ''}`,
      none: 'Myrmidon is not running, so sign-ins and models were not checked',
      fix: 'start it with `myrmidon serve`',
    },
    models: {
      ok: (n: number) => `${n} models can answer`,
      none: 'no model can answer',
      fix: '`myrmidon login` or `myrmidon key <provider>`',
    },
    default: {
      ok: (ref: string, ms: number) => `${ref} answers (${(ms / 1000).toFixed(1)}s)`,
      unset: 'no default model',
      fails: (ref: string, why: string) => `${ref} does not answer: ${why}`,
      fix: '`myrmidon model`',
    },
    access: {
      on: 'agents run sandboxed (Settings → Permissions)',
      projects: (names: readonly string[]) =>
        `agents run sandboxed, except with full access in ${names.join(', ')}`,
      off: "the sandbox is off: your chats have full access (channel members' and read-only projects' stay sandboxed)",
    },
    sandbox: {
      ok: (kind: string) => `shell commands are confined (${kind})`,
      none: 'shell commands run unconfined',
      broken: (kind: string, why: string) => `${kind} is installed but cannot run: ${why}`,
      fixLinux:
        '`sudo apt install bubblewrap`; on Ubuntu 24.04+ allow its user namespaces (docs/remote.md, "Setting up a Linux server")',
      fixOther: 'run Myrmidon on macOS or Linux',
    },
    browser: {
      ok: (path: string) => `browser tools use ${path}`,
      none: 'no Chrome or Chromium for the browser tools',
      fix: '`sudo apt install chromium`, or set MYR_CHROME',
    },
    previews: {
      ok: (origin: string) => `previews open at ${origin}`,
      none: 'devices cannot open previews of agent-built pages',
      fix: 'restart with --preview-port and --preview-url (docs/remote.md)',
    },
    channel: {
      ok: (label: string, account: string, people: number) =>
        `${label} connected as ${account}, ${people} approved ${people === 1 ? 'person' : 'people'}`,
      down: (label: string, why: string) => `${label}: ${why}`,
      nobody: (label: string) => `${label} is connected, but no one is approved yet`,
      fix: (id: string) => `Settings → Channels, or \`myrmidon channels ${id}\``,
      approveFix: (id: string) => `message the bot, then \`myrmidon channels approve ${id} <code>\``,
    },
    devices: {
      ok: (n: number) => `${n} paired ${n === 1 ? 'device' : 'devices'}`,
      none: 'no paired devices',
      fix: '`myrmidon pair`',
    },
    summary: (problems: number) =>
      problems ? `${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention.` : 'All good.',
  },

  installs: {
    pluginsUsage:
      'usage: myrmidon plugins [add <folder|git URL|npm:pkg|plugin@marketplace> | update <name> | remove <name> | marketplaces [add <owner/repo|git URL> | refresh <name> | remove <name>]]',
    skillsUsage:
      'usage: myrmidon skills [search [query] [--source omp,openai,anthropic,skills.sh,clawhub] | add <source:id|@scope/name|git URL> [--force] | update <name> | remove <name> | scan [name|folder]]',
    notInteractive:
      'installing asks you to confirm what it shows, and nothing is typing here: run it in a terminal, or use Settings',
    noPlugins: 'no plugins yet: `myrmidon plugins add <source>`',
    noMarketplaces: 'no marketplaces yet: `myrmidon plugins marketplaces add <owner/repo>`',
    noSkills: 'nothing installed from a registry or repository yet: `myrmidon skills add <@scope/name>`',
    noHits: 'nothing in the registry matches',
    noMarketHits: 'no skill source has a match',
    sourceFailed: (source: string, error: string) => `${source} did not answer: ${error}`,
    flagged: 'flagged suspicious',
    audit: (by: string) => `${by} audit:`,
    fetching: (what: string) => `Fetching ${what}…`,
    review: 'About to install:',
    reviewUpdate: 'About to update:',
    from: 'from',
    version: 'version',
    pinned: 'pinned',
    replaces: 'replaces',
    runs: 'runs as you:',
    code: (entry: string) => `server code ${entry}`,
    ui: 'screens in the app',
    hooks: (n: number) => `${n} hook${n === 1 ? '' : 's'}`,
    servers: (names: string[]) => `MCP servers ${names.join(', ')}`,
    nothingRuns: 'nothing runs: only skills and commands',
    scripts: (files: string[]) => `scripts an agent can run: ${files.join(', ')}`,
    dependencies: (names: string[]) => `npm packages it needs (scripts off): ${names.join(', ')}`,
    confirm: 'Install it? Type yes to install',
    cancelled: 'Not installed.',
    installed: (what: string) => `Installed ${what}`,
    removed: (name: string) => `Removed ${name}`,
    added: (name: string, n: number) => `Added marketplace ${name} (${n} plugins)`,
    refreshed: (name: string) => `Refreshed ${name}`,
    scan: 'skill scan:',
    verdict: { clean: 'clean', warn: 'worth a look', block: 'blocked: something critical' },
    held: 'held: agents are not offered it until you allow it in Settings → Skills',
    notScanned: 'not scanned (the server is older than the skill scanner)',
    noSuchSkill: (name: string) => `no skill called ${name}, and no folder there`,
    scanSkipped: (n: number) => `${n} file${n === 1 ? '' : 's'} not read: binary, media or too large`,
    advisory: 'A scan can miss things; the sandbox and your approvals still apply.',
    blocked:
      'Not installed: the skill scan blocks it. If you trust where it comes from, run it again with --force.',
    confirmAnyway: 'Install it anyway? Type yes to install',
  },
}
