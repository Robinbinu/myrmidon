/** What channels say to the people writing to them, in one place so it is easy to change. */
export const channelCopy = {
  /** How to get each platform's settings, shown in Settings → Channels. */
  setup: {
    telegram:
      'In Telegram, message @BotFather, send /newbot and follow its steps, then paste the token it gives you. Then message your bot: it replies with a code to approve here. The first person approved is the owner.',
    whatsapp:
      "Links Myrmidon to a WhatsApp account as a linked device, like WhatsApp Web: turn it on, then on the phone open WhatsApp → Settings → Linked devices → Link a device and scan the code. This isn't an official WhatsApp API and WhatsApp can ban numbers it takes for bots: use a spare number, never message people first, and never send bulk messages. Then message that number from your own: it replies with a code to approve here. The first person approved is the owner.",
    'whatsapp-cloud':
      "Meta's official WhatsApp Business Platform, for a business number. At developers.facebook.com make an app with WhatsApp; copy the phone number ID and an access token from WhatsApp → API Setup (a System User token lasts; the test one expires in a day) and the app secret from Settings → Basic, and make up a verify token. It needs this gateway's public HTTPS address: in WhatsApp → Configuration set the callback URL to <public address>/hooks/channels/whatsapp-cloud with the same verify token, and subscribe to messages. Replies are allowed within 24 hours of the person's last message.",
    mattermost:
      "In Mattermost, open Integrations → Bot Accounts → Add Bot Account, then paste your server's address and the bot's token. Message the bot directly: it replies with a code to approve here. In channels, add the bot and mention it. Buttons for approvals need this gateway's public address; without one, reply /approve KEY (type a space before the slash, or Mattermost takes it as its own command).",
    email:
      "Use a mailbox of its own for Myrmidon, with an app password (Gmail, Outlook and iCloud require one). Choose 'listed people only' for direct messages and list your address, so strangers' mail is ignored rather than answered with a code. Mail is only accepted when your mail server verified the sender (DMARC, SPF or DKIM). Each email thread is a conversation of its own.",
    sms: "In the Twilio console, copy the Account SID and Auth Token and buy or pick a number. SMS needs this gateway's public address: Twilio posts each text to it, and the number is pointed there for you. List your phone number (as +15551234567) under 'let in without a code'.",
    ntfy: 'Pick a long random topic name (anyone who knows it can read and write it), subscribe to it in the ntfy app, then write there. The topic is one conversation; the access rules here still apply, so approve the code it replies with. Add an access token for a protected topic or your own server.',
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
  /** Settings the WhatsApp Cloud API needs. */
  fields: {
    whatsappCloud: {
      phoneNumberId: 'Phone number ID',
      phoneNumberIdHint: 'From WhatsApp → API Setup; a long number, not the phone number itself',
      token: 'Access token',
      appSecret: 'App secret',
      appSecretHint: 'From Settings → Basic; checks that webhooks really come from Meta',
      verifyToken: 'Verify token',
      verifyTokenHint: "Any long random text; type the same in Meta's webhook settings",
    },
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
  whatsapp: {
    /** What `check()` says before a phone is linked. */
    account: 'linked device',
    linking: 'On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code',
    linkExpired: 'No phone scanned the code in time; turn WhatsApp off and on here for a new one',
    loggedOut:
      'WhatsApp logged this device out; turn WhatsApp off and on here and scan the new code to link again',
    replaced:
      'Another WhatsApp Web session took over this linked device (only one program may use it); stop it, then turn WhatsApp off and on here',
    closed: (code: number | string) => `WhatsApp closed the connection (${code}); reconnecting`,
    offline: 'not connected to WhatsApp',
    tooSlow: 'WhatsApp took too long to send the message',
  },
  whatsappCloud: {
    needsPublic:
      'The WhatsApp Cloud API delivers messages by webhook, so this gateway needs a public HTTPS address (start it with --public-url; see docs/remote.md)',
    refused:
      'Meta refused this access token; make a new one in WhatsApp → API Setup (a System User token does not expire)',
    noNumber:
      "Meta doesn't know this phone number ID; copy it from WhatsApp → API Setup (it's not the phone number itself)",
    unreachable: 'cannot reach the WhatsApp Cloud API',
    window:
      "WhatsApp only allows replies within 24 hours of the person's last message; they need to write first",
    rejected: (why: string) => `WhatsApp refused it: ${why}`,
    noEdit: "WhatsApp's Cloud API can't edit messages",
    /** The button that opens a list of more than three options. */
    choose: 'Choose',
  },
  /** What platforms report in Settings when they cannot connect. */
  errors: {
    mattermostToken: 'Mattermost refused this token; copy it again from Integrations → Bot Accounts',
    mattermostUnreachable: (why: string) => `cannot reach the Mattermost server: ${why}`,
    emailLogin: 'The mail server refused this username and password (many need an app password)',
    emailSend: (why: string) => `cannot send mail: ${why}`,
    smsToken: 'Twilio refused this Account SID and Auth Token; copy them again from the Twilio console',
    smsNumber: (number: string) => `${number} is not a number on this Twilio account`,
    smsPublic:
      "SMS needs this gateway's public address (start it with --public-url): Twilio delivers texts by posting to it",
    ntfyRefused: 'The ntfy server refused access to this topic; check the access token',
    ntfyTopic: 'A topic is letters, digits, - and _, up to 64 characters',
    ntfyGuessable:
      'Pick a topic of at least 12 characters (anyone who knows it can read it), or protect it with an access token',
  },
  /** Email specifics: the subject of a new thread, and how a new thread's subject reaches the crew. */
  email: {
    subject: 'Myrmidon',
    withSubject: (subject: string, body: string) => (body ? `${subject}\n\n${body}` : subject),
  },
  /** What a message on an ntfy topic is shown as coming from (ntfy has no senders). */
  ntfySender: 'ntfy topic',
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
