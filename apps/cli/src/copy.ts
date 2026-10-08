/** What the terminal setup commands say, in one place so it is easy to change. */
export const setupCopy = {
  noServer: (home: string) =>
    `no running Myrmidon for ${home}: start it first (\`myrmidon serve\`, or the systemd service in docs/remote.md), then run this again`,

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
    devices: {
      ok: (n: number) => `${n} paired ${n === 1 ? 'device' : 'devices'}`,
      none: 'no paired devices',
      fix: '`myrmidon pair`',
    },
    summary: (problems: number) =>
      problems ? `${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention.` : 'All good.',
  },
}
