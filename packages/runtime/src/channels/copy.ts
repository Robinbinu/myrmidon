/** What channels say to the people writing to them, in one place so it is easy to change. */
export const channelCopy = {
  /** How to get each platform's settings, shown in Settings → Channels. */
  setup: {
    telegram:
      'In Telegram, message @BotFather, send /newbot and follow its steps, then paste the token it gives you. Then message your bot: it replies with a code to approve here. The first person approved is the owner.',
    whatsapp:
      "Links Myrmidon to a WhatsApp account as a linked device, like WhatsApp Web: turn it on, then on the phone open WhatsApp → Settings → Linked devices → Link a device and scan the code. This isn't an official WhatsApp API and WhatsApp can ban numbers it takes for bots: use a spare number, never message people first, and never send bulk messages. Then message that number from your own: it replies with a code to approve here. The first person approved is the owner.",
    'whatsapp-cloud':
      "Meta's official WhatsApp Business Platform, for a business number. At developers.facebook.com make an app with WhatsApp; copy the phone number ID and an access token from WhatsApp → API Setup (a System User token lasts; the test one expires in a day) and the app secret from Settings → Basic, and make up a verify token. It needs this Myrmidon's public HTTPS address: in WhatsApp → Configuration set the callback URL to <public address>/hooks/channels/whatsapp-cloud with the same verify token, and subscribe to messages. Replies are allowed within 24 hours of the person's last message.",
    mattermost:
      "In Mattermost, open Integrations → Bot Accounts → Add Bot Account, then paste your server's address and the bot's token. Message the bot directly: it replies with a code to approve here. In channels, add the bot and mention it. Buttons for approvals need this Myrmidon's public address; without one, reply /approve KEY (type a space before the slash, or Mattermost takes it as its own command).",
    email:
      "Use a mailbox of its own for Myrmidon, with an app password (Gmail, Outlook and iCloud require one). Choose 'listed people only' for direct messages and list your address, so strangers' mail is ignored rather than answered with a code; after your first mail, make yourself the owner under People. Mail is only accepted when your mail server verified the sender (DMARC, SPF or DKIM). Each email thread is a chat of its own.",
    sms: "In the Twilio console, copy the Account SID and Auth Token and buy or pick a number. SMS needs this Myrmidon's public address: Twilio posts each text to it, and the number is pointed there for you. List your phone number (as +15551234567) under 'let in without a code', and after your first text make yourself the owner under People.",
    ntfy: 'Pick a long random topic name (anyone who knows it can read and write it), subscribe to it in the ntfy app, then write there. The topic is one chat; the access rules here still apply, so approve the code it replies with. Add an access token for a protected topic or your own server.',
    signal:
      'Signal needs signal-cli running as a daemon with its HTTP API, on a number of its own: register or link it with signal-cli, then run `signal-cli -a +NUMBER daemon --http 127.0.0.1:8080`. Give its address and the number here, then message that number from your phone: it replies with a code to approve here. The first person approved is the owner.',
    imessage:
      'iMessage goes through a BlueBubbles server on a Mac signed in to the Apple ID it should use. Install BlueBubbles there, set a server password, and give its address (e.g. http://192.168.1.20:1234) and the password here. Then send that Apple ID an iMessage: it replies with a code to approve here. In group chats it answers when its name is in the message.',
    matrix:
      'Make a Matrix account for the bot, copy its access token (log in to it in Element, then Settings → Help & About → Advanced → Access Token), and give the homeserver address and the token here. Invite it to a chat: it joins and replies with a code to approve here. Encrypted rooms are not supported yet: DMs started in Element are encrypted by default, so make a room with encryption off and invite the bot to it.',
    discord:
      'In the Discord Developer Portal, create an application, open Bot, turn on Message Content Intent and copy the token (Reset Token). Invite the bot with OAuth2 → URL Generator (scope "bot"; View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files). Then DM the bot: it replies with a code to approve here. The first person approved is the owner.',
    slack:
      'At api.slack.com/apps, create an app from the manifest in docs/channels.md (or turn on Socket Mode, Interactivity, the Messages tab, the bot scopes and events listed there), install it, and paste the Bot token (xoxb-…) and an App-level token with connections:write (xapp-…), or, for HTTP mode on a public HTTPS address, the Signing Secret instead of the app-level token. Then DM the app: it replies with a code to approve here. The first person approved is the owner.',
    'synology-chat':
      'Needs this Myrmidon to have a public HTTPS address. In Synology Chat → Integration → Bots, create a bot: set its outgoing URL to <public-url>/hooks/channels/synology-chat, then paste its token and its incoming URL here. Then message the bot: it replies with a code to approve here.',
    'nextcloud-talk':
      'Needs this Myrmidon to have a public HTTPS address. On the Nextcloud server run: occ talk:bot:install "Myrmidon" "<secret>" "<public-url>/hooks/channels/nextcloud-talk" --feature webhook --feature response, enable the bot in a conversation, and paste the server address and the same secret here. A Nextcloud user and app password (optional) let it tell one-to-one conversations from group ones.',
    simplex:
      'Run the SimpleX Chat terminal app as a bot on the computer Myrmidon runs on: simplex-chat -p 5225 (create its profile the first time), and make a contact address with /address. Paste the WebSocket address here (ws://127.0.0.1:5225 by default). Contact requests are accepted; strangers then get a code to approve here.',
    tlon: 'Paste your ship’s URL and its access code (in Landscape: System Preferences → Access Key, or +code in the dojo). DM the ship from another one: it replies with a code to approve here. In groups, mention the ship (or its nickname).',
    webhook:
      'For scripts, home automation and anything that can send HTTP. Needs this Myrmidon to have a public HTTPS address: POST JSON to <public-url>/hooks/channels/webhook signed with the shared secret (see docs/channels.md); replies are POSTed to the callback URL, signed the same way.',
    msteams:
      "Create an Azure Bot (portal.azure.com), set its messaging endpoint to this Myrmidon's /hooks/channels/msteams address, turn on its Microsoft Teams channel, and paste its app ID and a client secret. Then install the bot in Teams and message it: it replies with a code to approve here. Needs a public HTTPS address (myrmidon serve --public-url).",
    googlechat:
      "In Google Cloud, make a service account and a JSON key, enable the Google Chat API and configure the app with this Myrmidon's /hooks/channels/googlechat address as its HTTP endpoint. Paste the key and the project number. Then message the app: it replies with a code to approve here. Needs a public HTTPS address (myrmidon serve --public-url).",
    line: 'In the LINE Developers console, make a Messaging API channel, issue a channel access token, and paste it with the channel secret; Myrmidon sets the webhook address itself (turn on Use webhook). Then add the bot as a friend and message it: it replies with a code to approve here. Needs a public HTTPS address (myrmidon serve --public-url).',
    feishu:
      'On open.feishu.cn (open.larksuite.com for Lark), create a custom app, add the Bot capability, grant im:message, im:message:send_as_bot and im:resource, and under Events & Callbacks choose the long connection and add "Receive messages" (im.message.receive_v1) and the card action callback. Publish the app, then paste its App ID and App Secret here and message the bot: it replies with a code to approve here.',
    dingtalk:
      'In the DingTalk developer console, create an internal app, add a Robot with Stream mode as its message receiving mode, and publish it. Paste its Client ID (AppKey) and Client Secret here, then message the robot: it replies with a code to approve here.',
    wecom:
      "Needs Myrmidon to have a public HTTPS address. In the WeCom admin console, create a self-built app; under Receive Messages set the URL to <public-url>/hooks/channels/wecom with a Token and an EncodingAESKey, and add the IP address of the computer Myrmidon runs on to the app's trusted IPs. Paste the corp ID, the app's AgentId and Secret, the Token and the EncodingAESKey here.",
    weixin:
      "Turn WeChat on, then scan the code that appears with WeChat on your phone and confirm. It links a bot identity to your account through Tencent's iLink bot API (as Hermes Agent does) and answers direct messages to it.",
    qq: "On q.qq.com, create a bot, turn on direct messages and group @-messages, add the IP address of the computer Myrmidon runs on to its IP allowlist, and paste its App ID and AppSecret here. Buttons need QQ's Markdown permission: without it, set Markdown to off.",
    irc: 'Pick a server, a nick for the bot and the channels to join. With a password it signs in by SASL (the nick must be the account name), else sends it as the server password. Message the bot directly: it replies with a code to approve here. In channels it answers lines that start with its nick ("mybot: …"). People are known by nick!user@host, so register nicks with NickServ.',
    twitch:
      'Make a Twitch account for the bot, then a token with the chat:read and chat:edit scopes for it (Twitch Developer Console, or a token generator) and paste it with the bot\'s username. Chat is public and bots cannot whisper, so put your own Twitch username under "Let in without a code" and set Groups to "any group": it answers only listed people who @mention it. After your first message, make yourself the owner under People.',
    x: 'Needs a paid X API plan: the free one cannot read mentions. In the X developer portal, give the app "Read and write" permission (add "Direct Messages" to answer DMs too), then generate the API key and secret and the access token and secret for the bot account. Replies are public: it answers only mentions from the accounts under "Answers publicly". Put those under "Let in without a code" too and set Groups to "any group", since each X thread is a group; after your first mention, make yourself the owner under People.',
    nostr:
      "Paste the bot's private key (nsec1… or hex; make a fresh one for the bot, not your own) and, if you like, its relays. Message its npub from any Nostr client with NIP-04 DMs (Damus, Amethyst…): it replies with a code to approve here.",
    zalo: 'At bot.zaloplatforms.com sign in, create a bot and paste its token (12345689:abc…). Message the bot in Zalo: it replies with a code to approve here. In groups it answers when @mentioned. This is the official bot API, not the personal-account route (which can get an account banned).',
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
      url: { label: 'BlueBubbles server address', hint: 'Its address as Myrmidon’s computer reaches it' },
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
    slackApp: 'Basic Information → App-Level Tokens, with the connections:write scope (for Socket Mode)',
    slackSigning:
      'Basic Information → Signing Secret: for HTTP mode instead of Socket Mode, which needs a public HTTPS address',
    discordPublicKey:
      'General Information → Public Key: only when presses go to an Interactions Endpoint URL (HTTP) instead of the gateway',
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
      'The WhatsApp Cloud API delivers messages by webhook, so this Myrmidon needs a public HTTPS address (start it with --public-url; see docs/remote.md)',
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
      "SMS needs this Myrmidon's public address (start it with --public-url): Twilio delivers texts by posting to it",
    /** Phone calls on the SMS number (Settings → Voice). */
    phoneOff: 'Phone calls are off: turn them on in Settings → Voice',
    phoneSms: 'Phone calls use the SMS channel’s Twilio number: set up SMS in Settings → Channels first',
    phonePublic:
      "Phone calls need this Myrmidon's public https address (start it with --public-url https://…): Twilio streams the call's audio to it",
    phoneApp: (number: string) =>
      `${number} answers calls with a TwiML app or a SIP trunk, which Twilio uses instead of a webhook: remove it from the number in the Twilio console`,
    phoneNotAllowed: (number: string) =>
      `${number} is not someone SMS lets in: approve them, or list them under 'let in without a code'`,
    phoneNoOwner: 'No one to call: make yourself the owner under SMS → People',
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
    badPublicKey: 'The public key is 64 hexadecimal characters (General Information → Public Key)',
  },
  slack: {
    refused: 'Slack refused the bot token; copy the Bot User OAuth Token (xoxb-…) again',
    appRefused: 'Slack refused the app-level token; make one with connections:write (xapp-…)',
    notAppToken: 'The app-level token starts with xapp- (Basic Information → App-Level Tokens)',
    socketOff: 'Socket Mode is off for this Slack app: turn it on under Settings → Socket Mode',
    noMode: 'Give an app-level token (xapp-…) for Socket Mode, or the signing secret for HTTP mode',
    notInChannel: 'The app is not in that channel: invite it there with /invite @your-app',
    fileHtml: 'Slack sent a page instead of the file: give the app the files:read scope and reinstall it',
  },
  pairing: {
    code: (code: string, channel: string) =>
      [
        "Hi! This Myrmidon doesn't know you yet, so it won't act on your messages.",
        `If it's yours, approve this code in Settings → Channels, or run this on the computer it runs on:`,
        `myrmidon channels approve ${channel} ${code}`,
        'The code works for an hour.',
      ].join('\n'),
    group: (code: string, channel: string) =>
      [
        "This group isn't approved yet, so I won't act on messages here.",
        `Approve it in Settings → Channels, or run: myrmidon channels approve ${channel} ${code}`,
      ].join('\n'),
    waiting: 'Your request is still waiting for approval.',
    approved: (owner: boolean, p: string) =>
      owner
        ? `You're set up as the owner. Send me what you want done; ${p}help lists the commands.`
        : `You've been approved. Send me what you want done; ${p}help lists the commands.`,
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
    /** `p` is how commands are typed on this platform: `/`, or `!` where the app keeps `/` for itself. */
    help: (p: string) =>
      [
        'Send a message and the crew works on it; I keep a status line updated and send the answer when done.',
        'Writing while it works reaches the crew at once.',
        `${p}new: start a fresh conversation`,
        `${p}stop: stop the work in progress`,
        `${p}status: what is running`,
        'This chat is also in the Myrmidon app, where you can follow it in detail.',
      ].join('\n'),
    fresh: 'Fresh start: your next message begins a new conversation.',
    stopped: 'Stopping.',
    nothingRunning: 'Nothing is running.',
    unknown: (name: string, p: string) => `I don't know ${p}${name}. ${p}help lists the commands.`,
  },
  status: {
    working: 'Working…',
    starting: 'Starting',
    waitingApproval: 'Waiting for your approval',
    waitingAnswer: 'Waiting for your answer',
    done: (time: string, cost?: string) => `Done · ${time}${cost ? ` · ${cost}` : ''}`,
    stopped: (time: string, reason?: string) => `Stopped after ${time}${reason ? `: ${reason}` : ''}`,
    failed: (reason?: string) => `It failed${reason ? `: ${reason}` : ''}`,
  },
  approval: {
    ask: (agent: string, summary: string) => `🔐 **${agent}** wants to ${summary}`,
    /** On a request to read a folder of keys or sign-ins (~/.ssh, ~/.aws…), as the app's card warns. */
    sensitive:
      '⚠️ This folder holds keys or sign-ins. Agents can read anything in it, and what they read can end up in a reply or leave over the network. Allow it only if the task needs it.',
    member: (name: string) =>
      `${name} (a member, not the owner) asked for this run, so every step that changes something or reads your project asks you, even tools you always allow.`,
    expires: (minutes: number) => `Unanswered after ${minutes} minutes, it is denied.`,
    elsewhere: "Waiting for the owner's approval.",
    onlyOwner: 'Only the owner can approve this.',
    noOwner: 'Approve it in the Myrmidon app: no owner is set up on this channel yet.',
    closed: 'This request is no longer open.',
    gone: 'That run has already ended.',
    once: 'Allow once',
    always: (what: string) => `Always allow ${what}`,
    /** Under an "always" that would remember a test runner, build tool or script, which agents can rewrite. */
    projectCode:
      '"Always" here also lets agents run anything they write into the project\'s scripts, tests or build files, in every chat.',
    /** What an "always" saves, by its rules: a command's prefixes, an MCP tool or server, file changes, a tool. */
    what: (rules: readonly { kind: string; target: string }[]) =>
      rules
        .map((r) =>
          r.kind === 'command'
            ? r.target === '*'
              ? 'every command'
              : `\`${r.target}\``
            : r.kind === 'edit'
              ? 'file changes'
              : r.kind === 'mcp-server'
                ? r.target === '*'
                  ? 'every MCP tool'
                  : `every ${r.target} tool`
                : r.kind === 'ssh-host'
                  ? r.target === '*'
                    ? 'every remote host'
                    : `everything on ${r.target}`
                  : r.target,
        )
        .join(' and '),
    deny: 'Deny',
    typed: (key: string, p: string) =>
      `Reply ${p}approve ${key}, ${p}approve ${key} always, or ${p}deny ${key}.`,
    typedOnce: (key: string, p: string) => `Reply ${p}approve ${key} or ${p}deny ${key}.`,
    allowed: (who: string) => `✅ Allowed by ${who}`,
    allowedAlways: (who: string, what: string) => `✅ Allowed by ${who}; ${what} is now always allowed`,
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
    notYours: 'This question is for whoever asked for the work (or the owner) to answer.',
  },
  voice: {
    heard: (text: string) => `🎙️ “${text}”`,
    cannot:
      "I can't listen to voice notes yet: add an OpenAI or Groq key in Settings → Models (they transcribe audio), or type it.",
    failed: "I couldn't transcribe that; type it instead. The owner can see why in Myrmidon.",
  },
  slowDown: "That's a lot of messages at once, so I'm skipping some. Wait a minute, then send what you need.",
  fileTooBig: (name: string) => `${name} is too large to bring in; send a smaller file.`,
  recovered: '♻️ Recovered reply: Myrmidon restarted while sending it, so it may be a duplicate:\n\n',
  notify: {
    noOwner: 'No channel has an owner with a direct chat yet: approve yourself on one first.',
  },
  /** A channel's activity, as its Activity tab and the System page list it. Names only, never message text. */
  activity: {
    connected: (account: string) => `Connected as ${account}`,
    in: (name: string, group?: string) =>
      group ? `Message from ${name} in ${group}` : `Message from ${name}`,
    call: (name: string) => `Phone call with ${name}`,
    out: 'Answer delivered',
    failed: (why: string, retrying: boolean) => `Couldn't send: ${why}${retrying ? ' (will retry)' : ''}`,
    pairing: (name: string) => `Sent ${name} a code to approve`,
    approved: (name: string) => `Approved ${name}`,
    approval: (agent: string) => `Asked the owner to approve a step by ${agent}`,
    refused: (why: string) => `Couldn't act on a message: ${why}`,
  },
  /** A channel chat's name in the app's sidebar. */
  title: (channel: string, who: string) => `${channel} · ${who}`,
  files: (names: string[]) => `Files: ${names.join(', ')} (open them in the Myrmidon app)`,
  /** A file sent as a link to download, where the platform cannot take the file itself. */
  fileLink: (name: string, url: string, days: number) =>
    `📎 [${name.replace(/[[\]]/g, '')}](${url}) (the link works for ${days} days)`,
  noFileLink: "files go as links from this Myrmidon's public HTTPS address, and it has none",
  unsupported: "I can't read that kind of message; send text, a photo, a file or a voice note.",
  /** What a sticker says to the crew (a still one also comes as its image). */
  sticker: (emoji?: string) => (emoji ? `(sent a ${emoji} sticker)` : '(sent a sticker)'),
  failed: "I couldn't do that. The owner can see why in Myrmidon.",
  /** Why channels are off when their settings file is damaged; nothing is saved over it until it is repaired. */
  unreadable: (why: string) =>
    `Can't read channels.json (${why}): channels stay off and nothing is saved until it is repaired, or replaced by channels.json.bak (or the older .bak.2 or .bak.3) from the same folder.`,
  notObject: 'it does not hold a list of channels',
  missing: (labels: string[]) => `Still needed: ${labels.join(', ')}`,
  /** What "Let in without a code" takes on each platform, shown as its placeholder and when an entry is wrong. */
  allowExample: {
    telegram: '@alice, 123456789',
    'whatsapp-cloud': '+15551234567',
    email: 'you@example.com',
    sms: '+15551234567',
    signal: '+15551234567',
    matrix: '@alice:matrix.org',
    discord: '@alice, 123456789012345678',
    irc: 'alice!~alice@host.example',
    twitch: 'yourname',
    x: '@yourname',
    nostr: 'npub1…',
  },
  allowInvalid: (label: string, entries: string[], example?: string) =>
    `Not a ${label} ID or username: ${entries.join(', ')}.${example ? ` For example: ${example}` : ''}`,
  /** What an agent is doing, by tool. */
  doing: {
    shell: (command: string) => `running \`${command}\``,
    read: (path: string) => `reading ${path}`,
    edit: (path: string) => `editing ${path}`,
    search: (query: string) => `searching “${query}”`,
    find: (query: string) => `looking for “${query}” in the code`,
    github: (op: string) => `on GitHub (${op})`,
    fetch: 'reading a page',
    browser: 'using the browser',
    publish: (name: string) => `publishing ${name}`,
    picture: (prompt: string) => `drawing “${prompt}”`,
    speech: 'recording audio',
    crewmate: 'bringing in a crewmate',
    askCrewmate: (name: string) => `asking ${name}`,
    tasks: 'planning tasks',
    thinking: 'thinking',
    tool: (name: string) => `using ${name}`,
  },
  /** A platform that pushes messages to this Myrmidon cannot run without a public address. */
  needsPublicUrl: (label: string) =>
    `${label} sends messages to this Myrmidon, so it needs a public HTTPS address: start it with --public-url (see docs/remote.md)`,
  /** Hints under some platforms' settings. */
  hints: {
    msteamsTenant:
      'Only for a single-tenant app: its directory (tenant) ID. Leave empty for a multi-tenant one.',
    googlechatKey:
      "The service account's JSON key, pasted whole, or the path to the .json file on the computer Myrmidon runs on.",
    googlechatAudience:
      "Your Google Cloud project number, when the app's Authentication Audience is Project Number. Leave empty when it is the HTTP endpoint URL.",
  },
  /** WeChat's linking, and what it adds to messages (quotes, its own voice transcripts). */
  weixin: {
    scan: 'Scan this code with WeChat on your phone',
    scanned: 'Scanned: confirm on your phone',
    expired: 'The code expired unscanned; turn WeChat off and on for a new one',
    sessionExpired:
      'WeChat says the session expired; trying again in 10 minutes (if it persists, link again)',
    quoted: (what: string) => `[Quoting: ${what}]`,
    quotedMedia: (title: string) => (title ? `[Quoting media: ${title}]` : '[Quoting media]'),
    voice: '[Voice note, transcribed by WeChat]',
  },
}
