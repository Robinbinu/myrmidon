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
   Channels (press **Approve**) or with:

   ```bash
   myrmidon channels approve telegram K7QX3MNP
   ```

   The first person approved is the **owner**; anyone approved later is a **member**.

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

## Using it

- Send what you want done. A status line appears and updates as the crew works ("researcher: searching …"),
  then reads "Done · 2m 10s · $0.04", and the answer arrives as a new message (long ones in marked parts), followed
  by the files the run made (as files, up to five; more are listed by name).
- **What the chat shows while the crew works** (Settings → Channels): the status line (default), the answer as it
  is written (edited into one message), or just a typing indicator.
- Writing while it works reaches the crew at once, as in the app.
- **Questions** with options arrive as buttons (or a numbered list to answer by number); several questions are
  answered one by one and sent together.
- **Approvals**: a risky step waiting for an OK is sent to the owner with **Allow once**, **Always allow <tool>**
  (which sets that tool to "allow" in Settings → Tools) and **Deny**. Only the owner's press counts; a member's run
  asks the owner in the owner's own chat. Unanswered after 15 minutes, it is denied. Without buttons, reply
  `/approve KEY`, `/approve KEY always` or `/deny KEY`. Deciding in the app closes the message too.
- **Photos and files** you send go to the crew as attachments (up to 10 MB). **Voice notes** are transcribed (with an
  OpenAI or Groq key in Settings → Models) and the transcript is echoed back so you see what was heard.
- Each Telegram chat is a chat in the app too ("Telegram · Alice" in the sidebar); either can continue it.
- Commands: `/new` (fresh conversation), `/stop`, `/status`, `/help`, `/approve`, `/deny`.
- **Schedules** can send each run's status and answer to you: pick the channel under "Send results to".
- Agents can message you with the `channels_send` tool, e.g. when long work is done.
- Answers that fail to send (a network drop) are retried, and resent after a restart, marked as possibly repeated.

## Who can talk to it

- **Direct messages**: *approve with a code* (default: strangers get a code valid an hour, one per person per 10
  minutes, at most 3 waiting, and nothing they write is acted on), *listed people only* (strangers are ignored
  without a reply), *anyone* (only for a bot no one else knows: an approved person's messages run with this
  machine's tools), or *off*.
- **Let in without a code**: IDs or @usernames; the first of them to write becomes the owner if there is none.
- **Members**' messages reach the agents marked as theirs (not the owner's).
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
stream, `/sync`), so they need no public address.

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
- **SMS: "needs this gateway's public address"**: start the gateway with `--public-url` (see `remote.md`).
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
