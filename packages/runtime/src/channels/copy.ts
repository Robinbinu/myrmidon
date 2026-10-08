/** What channels say to the people writing to them, in one place so it is easy to change. */
export const channelCopy = {
  /** How to get each platform's settings, shown in Settings → Channels. */
  setup: {
    telegram:
      'In Telegram, message @BotFather, send /newbot and follow its steps, then paste the token it gives you. Then message your bot: it replies with a code to approve here. The first person approved is the owner.',
    signal:
      'Signal needs signal-cli running as a daemon with its HTTP API, on a number of its own: register or link it with signal-cli, then run `signal-cli -a +NUMBER daemon --http 127.0.0.1:8080`. Give its address and the number here, then message that number from your phone: it replies with a code to approve here. The first person approved is the owner.',
    imessage:
      'iMessage goes through a BlueBubbles server on a Mac signed in to the Apple ID it should use. Install BlueBubbles there, set a server password, and give its address (e.g. http://192.168.1.20:1234) and the password here. Then send that Apple ID an iMessage: it replies with a code to approve here. In group chats it answers when its name is in the message.',
    matrix:
      'Make a Matrix account for the bot, copy its access token (log in to it in Element, then Settings → Help & About → Advanced → Access Token), and give the homeserver address and the token here. Invite it to a chat: it joins and replies with a code to approve here. Encrypted rooms are not supported yet: DMs started in Element are encrypted by default, so make a room with encryption off and invite the bot to it.',
    discord:
      'In the Discord Developer Portal, create an application, open Bot, turn on Message Content Intent and copy the token (Reset Token). Invite the bot with OAuth2 → URL Generator (scope "bot"; View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files). Then DM the bot: it replies with a code to approve here. The first person approved is the owner.',
    slack:
      'At api.slack.com/apps, create an app from the manifest in docs/channels.md (or turn on Socket Mode, Interactivity, the Messages tab, the bot scopes and events listed there), install it, and paste the Bot token (xoxb-…) and an App-level token with connections:write (xapp-…). Then DM the app: it replies with a code to approve here. The first person approved is the owner.',
  },
  /** The settings each platform asks for, and what they mean, in Settings → Channels. */
  fields: {
    signal: {
      url: { label: 'signal-cli address', hint: 'Where its daemon listens with --http' },
      account: { label: 'Bot phone number', hint: 'The number signal-cli is registered or linked with' },
    },
    imessage: {
      url: { label: 'BlueBubbles server address', hint: 'Its address as this machine reaches it' },
      password: { label: 'Server password' },
      name: {
        label: 'Name in group chats',
        hint: 'Group messages that start with or @mention this name are for it (default: Myrmidon)',
      },
    },
    matrix: {
      homeserver: { label: 'Homeserver address' },
      token: { label: 'Access token' },
      userId: { label: 'Bot user ID', hint: 'Checked against the token when given, e.g. @myrbot:matrix.org' },
    },
    slackBot: 'OAuth & Permissions → Bot User OAuth Token',
    slackApp: 'Basic Information → App-Level Tokens, with the connections:write scope',
  },
  /** Why a platform will not connect, shown as the channel's status (and other messages of its own). */
  signal: {
    refused: (account: string) =>
      `signal-cli has no account ${account}: register or link it with signal-cli first, then give the same number here`,
  },
  imessage: {
    refused: 'BlueBubbles refused this password; copy it again from the server settings in BlueBubbles',
  },
  matrix: {
    refused:
      'Matrix refused this access token; copy it again from the bot account (or log in to make a new one)',
    otherUser: (expected: string, actual: string) => `This token belongs to ${actual}, not ${expected}`,
    encrypted:
      "This room is end-to-end encrypted, and I can't read encrypted Matrix messages yet. Make a room with encryption off and invite me there.",
  },
  discord: {
    refused: 'Discord refused this token; copy it again from the Developer Portal (Bot → Reset Token)',
    intents:
      'Discord refused the Message Content intent: turn it on in the Developer Portal (Bot → Privileged Gateway Intents), then save again',
    gateway: (code: number) => `Discord closed the connection for good (code ${code})`,
  },
  slack: {
    refused: 'Slack refused the bot token; copy the Bot User OAuth Token (xoxb-…) again',
    appRefused: 'Slack refused the app-level token; make one with connections:write (xapp-…)',
    notAppToken: 'The app-level token starts with xapp- (Basic Information → App-Level Tokens)',
    socketOff: 'Socket Mode is off for this Slack app: turn it on under Settings → Socket Mode',
    notInChannel: 'The app is not in that channel: invite it there with /invite @your-app',
    fileHtml: 'Slack sent a page instead of the file: give the app the files:read scope and reinstall it',
  },
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
