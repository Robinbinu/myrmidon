/** What channels say to the people writing to them, in one place so it is easy to change. */
export const channelCopy = {
  /** How to get each platform's settings, shown in Settings → Channels. */
  setup: {
    telegram:
      'In Telegram, message @BotFather, send /newbot and follow its steps, then paste the token it gives you. Then message your bot: it replies with a code to approve here. The first person approved is the owner.',
    'synology-chat':
      'Needs this gateway to have a public HTTPS address. In Synology Chat → Integration → Bots, create a bot: set its outgoing URL to <public-url>/hooks/channels/synology-chat, then paste its token and its incoming URL here. Then message the bot: it replies with a code to approve here.',
    'nextcloud-talk':
      'Needs this gateway to have a public HTTPS address. On the Nextcloud server run: occ talk:bot:install "Myrmidon" "<secret>" "<public-url>/hooks/channels/nextcloud-talk" --feature webhook --feature response, enable the bot in a conversation, and paste the server address and the same secret here. A Nextcloud user and app password (optional) let it tell one-to-one conversations from group ones.',
    simplex:
      'Run the SimpleX Chat terminal app on this machine as a bot: simplex-chat -p 5225 (create its profile the first time), and make a contact address with /address. Paste the WebSocket address here (ws://127.0.0.1:5225 by default). Contact requests are accepted; strangers then get a code to approve here.',
    tlon: 'Paste your ship’s URL and its access code (in Landscape: System Preferences → Access Key, or +code in the dojo). DM the ship from another one: it replies with a code to approve here. In groups, mention the ship (or its nickname).',
    webhook:
      'For scripts, home automation and anything that can send HTTP. Needs this gateway to have a public HTTPS address: POST JSON to <public-url>/hooks/channels/webhook signed with the shared secret (see docs/channels.md); replies are POSTed to the callback URL, signed the same way.',
  },
  /** A platform that pushes messages to this gateway cannot run without a public address. */
  needsPublicUrl: (label: string) =>
    `${label} sends messages to this gateway, so it needs a public HTTPS address: start it with --public-url (see remote.md)`,
  pairing: {
    code: (code: string, channel: string) =>
      [
        "Hi! This Myrmidon doesn't know you yet, so it won't act on your messages.",
        `If it's yours, approve this code in Settings → Channels, or on its machine run:`,
        `myrmidon channels approve ${channel} ${code}`,
        'The code works for an hour.',
      ].join('\n'),
    group: (code: string, channel: string) =>
      [
        "This group isn't approved yet, so I won't act on messages here.",
        `Approve it in Settings → Channels, or run: myrmidon channels approve ${channel} ${code}`,
      ].join('\n'),
    waiting: 'Your request is still waiting for approval.',
    approved: (owner: boolean) =>
      owner
        ? "You're set up as the owner. Send me what you want done; /help lists the commands."
        : "You've been approved. Send me what you want done; /help lists the commands.",
    groupApproved: 'This group is approved. Mention me (or reply to me) when you want something done.',
  },
  commands: {
    /** What Telegram's command menu shows. */
    menu: [
      { command: 'new', description: 'Start a fresh conversation' },
      { command: 'stop', description: 'Stop the work in progress' },
      { command: 'status', description: 'What is running' },
      { command: 'help', description: 'What I can do' },
    ],
    help: [
      'Send a message and the crew works on it; I keep a status line updated and send the answer when done.',
      'Writing while it works reaches the crew at once.',
      '/new: start a fresh conversation',
      '/stop: stop the work in progress',
      '/status: what is running',
      'This chat is also in the Myrmidon app, where you can follow it in detail.',
    ].join('\n'),
    fresh: 'Fresh start: your next message begins a new conversation.',
    stopped: 'Stopping.',
    nothingRunning: 'Nothing is running.',
    unknown: (name: string) => `I don't know /${name}. /help lists the commands.`,
  },
  status: {
    working: 'Working…',
    starting: 'Starting',
    waitingApproval: 'Waiting for your OK',
    waitingAnswer: 'Waiting for your answer',
    done: (time: string, cost?: string) => `Done · ${time}${cost ? ` · ${cost}` : ''}`,
    stopped: (time: string, reason?: string) => `Stopped after ${time}${reason ? `: ${reason}` : ''}`,
    failed: (reason?: string) => `It failed${reason ? `: ${reason}` : ''}`,
  },
  approval: {
    ask: (agent: string, summary: string) => `🔐 **${agent}** wants to ${summary}`,
    expires: (minutes: number) => `Unanswered after ${minutes} minutes, it is denied.`,
    elsewhere: "Waiting for the owner's OK.",
    onlyOwner: 'Only the owner can approve this.',
    noOwner: 'Approve it in the Myrmidon app: no owner is set up on this channel yet.',
    closed: 'This request is no longer open.',
    gone: 'That round is no longer running.',
    once: 'Allow once',
    always: (tool: string) => `Always allow ${tool}`,
    deny: 'Deny',
    typed: (key: string) => `Reply /approve ${key}, /approve ${key} always, or /deny ${key}.`,
    allowed: (who: string) => `✅ Allowed by ${who}`,
    allowedAlways: (who: string, tool: string) => `✅ Allowed by ${who}; ${tool} is now always allowed`,
    denied: (who: string) => `❌ Denied by ${who}`,
    decidedElsewhere: (approved: boolean, by: string) =>
      approved ? '✅ Allowed in the app' : by === 'timeout' ? '❌ Denied: no answer in time' : '❌ Denied',
    pressAllowed: 'Allowed',
    pressDenied: 'Denied',
  },
  question: {
    skip: 'Skip',
    answered: (label: string) => `→ ${label}`,
    typed: 'Reply with the number of an option, or type your own answer.',
    /** The same shape the app sends (QuestionCard's answerText), so agents read one format. */
    answer: (question: string, said: string) => `${question} → ${said}`,
    skipped: '(skipped: your call)',
    pressNoted: 'Noted',
  },
  voice: {
    heard: (text: string) => `🎙️ “${text}”`,
    cannot:
      "I can't listen to voice notes yet: add an OpenAI or Groq key in Settings → Models (they transcribe audio), or type it.",
    failed: (why: string) => `I couldn't transcribe that: ${why}`,
  },
  fileTooBig: (name: string) => `${name} is too large to bring in; send a smaller file.`,
  recovered: '♻️ Recovered reply: the gateway restarted while sending it, so it may be a duplicate:\n\n',
  notify: {
    noOwner: 'No channel has an owner with a direct chat yet: approve yourself on one first.',
  },
  /** A channel chat's name in the app's sidebar. */
  title: (channel: string, who: string) => `${channel} · ${who}`,
  files: (names: string[]) => `Files: ${names.join(', ')} (open them in the Myrmidon app)`,
  unsupported: "I can't read that kind of message; send text, a photo, a file or a voice note.",
  failed: (why: string) => `I couldn't start that: ${why}`,
  /** What an agent is doing, by tool. */
  doing: {
    shell: (command: string) => `running \`${command}\``,
    read: (path: string) => `reading ${path}`,
    edit: (path: string) => `editing ${path}`,
    search: (query: string) => `searching “${query}”`,
    fetch: 'reading a page',
    browser: 'using the browser',
    publish: (name: string) => `publishing ${name}`,
    helper: 'bringing in a helper',
    tasks: 'planning tasks',
    thinking: 'thinking',
    tool: (name: string) => `using ${name}`,
  },
}
