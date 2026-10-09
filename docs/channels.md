# Channels: talk to your agents from a messaging app

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Telegram, Signal, iMessage and Matrix are built in; plugins add more
platforms. Design:
`superpowers/specs/2026-10-08-channels-design.md`. The behaviour is ported from Hermes Agent (Nous Research) and
OpenClaw (OpenClaw Foundation), both MIT licensed; see `research/2026-10-08-channels.md`.

## Set up Telegram

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a username, and copy the token it gives you.
2. Give it to Myrmidon: **Settings → Channels → Telegram**, paste the token and press **Save**; or on a server:

   ```bash
   myrmidon channels telegram
   ```

   (it asks for the token without showing it; `myrmidon channels telegram < token.txt` for scripts). The token is
   checked with Telegram first and kept in `<home>/channels/channels.json`, readable only by you.
3. Message your bot. It replies with a **code**, and does nothing else until you approve it, in Settings →
   Channels → People (type the code and press **Make owner**, or **Approve** once there is an owner) or with:

   ```bash
   myrmidon channels approve telegram K7QX3MNP
   ```

   The first person approved is the **owner**; anyone approved later is a **member**. Approving always takes the
   code the bot sent: only whoever received it can know it, so a stranger who wrote first cannot be approved by
   mistake.

Nothing needs to be reachable from the internet: Myrmidon asks Telegram for new messages (long polling).

## Set up Mattermost

1. In Mattermost, open **Integrations → Bot Accounts → Add Bot Account** (a system admin may need to allow bot
   accounts), and copy its token.
2. **Settings → Channels → Mattermost**: the server's address (`https://chat.example.com`) and the token; or
   `myrmidon channels mattermost`.
3. Message the bot directly: it replies with a code to approve, as on Telegram. In a channel, add the bot and
   mention it (`@yourbot`); a reply to a post is a conversation of its own (a thread).

Myrmidon keeps a WebSocket open to the server, so nothing needs to be reachable from the internet. **Buttons**
(approvals, questions) are Mattermost message actions, which the server posts to an address it can reach, so they
appear only on a gateway with a public address (`--public-url`); each carries a signature only the gateway can
make, and a press without it is refused. Without a public address, reply `/approve KEY` — **with a space before the
slash** (` /approve KEY`), as for every command, since Mattermost takes a message starting with `/` as its own
command.

## Set up email

1. Use a **mailbox of its own** for Myrmidon, and an app password where the provider requires one (Gmail, Outlook,
   iCloud). Fill in **Settings → Channels → Email** (or `myrmidon channels email`): the address, the IMAP and SMTP
   servers (ports default to 993 and 587; 465 for SMTP over TLS), the password, and optionally the username (the
   address by default) and the mailbox to watch (`INBOX`).
2. Set **Direct messages** to *listed people only* and list your address under *Let in without a code*. (Under
   *approve with a code* a stranger's mail is answered with a code by mail; Hermes ignores strangers instead, which
   is what *listed people only* does.)
3. Write to it. A new email's subject and text are the request; replying to Myrmidon's answer continues the same
   conversation, and each thread (by `Message-ID`, `In-Reply-To` and `References`) is a conversation of its own.
   Quoted text below your reply is dropped.

Myrmidon watches the mailbox with IMAP IDLE (and checks every minute in case IDLE goes quiet), takes mail newer than
the last it handled, marks it read, and answers with SMTP: a reply with `Re:` and the thread's headers, in plain
text and simple HTML, with the run's files attached. Anyone can write any `From:` line, so mail is accepted only when
the receiving server verified the sender, as its topmost `Authentication-Results` header shows (DMARC pass, or an
SPF or DKIM pass for the sender's domain). Name that server under *Your mail server in Authentication-Results*
(`mx.google.com` for Gmail) to accept only its results; type `off` under *Check senders* only for a mailbox no one
else can write to. Auto-replies, mailing lists and bulk mail (`Auto-Submitted`, `List-Id`, `Precedence`) and mail
from its own address are ignored. Email has no buttons or edits: approvals and questions arrive as their own
emails, answered by replying `/approve KEY` or the option's number.

## Set up SMS (Twilio)

SMS needs a gateway with a public HTTPS address (`--public-url`, see `remote.md`): Twilio delivers each text by
posting it there.

1. In the Twilio console, copy the **Account SID** and **Auth Token**, and buy or pick a number that can send SMS.
2. **Settings → Channels → SMS**: the three of them (the number as `+15551234567`), or `myrmidon channels sms`.
   Myrmidon points the number's incoming-message webhook at `<public-url>/hooks/channels/sms` (replacing what was
   set there; the old address is logged).
3. List your phone number under *Let in without a code* and choose *listed people only*, so strangers are not
   texted codes (each text costs money).

Each post is checked against Twilio's `X-Twilio-Signature` (made with the auth token over the public address and
the message), and refused without it. Answers go out as plain text (Markdown removed), up to 1600 characters per
text (longer ones in marked parts); pictures you send by MMS reach the crew as attachments. `STOP`, `START`, `HELP`
and the like are left to Twilio and the carriers. SMS has no buttons, edits or files out: approvals are answered by
texting `/approve KEY`, and files the run made are listed by name.

The same number can take **phone calls** to the call assistant (Settings → Voice → Phone calls), from the people SMS
lets in by these same rules; see `voice.md`.

## Set up ntfy

[ntfy](https://ntfy.sh) is a push-notification service: you subscribe to a **topic** in its app and anything posted
there arrives on your phone. Anyone who knows the topic can read and write it, so it must be **long and random**
(at least 12 characters unless protected; `openssl rand -hex 12` makes one) or protected with an access token on
your own server.

1. Pick the topic and subscribe to it in the ntfy app (and on the web, if you like).
2. **Settings → Channels → ntfy**: the topic, and optionally a server (`https://ntfy.sh` by default) and an access
   token (`tk_…`, or `user:password`); or `myrmidon channels ntfy`.
3. Post to the topic from the app. It replies with a code to approve, as everywhere: the topic is one conversation
   with one "person", and the access rules still apply.

Myrmidon follows the topic's JSON stream (resuming after the last message it handled) and posts its answers with
Markdown on; its own posts carry a `myrmidon` tag and are not read back. Files go both ways as ntfy attachments
(up to 15 MB on ntfy.sh); there are no buttons or edits, so approvals are answered by posting `/approve KEY`.

## Set up Signal

Signal has no bot accounts, so Myrmidon talks through [signal-cli](https://github.com/AsamK/signal-cli) running as a
daemon, on a phone number of its own (a second SIM or a VoIP number; using your own number makes the bot you).

1. Register the number with signal-cli (`signal-cli -a +15551234567 register`, then `verify CODE`), or link it to a
   phone that has it (`signal-cli link -n myrmidon`, then scan the code in Signal → Settings → Linked devices).
2. Run its daemon with the HTTP API, on the same machine as Myrmidon or one it reaches:

   ```bash
   signal-cli -a +15551234567 daemon --http 127.0.0.1:8080
   ```

3. **Settings → Channels → Signal**: give the daemon's address (`http://127.0.0.1:8080`) and the number, or run
   `myrmidon channels signal`. Myrmidon checks that the daemon has the number first.
4. Message the number from your phone: it replies with a code to approve, as for Telegram.

Messages arrive on the daemon's event stream, reconnected (2 s, doubling to a minute) if it drops. Markdown is sent
as Signal's own bold, italic, strikethrough and monospace. In groups, mention the bot (@ and pick its number) or
reply to one of its messages. Signal has no buttons, so approvals are answered by typing `/approve KEY` (shown
with each request), and questions by the number of an option; and no status line is kept (signal-cli can edit, but
neither Hermes nor OpenClaw relies on it), so the chat shows typing until the answer arrives. Photos, files and
voice notes come in through the daemon (up to 100 MB on Signal's side, 10 MB into Myrmidon); files go out as
attachments. Rate limits from Signal are waited out (attachments are paced the way Hermes does, a bucket of 50
refilled one every few seconds). The bot's sends from its other linked devices (and Note to Self) are not read.

## Set up iMessage

iMessage only runs on a Mac, so Myrmidon talks to a [BlueBubbles](https://bluebubbles.app) server running on a Mac
signed in to the Apple ID the bot should use (a separate Apple ID is best: messages to it are messages to the bot).

1. Install the BlueBubbles server on that Mac, give it Full Disk Access as it asks, and set a **server password**.
   For typing indicators, also enable its Private API (optional; it needs SIP changes, see BlueBubbles' guide).
2. **Settings → Channels → iMessage**: give the server's address as this machine reaches it (e.g.
   `http://192.168.1.20:1234`, or its Cloudflare/ngrok URL) and the password; optionally the **name** people use
   for it in group chats (default `Myrmidon`). Or run `myrmidon channels imessage`.
3. Send that Apple ID an iMessage: it replies with a code to approve.

Without a public address, Myrmidon asks the server for new messages every 2 seconds, from the last one it saw (so a
restart misses nothing). On a gateway with a public address it registers a webhook with the server instead, with a
secret of its own in the URL (BlueBubbles cannot send headers), and removes one it registered before. iMessage has
no bot identity, so in group chats a message is for the bot when it starts with its name (`Myrmidon, …`), @mentions
it, or replies to one of its messages. Replies are plain text (iMessage shows no formatting); there are no buttons
or edits, so approvals are typed (`/approve KEY`) and there is no status line. Photos, files and voice notes come
in and go out as attachments; tapbacks are ignored.

## Set up Matrix

1. Make an account for the bot on any homeserver, and get its **access token**: log in to it in Element, then
   Settings → Help & About → Advanced → Access Token (logging that Element session out ends the token), or log in
   through the API (`POST /_matrix/client/v3/login`).
2. **Settings → Channels → Matrix**: give the homeserver address (`https://matrix.org`) and the token, and
   optionally the bot's user ID (`@myrbot:matrix.org`) to make sure the token is that account's. Or run
   `myrmidon channels matrix`.
3. Invite the bot to a room or start a chat with it: it joins every invite (who it answers is still the access
   rules': strangers get a code), and replies with a code to approve.

**Encrypted rooms are not supported**: reading them needs libolm or vodozemac, which Myrmidon does not ship. Element
encrypts new direct chats by default, so create a room with encryption off (it cannot be turned off later) and
invite the bot there. In an encrypted room the bot says once that it cannot read it.

The bot follows the homeserver with `/sync` long polling, resuming where it stopped after a restart (its history
from before the channel was set up is not answered, nor a newly joined room's older messages). A room is a direct
chat when it is marked so (`m.direct`, or the invite) or has two members. In other rooms a message is for the bot
when it mentions it (a pill, its user ID or name) or replies to it, including in a thread it has written in;
threads are conversations of their own. Replies are Markdown with HTML formatting, the status line is edited in
place (`m.replace`), typing shows while the crew works, and files go through the homeserver's media repository
(authenticated media, with the older path for servers without it). Rate limits (`retry_after_ms`) are waited out.
There are no buttons, so approvals are typed (`/approve KEY`).

## Set up Discord

1. In the [Discord Developer Portal](https://discord.com/developers/applications), press **New Application** and
   name it. Open **Bot**:
   - under **Privileged Gateway Intents**, turn on **Message Content Intent** (without it Discord refuses the
     connection, and Settings says so);
   - press **Reset Token** and copy the token.
2. Invite it: **OAuth2 → URL Generator**, scope **bot**, permissions **View Channels**, **Send Messages**, **Send
   Messages in Threads**, **Read Message History** and **Attach Files**; open the URL and pick your server.
3. Give the token to Myrmidon: **Settings → Channels → Discord**, or `myrmidon channels discord` (or
   `myrmidon channels discord < token.txt`).
4. Send the bot a direct message (your server's privacy settings must allow DMs from members). It replies with a
   **code** to approve, as on Telegram: `myrmidon channels approve discord <code>`.

Myrmidon keeps a WebSocket open to Discord's gateway (resumed after a drop), so nothing needs to be reachable from
the internet; messages sent while it is off are not delivered later.

**HTTP interactions** (optional): if the app has an **Interactions Endpoint URL** (General Information), Discord
sends button presses only there, never over the gateway. On a gateway with a public HTTPS address, set it to
`<public-url>/hooks/channels/discord` and give Myrmidon the app's **Public Key** (General Information) too; each
request is checked against its Ed25519 signature, and Discord's PING is answered so the portal accepts the URL.
Messages still come over the gateway, since Discord sends them nowhere else.

- **In a server channel** it answers only when mentioned (`@bot`) or replied to, after the channel is approved like
  a Telegram group (mention it once; it sends the code). A thread is a conversation of its own; once the bot was
  mentioned in a thread, or wrote in it, it answers there without a mention.
- Approvals and questions come with buttons; a press only the owner may make gets a note only the presser sees.
- Messages are Discord Markdown; links do not unfurl, and nothing an agent writes pings `@everyone`, a role or a
  person. Files up to 10 MB go both ways; voice messages are transcribed like Telegram's.
- Commands are typed as messages: `/new`, `/stop`, `/status`, `/help` (Discord sends them as text, since the bot
  registers no slash commands).

## Set up Slack

1. At [api.slack.com/apps](https://api.slack.com/apps) press **Create New App → From a manifest**, pick the
   workspace and paste:

   ```json
   {
     "display_information": { "name": "Myrmidon" },
     "features": {
       "bot_user": { "display_name": "Myrmidon", "always_online": true },
       "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false }
     },
     "oauth_config": {
       "scopes": {
         "bot": [
           "app_mentions:read", "chat:write", "files:read", "files:write", "users:read",
           "channels:history", "channels:read", "groups:history", "groups:read",
           "im:history", "mpim:history", "mpim:read"
         ]
       }
     },
     "settings": {
       "socket_mode_enabled": true,
       "interactivity": { "is_enabled": true },
       "event_subscriptions": {
         "bot_events": ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"]
       }
     }
   }
   ```

2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`, under OAuth & Permissions).
3. **Basic Information → App-Level Tokens → Generate**, with the scope `connections:write`; copy it (`xapp-…`).
4. Give both to Myrmidon: **Settings → Channels → Slack**, or `myrmidon channels slack` (it asks for each). Both are
   checked with Slack first.
5. Open the app's **Messages** tab in Slack and write to it. It replies with a **code** to approve:
   `myrmidon channels approve slack <code>`.

Myrmidon uses Socket Mode (a WebSocket Slack opens for the app), so nothing needs to be reachable from the internet.

**HTTP mode** (instead of Socket Mode, for a gateway with a public HTTPS address): in the manifest set
`"socket_mode_enabled": false`, and give both `"interactivity"` and `"event_subscriptions"` the `"request_url"`
`<public-url>/hooks/channels/slack`. Skip the app-level token; give Myrmidon the **Signing Secret** (Basic
Information → App Credentials) with the bot token instead. Every request is checked against Slack's `v0` signature
and refused when signed more than five minutes ago; Slack's URL check (its challenge) is answered. With an
app-level token given as well, Myrmidon uses Socket Mode, which must then be on in Slack.

- **In a channel**, invite the app (`/invite @Myrmidon`) and mention it; approve the channel with the code it sends.
  Each message there that mentions it starts a thread, and the answer goes into that thread: each thread is a
  conversation of its own, and inside a thread it was mentioned in (or wrote in) it answers without a mention.
- Approvals and questions come with buttons; a press only the owner may make gets a reply only the presser sees.
- Messages are Slack mrkdwn (bold, italics, code, links); nothing an agent writes can ping `@channel`. Files go both
  ways (Slack's own voice clips are transcribed). Slack has no typing indicator for apps, so the status line is the
  only sign of work.
- Slack keeps `/` for its own commands, so type the commands with `!`: `!new`, `!stop`, `!status`, `!help`.

## Set up WhatsApp (linked device)

Myrmidon joins a WhatsApp account as a **linked device**, the way WhatsApp Web does (through Baileys, as OpenClaw and
Hermes do). Nothing needs to be reachable from the internet, and there is nothing to fill in.

> **Not an official API: WhatsApp can ban numbers it takes for bots.** Use a **spare number** (a second SIM or
> eSIM, or WhatsApp Business on a separate number), not your own; **never message people first**; and **never send
> bulk messages**. For a business number, use the Cloud API below instead.

1. Turn **WhatsApp** on in **Settings → Channels**, or on a server run `myrmidon channels whatsapp` (it prints the
   code in the terminal and waits).
2. On the phone with the spare number: **WhatsApp → Settings → Linked devices → Link a device**, and scan the code.
   Settings then shows the number, e.g. "+15550001111". The code changes every so often; unscanned for a few minutes,
   it stops ("turn WhatsApp off and on here for a new one").
3. From your own phone, message the spare number. It replies with a code to approve, as with Telegram; the first
   person approved is the owner.

- The session is kept in `<home>/channels/whatsapp/auth`, readable only by you. If the phone removes the device (or
  WhatsApp logs it out), the session is deleted and Settings says to turn WhatsApp off and on to link again.
- If the connection drops it reconnects by itself (after 2 s, then longer, up to 30 s). Only one program may use a
  linked device: another WhatsApp Web session taking it over stops this one.
- **Groups**: add the spare number to a group and tag it (`@` its name) or reply to one of its messages; the group
  is approved like Telegram's. Commands (`/status`) count as a mention.
- WhatsApp formatting: **bold**, *italic*, ~~strike~~ and code come through as WhatsApp's own; headings become bold.
  The status line is edited in place, which WhatsApp allows only for 15 minutes after a message is sent: on a longer
  run it stays at its last state, and the answer still arrives as a new message.
- Buttons are not shown on linked devices, so questions arrive as a numbered list (reply with the number) and
  approvals as `/approve KEY`, `/approve KEY always` or `/deny KEY`.
- Photos, documents, videos and voice notes come in as with Telegram; files the run made go back as photos or
  documents (up to 64 MB).

## Set up WhatsApp Cloud API

Meta's **official** WhatsApp Business Platform (ported from Hermes's `whatsapp_cloud` adapter): no ban risk, but it
needs a Meta business app, a gateway with a public HTTPS address (`--public-url`, see `remote.md`), and it only has
direct chats.

1. At [developers.facebook.com](https://developers.facebook.com) create an app and add **WhatsApp**. From
   **WhatsApp → API Setup** copy the **phone number ID** (a long number, not the phone number itself) and an
   **access token**: the one shown there expires in a day, so for real use make a System User token (Business
   settings → System users) with the `whatsapp_business_messaging` permission. From **Settings → Basic** copy the
   **app secret**. Make up a **verify token** (any long random text).
2. In **Settings → Channels → WhatsApp Cloud API** fill in the four and press **Save** (or `myrmidon channels
   whatsapp-cloud`). The token and number ID are checked with Meta first; Settings then shows the business name and
   number.
3. In Meta's **WhatsApp → Configuration**, set the **callback URL** to `<public-url>/hooks/channels/whatsapp-cloud`
   and the **verify token** to the same text, press **Verify and save**, then subscribe to the **messages** field.
4. Message the business number from your phone and approve the code it replies with.

- Every delivery must carry Meta's `X-Hub-Signature-256` (an HMAC of the body with the app secret); anything else is
  refused before it is read. Deliveries for other numbers on the same Meta app are ignored.
- **The 24-hour window**: Meta lets a business reply freely only within 24 hours of the person's last message. A
  schedule's result or a `channels_send` after that fails with "they need to write first".
- Questions with up to three options, and approvals, come as **reply buttons** (titles cut to 20 characters); up to
  ten options as a list; more as a numbered list. Messages cannot be edited, so the chat shows a typing indicator
  instead of a status line, and a button press is confirmed with a short reply.
- Photos, documents, videos and voice notes come in (fetched from Meta with the token); files the run made go back as
  images (up to 5 MB) or documents (up to 100 MB).

## Set up Synology Chat

Needs a gateway with a public HTTPS address (`--public-url`): Synology Chat posts each message to it.

1. In Synology Chat, open **Integration → Bots** and create a bot. Set its **outgoing URL** to
   `<public-url>/hooks/channels/synology-chat`, and copy its **token** and its **incoming URL**.
2. **Settings → Channels → Synology Chat**: paste the incoming URL and the token (`myrmidon channels synology-chat`
   on a server). The incoming URL is checked by asking the NAS for its users.
3. Message the bot: it replies with a code to approve, as on Telegram.

Every post must carry the bot's token (in the body, `?token=`, or an `X-Synology-Token` / `Authorization: Bearer`
header), compared in constant time. Bots are talked to one to one, so every chat is a direct message, keyed by the
person's numeric Synology user id (never by their nickname, which they can change). Synology Chat cannot edit a
bot's messages or show typing, so the answer arrives when the run is done. Files the crew makes are sent as a link
the NAS fetches from the gateway: a random address on the same webhook route that works for ten minutes (up to
32 MB; web pages and markup are not sent).

## Set up Nextcloud Talk

Needs a gateway with a public HTTPS address: Talk posts each message to it.

1. On the Nextcloud server, install a bot with a long secret of your own:

   ```bash
   occ talk:bot:install "Myrmidon" "<secret>" "<public-url>/hooks/channels/nextcloud-talk" --feature webhook --feature response
   ```

   Keep `--feature response`: without it Talk refuses the bot's replies. Then enable the bot in a conversation's
   settings (**Bots**).
2. **Settings → Channels → Nextcloud Talk**: the server address and the same secret. Optionally the bot's name (if
   not "Myrmidon": people mention it as `@name` in group conversations) and a **Nextcloud user with an app
   password** (Personal settings → Security), which lets Myrmidon look up whether a conversation is one to one.

Talk signs each webhook with the secret (`X-Nextcloud-Talk-Signature`, an HMAC-SHA256 of a random value and the
body); unsigned or wrongly signed posts are refused. Replies are signed the same way. Talk's webhook does not say
whether a conversation is one to one, so without the user and app password every conversation is a group: the bot
answers when mentioned, and since codes are only sent in direct chats, let yourself in by your Nextcloud user id
(`users/alice`) under "Let in without a code". With them, one-to-one and note-to-self conversations are direct
chats with a pairing code. The bot API cannot edit messages or send files; shared files are not read (they need
the person's own Nextcloud access).

## Set up SimpleX

Runs the SimpleX Chat terminal app beside the gateway, on the same machine; nothing needs to be public.

1. Install the CLI (`simplex-chat`), start it once in a terminal to create the bot's profile, and make an address
   people can connect to (`/address`). Then run it as a server: `simplex-chat -p 5225`.
2. **Settings → Channels → SimpleX**: the WebSocket address (`ws://127.0.0.1:5225` when left empty).
3. Connect to the bot's address from your phone and send a message: it replies with a code to approve.

Contact requests are accepted (SimpleX has no other way in; Hermes does the same by default), and strangers then get
a code and nothing else. Contacts are kept by their SimpleX contact id, groups as `group:<id>`; a group member who is
also a contact is the same person in both. In groups the bot answers when mentioned (`@name`), replied to, or sent a
command. Photos, voice notes and files you send are downloaded by the daemon and handed to the crew; files the crew
makes are written to the channel's folder for the daemon to send. SimpleX has no typing indicator and the bot does
not edit messages.

## Set up Tlon (Urbit)

1. Get the ship's URL and access code (Landscape: System Preferences → Access Key; or `+code` in the dojo).
2. **Settings → Channels → Tlon**: paste both. Logging in with the code is the check.
3. DM the ship from another ship: it accepts the invitation and replies with a code to approve.

Myrmidon keeps one Eyre channel open to the ship, subscribed to its chat and channels updates (a stream of
server-sent events, acknowledged in batches), and pokes the ship to send; nothing needs to be public. Direct
messages are with a ship (`~sampel-palnet`); group chat channels are conversations by their nest
(`chat/~host/name`), and a reply thread is a conversation of its own, answered in the thread. In groups the ship
answers when its name is mentioned (or `@all`). Images in messages reach the crew as files; Tlon messages are not
edited, and files are not sent.

## Set up a generic webhook

For anything that can send HTTP: scripts, home automation, another service. Needs a gateway with a public HTTPS
address (or a reverse proxy to it).

**Settings → Channels → Webhook**: a shared secret (at least 16 characters, e.g. `openssl rand -hex 32`), the
callback URL replies are POSTed to, and optionally a name. Then POST messages to
`<public-url>/hooks/channels/webhook`:

```json
{ "id": "evt-1", "chat": "kitchen", "sender": { "id": "ha", "name": "Home Assistant" }, "text": "Is the oven off?" }
```

- `chat` is an id (a direct chat), or `{ "id", "kind": "dm" | "group", "title", "thread" }`. In a group,
  `"mentioned": false` marks a message the crew should not answer.
- `files` (optional): `[{ "name", "mimeType", "data": "<base64>" }]`.
- `id` is unique per message: a repeated id is dropped.

Each request is signed with the secret, with the time bound into the signature so a captured request cannot be
replayed, even with a fresh timestamp (Hermes's generic HMAC scheme):

```text
X-Timestamp: <unix seconds>
X-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
```

Unsigned or wrongly signed requests get 401, as do ones signed more than five minutes ago. For example:

```bash
body='{"id":"1","chat":"me","sender":{"id":"me"},"text":"hello"}'; ts=$(date +%s)
sig=$(printf '%s' "$ts.$body" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST "$PUBLIC_URL/hooks/channels/webhook" -H "X-Timestamp: $ts" -H "X-Signature: sha256=$sig" -d "$body"
```

Replies are POSTed to the callback URL as JSON, signed the same way (check them before trusting them):
`{ "type": "message", "id", "chat", "thread"?, "text" }`, `{ "type": "edit", "id", "chat", "text" }` (the status
line is updated by editing its message), and `{ "type": "file", "id", "chat", "name", "mimeType", "data",
"caption"? }`. The callback must answer 2xx; failed replies are retried. No typing indicator is sent.

## Set up Microsoft Teams

You need a public HTTPS address (above) and a Microsoft 365 tenant whose admin allows custom apps.

1. In the Azure portal, create an **Azure Bot** (*Create a resource* → *Azure Bot*). *Type of App*: Multi Tenant,
   or Single Tenant for your organization only; let it create a new Microsoft App ID.
2. In the bot's **Configuration**, set the **Messaging endpoint** to `<public-url>/hooks/channels/msteams` and copy
   the **Microsoft App ID**. Under *Manage Password* → *Certificates & secrets*, add a **client secret** and copy its
   value (it is shown once).
3. In the bot's **Channels**, add **Microsoft Teams** and apply.
4. Give them to Myrmidon: **Settings → Channels → Microsoft Teams** (app ID, client secret, and the directory
   (tenant) ID only for a single-tenant app), or `myrmidon channels msteams`. They are checked by getting a token
   from Microsoft first.
5. Install the bot in Teams: in the **Developer Portal for Teams** (dev.teams.microsoft.com) make an app, add a
   **Bot** feature with the existing app ID and the scopes you want (personal, team, group chat), then *Preview in
   Teams* or download the package and upload it under *Apps → Manage your apps*. Message it: it replies with a code
   to approve, as on Telegram.

No Microsoft Graph permissions are needed. What works and what does not:

- Direct chats, group chats and channels. Outside a direct chat Teams only sends the bot messages that @mention
  it; a channel post and its replies are one conversation. With a tenant ID set, activities from other tenants are
  refused.
- Buttons are Adaptive Card actions, messages are edited in place (the status line, approvals) and a typing
  indicator shows while the crew works. Markdown is sent as is; Teams renders it.
- **Files in**: files sent in a direct chat and images pasted there. Images pasted in a channel or group chat are
  not fetched (they need Microsoft Graph).
- **Files out**: images up to 4 MB, inline. Other files (up to 20 MB) come as a link to download them from the
  gateway (see *Webhooks* below). A bot's own upload is a file consent card, which works only in direct
  chats and needs `supportsFiles` in the app manifest, or SharePoint through Microsoft Graph; neither is used.
- Only Teams itself is taken: the Azure portal's *Test in Web Chat* does not reach Myrmidon.

## Set up Google Chat

You need a public HTTPS address (above) and a Google Workspace account (Chat apps are not available to personal
Gmail accounts).

1. In the Google Cloud console, pick or create a project and enable the **Google Chat API**.
2. Under *IAM & Admin → Service Accounts*, create a service account (it needs no roles), then *Keys → Add key →
   JSON*, and keep the downloaded file.
3. In the Google Chat API's **Configuration**: give the app a name, avatar and description; under *Functionality*
   let it join spaces and group conversations; under *Connection settings* pick **HTTP endpoint URL** and enter
   `<public-url>/hooks/channels/googlechat`; set **Authentication Audience** to *Project Number* (or *HTTP endpoint
   URL*); choose who may see it; save.
4. Give them to Myrmidon: **Settings → Channels → Google Chat**, or `myrmidon channels googlechat`. Paste the key
   file's contents whole (or the path to the file on the gateway) and the **project number** (on the project's
   dashboard); leave the project number empty when the audience is the HTTP endpoint URL. The key is checked by
   getting a token and listing the app's spaces.
5. In Chat, find the app (*New chat* → search its name) and message it: it replies with a code to approve.

What works and what does not:

- Direct messages and spaces. In a space, Chat only sends an app messages that @mention it (or its slash
  commands); a reply thread is a conversation of its own, as is each thread of a threaded space.
- Buttons are card buttons, messages are edited in place. Chat has no typing indicator for apps, so the status
  line is what shows the crew working. Markdown is turned into Chat's own formatting (`*bold*`, `_italic_`, links).
- **Files in**: files uploaded to Chat. Google Drive files shared in a message are not fetched (they need the
  person's own authorization).
- **Files out**: a link to download each file from the gateway (see *Webhooks* below). Chat's own
  upload (`media.upload`) needs a person's authorization, which an app does not have.
- Chat apps built as Google Workspace add-ons (their events come in another shape) are not supported: configure
  the app in the Google Chat API as above.

## Set up LINE

You need a public HTTPS address (above).

1. In the LINE Developers console (developers.line.biz), create a provider and a **Messaging API** channel (it
   comes with a LINE Official Account).
2. On the channel's *Basic settings* tab, copy the **Channel secret**; on the *Messaging API* tab, issue a
   **Channel access token (long-lived)** and turn on **Use webhook**. To use the bot in groups, turn on *Allow bot to
   join group chats*. In LINE Official Account Manager, turn off *Auto-reply messages* and *Greeting messages*, or
   the account answers with its canned replies too.
3. Give them to Myrmidon: **Settings → Channels → LINE**, or `myrmidon channels line`. The token is checked with
   LINE, and Myrmidon sets the channel's webhook URL to `<public-url>/hooks/channels/line` itself.
4. Add the bot as a friend (the QR code on the *Messaging API* tab) and message it: it replies with a code to
   approve.

What works and what does not:

- Direct chats, groups and multi-person chats. In a group the bot sees every message and acts on those that
  @mention it or quote one of its messages (unless you turn mentions off).
- **Replies cost messages**: an answer within a minute of your message uses its free reply token; anything later
  (most finished runs) is a push message, which counts against your plan's monthly allowance (small on free plans;
  check yours in LINE Official Account Manager). When it runs out, LINE refuses sends until the next month.
- Buttons are quick replies: at most 13, labels cut to 20 characters, and LINE shows them only under the newest
  message. LINE cannot edit a sent message, so there is no status line (a loading animation shows in direct chats
  instead) and an approval's outcome comes as a short reply to the press.
- No formatting: Markdown is sent as plain text, links spelled out.
- **Files in**: photos, videos, files, and audio messages (transcribed as voice notes).
- **Files out**: LINE takes no file from a bot, only an HTTPS address to fetch it from, which the gateway serves
  (see *Webhooks* below). A JPEG or PNG up to 1 MB comes as a photo; anything else, video and audio
  included, as a link (LINE's video and audio messages also need a preview image or the length, which would mean
  decoding the file).

## Set up Feishu / Lark

1. On [open.feishu.cn](https://open.feishu.cn/app) (Lark: [open.larksuite.com](https://open.larksuite.com/app)),
   **Create Custom App**, then under **Add Features** add **Bot**.
2. **Permissions & Scopes**: add `im:message` (read and send messages), `im:message:send_as_bot`,
   `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly` (group @-mentions) and
   `im:resource` (images and files). Optionally `contact:user.base:readonly`, so people show by name rather than
   as "Feishu user".
3. Give Myrmidon the **App ID** and **App Secret** (Credentials & Basic Info), in Settings → Channels → Feishu / Lark
   or with `myrmidon channels feishu`. Set **Region** to `lark` for a Lark (larksuite.com) app.
4. **Events & Callbacks**: set the subscription mode to the **long (persistent) connection** (Feishu only lets you
   save it while an app is connected, so do step 3 first), and add the event **Receive messages**
   (`im.message.receive_v1`). Under the callback settings, also choose the long connection and add the **card
   action** callback (`card.action.trigger`), which carries button presses.
5. **Create a version and publish** the app (an admin may need to approve it), then message the bot: it replies
   with a code to approve, as on Telegram.

The long connection is a WebSocket Myrmidon opens, so **nothing needs to be reachable from the internet**. To have
Feishu post events instead (**Send events to developer server**), use a gateway with a public address, set the
request URL to `<public-url>/hooks/channels/feishu`, and give Myrmidon the app's **Verification Token** and, if you
set one, **Encrypt Key** (Events & Callbacks → Encryption Strategy). Webhooks are refused without them; with the
Encrypt Key each one's signature is checked and its body decrypted, and one signed more than an hour from the
gateway's clock is refused.

Answers are posts, edited in place as the crew works; approvals and questions are cards with buttons. Images and
files go both ways (images up to 10 MB, files up to 30 MB). A topic in a group is a conversation of its own. In
groups the bot sees only messages that @mention it. Feishu has no typing indicator for bots.

## Set up DingTalk

1. In the [DingTalk developer console](https://open-dev.dingtalk.com/), create an **internal app** (H5 micro-app or
   app with a robot), and under **Robot** turn it on with **Stream mode** as the message receiving mode.
2. Give Myrmidon the **Client ID** (AppKey) and **Client Secret** (AppSecret), in Settings → Channels → DingTalk or
   with `myrmidon channels dingtalk`. The robot code is the Client ID for most robots; set it only if DingTalk shows
   a different one.
3. **Permissions**: for answers that arrive after the chat's reply address has expired (it lasts a while after
   each message), add `qyapi_robot_sendmsg` (the robot sends messages); for files people send, the permission to
   download the robot's message files.
4. Publish the app, add the robot to a chat or message it directly: it replies with a code to approve.

Stream mode is a WebSocket Myrmidon opens, so **nothing needs to be reachable**. A robot set to **HTTP mode**
instead posts to `<public-url>/hooks/channels/dingtalk` (a gateway with a public address); each post's signature (an
HMAC of its timestamp with the Client Secret) is checked, and one more than an hour old is refused.

Answers are Markdown messages. **DingTalk cannot edit a robot's message**, so there is no status line: the answer
arrives when the run is done. Its ActionCard buttons only open links, so approvals and questions are answered by
typing (`/approve KEY`, or an option's number). Pictures, files, video and voice notes come in (voice
notes as DingTalk's own transcript); files the crew makes are listed by name. In groups the robot sees only messages
that @mention it.

## Set up WeCom

WeCom delivers messages to an address of yours, so it needs **a gateway with a public HTTPS address**
(`--public-url`, see `remote.md`).

1. In the [WeCom admin console](https://work.weixin.qq.com/wework_admin/frame#apps), **App Management → Create
   App**, and note its **AgentId** and **Secret**; the **Corp ID** is under My Company.
2. In the app, **Receive Messages → Set API Receiving**: URL `<public-url>/hooks/channels/wecom`, and generate a
   **Token** and an **EncodingAESKey**. Before saving, give all five values to Myrmidon (Settings → Channels → WeCom,
   or `myrmidon channels wecom`), since WeCom checks the address when you save.
3. Add the gateway's public IP to the app's **Trusted IPs**, or WeCom refuses its replies. WeCom may also require
   the callback address's domain to be a trusted domain of your organization (for newer apps, one registered to
   it), which a tunnel's shared domain is not.
4. Message the app in WeCom: it replies with a code to approve.

Every callback's SHA-1 signature is checked and its AES-256 body decrypted (and must be for your corp), as Tencent's
`WXBizMsgCrypt` does. Apps receive **direct messages only** (WeCom does not deliver group chats to apps). Answers are
plain text, split under WeCom's 2048-byte limit; WeCom cannot edit them, and approvals and questions are typed.
Images, voice, video and files come in; images and files go out (up to 10 MB and 20 MB). People show by name when the
app's visible range includes them.

## Set up WeChat

WeChat has no bot API for personal accounts. Like Hermes Agent, Myrmidon uses Tencent's **iLink bot API**: you link
it by scanning a code, and it gets a bot identity (an `…@im.bot` account) that people message directly.

1. Settings → Channels → WeChat: turn it **on**. A QR code appears.
2. In WeChat on your phone, scan it and confirm. The link is kept in `<home>/channels/weixin/account.json`, readable
   only by you; delete that file (with WeChat off) to link another account.
3. Message the bot: it replies with a code to approve.

Nothing needs to be reachable: Myrmidon long-polls iLink. Every reply carries the latest "context token" of the
person it answers, so the bot answers people who have written to it; if WeChat says the session expired it waits
ten minutes and tries again (if that keeps happening, link again). WeChat cannot edit messages and has no buttons, so
there is no status line and approvals and questions are typed. Short chatty replies are sent as separate bubbles, as
in a conversation. Images, video and files go both ways through WeChat's encrypted CDN; voice notes come in as
WeChat's own transcript (their SILK audio cannot be transcribed here). The bot identity usually cannot be added to
ordinary groups, so in practice it answers direct messages. iLink is Tencent's, not a published API, so it may change.

## Set up QQ

1. On the [QQ Open Platform](https://q.qq.com/), create a bot; in its development settings note the **App ID**
   and **AppSecret** and add the gateway's public IP to the **IP allowlist**.
2. Under **Features**, turn on **direct messages** (C2C) and **group @-messages**; add the bot to a group, or message
   it from QQ.
3. Give Myrmidon the App ID and AppSecret (Settings → Channels → QQ, or `myrmidon channels qq`).
4. Message the bot: it replies with a code to approve.

Myrmidon keeps QQ's WebSocket gateway open (heartbeats, and a resume after a drop), so **nothing needs to be
reachable**. Answers are Markdown with **buttons** for approvals and questions, which need QQ's Markdown permission
for the bot: without it, set **Markdown** to `off` (it also falls back to plain text by itself on the first refusal),
and approvals and questions are typed. QQ cannot edit messages, so there is no status line. Replies cite the message
they answer, which QQ allows for 60 minutes in a direct chat and 5 in a group, up to 5 replies; after that they are
"active" messages, of which QQ allows only a few (and fewer each year), so a long run's answer may not arrive in
a quiet group. Images,
files and voice notes come in; images, video and files go out (up to 10 MB).

## Set up IRC

**Settings → Channels → IRC** (or `myrmidon channels irc`): the server (`irc.libera.chat`), the port (6697 with TLS,
the default; 6667 without), TLS `on`/`off`, the bot's nick, and the channels to join (`#a, #b`). A **password** is
sent by SASL PLAIN when the server offers it (the nick must then be the account's name), and otherwise as the server
password (`PASS`, before registering). Ported from OpenClaw's and Hermes's IRC adapters.

- Message the bot directly (`/msg mybot hello`): it replies with a code to approve, as on Telegram.
- In a channel it answers lines that address it: `mybot: …`, `mybot, …`, or its nick anywhere as a word (the nick
  is removed from the text). Approve the channel with the code it sends when an approved person first addresses it.
- People are known by `nick!user@host` (the server vouches for that, not for an account), so a new host means a new
  code. Under "Let in without a code", a bare nick trusts whoever uses that nick; the full mask is safer. Register
  your nick with NickServ so nobody else can take it.
- If the nick is taken it becomes `mybot_` (then `mybot__`…). Long answers are cut into lines of at most 400 bytes
  and paced (four at once, then one a second) so the network does not disconnect the bot for flooding. A dropped
  connection is retried with backoff (1 s, doubling to 30 s); a refused password, nick or ban stops it with the
  reason.

## Set up Twitch

1. Make a Twitch account for the bot, and an OAuth **token** for it with the `chat:read` and `chat:edit` scopes
   (your own app in the Twitch Developer Console, or a token generator).
2. **Settings → Channels → Twitch**: the bot's username, the token (with or without `oauth:`), and the channels to
   join (the bot's own when empty). The token is validated with Twitch (it must belong to that username and carry
   both scopes), again on every connection and every hour, as Twitch requires.
3. Twitch chat is public and bots cannot whisper, so there is no direct chat to send a code to: put **your Twitch
   username** under "Let in without a code" and set **Groups** to *any group*; after your first message, make
   yourself the owner in Settings → Channels → People. It then
   answers only listed and approved people, and only when they `@mention` it or reply to it; everyone else is
   ignored.

Answers are one line of plain text, cut into messages of 500 characters, sent as a reply to the mention, and paced
under Twitch's limit for bots that are not moderators (20 messages per 30 seconds). Generated tokens expire after a
few hours; when Twitch stops accepting the token the channel stops with "Twitch refused this token" and a new token
is needed (refresh tokens are not supported).

## Set up X

**The X API is paid**: the free tier cannot read mentions, so the app needs a paid plan (Basic or above, or
pay-per-use), and each poll and post is billed by X. Ported from OpenClaw's X plugin, with its safety rule: replies
are public, so it only ever answers the accounts you list.

1. In the X developer portal, set the app's permissions to **Read and write** (and **Direct Messages** if it should
   read and answer DMs), then generate, for the bot account, the **API key and secret** and the **access token and
   secret** (OAuth 1.0a user tokens: they do not expire or rotate).
2. **Settings → Channels → X**: the four keys, and **Answers publicly**: the accounts whose mentions it answers
   (`@you, 123456789`; usernames are looked up once to their numeric IDs, which is what is checked). Mentions from
   anyone else are dropped without a reply.
3. Put the same accounts under "Let in without a code", and set **Groups** to *any group*: each X thread is a
   conversation (a group) of its own, and approving every thread by code would post the code publicly.

Mentions are polled every 90 seconds (the cursor survives restarts; the first poll starts from now, so old mentions
are not answered). The answer is posted as replies threaded under the mention, cut to 280 weighted characters (CJK
and emoji count two, links 23). DMs are polled too when the app may read them and go through the usual pairing
code; without the permission they are switched off and the log says so. Rate limits are waited out (until X's
reset time).

## Set up Nostr

**Settings → Channels → Nostr**: the bot's **private key** (`nsec1…` or 64 hex characters; make a fresh key for the
bot rather than using your own) and its **relays** (`wss://relay.damus.io, wss://nos.lol` when empty). Saving shows
the bot's `npub`; message it from any client with NIP-04 direct messages (Damus, Amethyst…) and approve the code it
replies with. Ported from OpenClaw's Nostr plugin.

- It subscribes on every relay to encrypted DMs (kind 4) tagged with its key, resuming two minutes before the last
  message it handled. Each event's signature, size, date and sender rate are checked before it is decrypted, and
  the copies other relays deliver are dropped.
- Answers are encrypted to the sender, signed by the bot, and published to every relay; sending fails only when no
  relay accepts it. Relays that drop are reconnected with backoff.
- Under "Let in without a code", list people by `npub1…` or hex public key.
- Gift-wrapped DMs (NIP-17) are not read yet: OpenClaw lists them as planned, so clients that only send NIP-17 will
  not reach it.

## Set up Zalo

**Settings → Channels → Zalo**: the bot token from [Zalo Bot Creator](https://bot.zaloplatforms.com) (sign in,
create a bot; it looks like `12345689:abc-xyz`). Message the bot in Zalo and approve the code it replies with. In
groups it answers when `@mentioned`. Ported from OpenClaw's `zalo` plugin: this is Zalo's official bot API. The
personal-account route (OpenClaw's `zalouser`, which drives a logged-in Zalo account) is deliberately not ported:
OpenClaw warns that it can get the account banned.

It polls Zalo by default (nothing reachable from the internet needed). On a gateway with a public HTTPS address,
Zalo instead posts to `<public-url>/hooks/channels/zalo`, each request carrying a secret header only Zalo and the
gateway know (others are refused). The token does not expire. Answers are plain text up to 2000 characters; photos
sent to the bot come in as attachments; files cannot be sent back (Zalo takes photos only by public URL).
`MYR_ZALO_API=http://host:port` points it at another Bot API address.

## Using it

- Send what you want done. A status line appears and updates as the crew works ("researcher: searching …"),
  then reads "Done · 2m 10s · $0.04", and the answer arrives as a new message (long ones in marked parts), followed
  by the files the run made (as files, up to five; more are listed by name).
- **What the chat shows while the crew works** (Settings → Channels): the status line (default), the answer as it
  is written (edited into one message), or just a typing indicator.
- Writing while it works reaches the crew at once, as in the app.
- **Questions** with options arrive as buttons (or a numbered list to answer by number); several questions are
  answered one by one and sent together.
- **Approvals**: a risky step waiting for approval is sent to the owner with **Allow once**, **Always allow <tool>**
  (which sets that tool to "allow" in Settings → Tools) and **Deny**. Only the owner's press counts. A run a
  member (anyone but the owner) starts or writes into asks the owner, in the owner's own chat, before every step
  that changes something outside the run (files, commands, the browser, MCP and plugin tools) and before reading
  the chat's project folder, even tools set to "allow", and offers no **Always allow**. Web searches and page reads,
  and the agents' own notes and scratch files, need no approval. Unanswered after 15 minutes, it is denied. Without buttons, reply
  `/approve KEY`, `/approve KEY always` or `/deny KEY`. Deciding in the app closes the message too.
- **Photos and files** you send go to the crew as attachments (up to 10 MB). **Voice notes** are transcribed (with an
  OpenAI or Groq key in Settings → Models) and the transcript is echoed back so you see what was heard.
- Each Telegram chat is a chat in the app too ("Telegram · Alice" in the sidebar); either can continue it.
- Commands: `/new` (fresh conversation), `/stop`, `/status`, `/help`, `/approve`, `/deny`.
- **Schedules** can send each run's status and answer to you: pick the channel under "Send results to".
- Agents can message you with the `channels_send` tool, e.g. when long work is done.
- Answers that fail to send (a network drop) are retried, and resent after a restart, marked as possibly repeated.

## Platforms without buttons or edits

IRC, Twitch, X, Nostr and Zalo show plain text only: answers arrive as plain text (Markdown markers dropped, links
as `label (url)`), there is no status line to edit (only the answer when done), approvals are answered by typing
`/approve KEY`, `/approve KEY always` or `/deny KEY`, questions by the option's number, and the files a run made
are listed by name (open them in the app). IRC and Twitch clients keep `/…` for their own commands, so there the
commands are typed with `!` instead: `!approve KEY`, `!new`, `!stop`, `!status`, `!help`.

## Who can talk to it

- **Direct messages**: *approve with a code* (default: strangers get a code valid an hour, one per person per 10
  minutes, at most 3 waiting, and nothing they write is acted on), *listed people only* (strangers are ignored
  without a reply), *anyone* (only for a bot no one else knows: an approved person's messages run with this
  machine's tools), or *off*.
- **Let in without a code**: IDs or @usernames. Listed people come in as members: an owner is made only by
  approving a code or with **Make owner** under People. A handle matches only where the platform vouches for it;
  on IRC, where anyone can take a free nick, list the full `nick!user@host`.
- **Members**' messages reach the agents marked as theirs (not the owner's), and their runs ask the owner before
  every step that changes something or reads the project. Their runs never get full access: they stay in the
  sandbox even when the owner turned it off in Settings → Tools or gave the project full access, and a run the
  owner started with full access is sandboxed from the moment a member writes into it. Nor do they get the extra
  folders the owner opened for reading (in Settings, a project or a chat). In a group, only whoever asked for a run (or the owner)
  can answer its questions.
- **Groups**: add the bot to a group and mention it; the bot sends a code for the group, which you approve. It then
  answers only when mentioned or replied to (unless you turn that off), and only to approved people. Groups can be
  *approve each*, *any group* or *off*; with *a conversation per person*, each person gets their own chat with the
  crew. Forum topics are conversations of their own. Telegram's *privacy mode* (on by default)
  already shows a bot only mentions and commands; if you change it, remove and re-add the bot.
- Revoke anyone in Settings → Channels or with `myrmidon channels revoke telegram <name, @handle or id>`.
- `myrmidon channels` lists the status, approved people and waiting codes; `myrmidon channels telegram set dm
  allowlist` (and `groups`, `mention`, `per-person`, `allow`, `stream`, `project`) changes the rules from a server;
  `myrmidon doctor` checks it.

## Webhooks

On a gateway with a public HTTPS address (`--public-url`, see `remote.md`), Telegram pushes messages to
`<public-url>/hooks/channels/telegram` instead of being polled, each carrying a secret only Telegram and the gateway
know. Without a public address it polls, which needs nothing reachable from the internet. Mattermost's button
presses arrive at `<public-url>/hooks/channels/mattermost` (signed by the gateway), and SMS needs the public address
for every text (`<public-url>/hooks/channels/sms`, signed by Twilio). Email and ntfy never need one. iMessage does the same
with BlueBubbles (`/hooks/channels/imessage`, the secret in the URL). Signal and Matrix always connect out (an event
stream, `/sync`), so they need no public address. Slack and Discord connect out too, unless set up to post instead:
Slack in HTTP mode (`/hooks/channels/slack`, signed with the app's signing secret) and Discord's HTTP interactions
(`/hooks/channels/discord`, signed with the application's Ed25519 key), as described in their sections.

Microsoft Teams, Google Chat and LINE only push, so they **need** the public HTTPS address: each posts to
`<public-url>/hooks/channels/<id>` (`msteams`, `googlechat`, `line`), and without `--public-url` the channel shows
an error saying so instead of starting. Every post is checked before anything in it is read: Teams' and Google's
signed tokens against their published keys, LINE's signature against the channel secret.

Teams, Google Chat and LINE get the files a run made as links to the gateway's public address:
`<public-url>/hooks/channels/<channel>?file=<random token>`. Each link works for 7 days (across restarts; the
files are kept in the channel's own folder and deleted once they expire), and the link is the only key, like any
shared download link: whoever has it can download the file. Photos, audio and video open in place; anything else
is a download, never a page that could run on the gateway. Without an HTTPS public address no link is made, and the
files are listed by name to open in the Myrmidon app.

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.
- **Mattermost: a command answers "Command not found"**: Mattermost took it as its own slash command; type a space
  before the slash.
- **Email: nothing happens when you write**: look for "ignored mail from an unverified sender" in the gateway's log.
  Your mail server may not add `Authentication-Results`, or adds it under another name than the one you entered;
  check a received message's headers. "The mail server refused this username and password" usually means an app
  password is needed.
- **SMS: "needs this Myrmidon's public address"**: start the gateway with `--public-url` (see `remote.md`).
- **ntfy: "Pick a topic of at least 12 characters"**: short topics are easy to guess, and anyone who guesses one
  reads your answers; use a random one, or an access token.
- **"cannot reach signal-cli"**: start its daemon with `--http` (not `--socket` or `--dbus`), and give the address
  it listens on. **"signal-cli has no account"**: the number is not registered or linked in that daemon's data.
- **"BlueBubbles refused this password"**: copy the server password again (BlueBubbles → Settings → Connection).
  Nothing arrives: check the address works from this machine (`curl <address>/api/v1/ping?password=…`).
- **"Matrix refused this access token"**: the token was logged out; make a new one. The bot joins but stays
  silent: the room is encrypted (see above).
- **"Discord refused the Message Content intent"**: turn it on (Developer Portal → Bot → Privileged Gateway
  Intents) and save the channel again. Without it the bot would see empty messages in servers.
- **Discord: the bot never answers in a channel**: it needs View Channels and Send Messages there (Send Messages
  in Threads for threads), and a mention, or a reply to one of its messages.
- **"The app is not in that channel"** (Slack): invite it with `/invite @your-app`.
- **"Socket Mode is off for this Slack app"**: turn it on under Settings → Socket Mode.
- **Slack: no answer in direct messages**: App Home → "Allow users to send Slash commands and messages from the
  messages tab" must be on, and the app needs `im:history` and the `message.im` event (reinstall after changing
  scopes).
- **"Slack sent a page instead of the file"**: give the app `files:read` and reinstall it.
- **"needs a public HTTPS address"** (Synology Chat, Nextcloud Talk, webhook): these platforms post to the gateway,
  so start it with `--public-url` (see `remote.md`) and point the platform at `<public-url>/hooks/channels/<id>`.
- **"cannot reach simplex-chat"**: start the CLI with `simplex-chat -p 5225` on this machine.
- **"the ship refused this access code"**: the code changes when it is reset (`+code` shows the current one).
