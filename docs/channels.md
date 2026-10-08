# Channels: talk to your agents from Telegram

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Built in: Telegram, Synology Chat, Nextcloud Talk, SimpleX, Tlon and a
generic signed webhook (below); plugins add more platforms. Design:
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
know. Without a public address it polls, which needs nothing reachable from the internet.

## Synology Chat

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

## Nextcloud Talk

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

## SimpleX

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

## Tlon (Urbit)

1. Get the ship's URL and access code (Landscape: System Preferences → Access Key; or `+code` in the dojo).
2. **Settings → Channels → Tlon**: paste both. Logging in with the code is the check.
3. DM the ship from another ship: it accepts the invitation and replies with a code to approve.

Myrmidon keeps one Eyre channel open to the ship, subscribed to its chat and channels updates (a stream of
server-sent events, acknowledged in batches), and pokes the ship to send; nothing needs to be public. Direct
messages are with a ship (`~sampel-palnet`); group chat channels are conversations by their nest
(`chat/~host/name`), and a reply thread is a conversation of its own, answered in the thread. In groups the ship
answers when its name is mentioned (or `@all`). Images in messages reach the crew as files; Tlon messages are not
edited, and files are not sent.

## Generic webhook

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

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.
- **"needs a public HTTPS address"** (Synology Chat, Nextcloud Talk, webhook): these platforms post to the gateway,
  so start it with `--public-url` (see `remote.md`) and point the platform at `<public-url>/hooks/channels/<id>`.
- **"cannot reach simplex-chat"**: start the CLI with `simplex-chat -p 5225` on this machine.
- **"the ship refused this access code"**: the code changes when it is reset (`+code` shows the current one).
