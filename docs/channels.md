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
know. Without a public address it polls, which needs nothing reachable from the internet. iMessage does the same
with BlueBubbles (`/hooks/channels/imessage`, the secret in the URL). Signal and Matrix always connect out (an event
stream, `/sync`), so they need no public address.

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.
- **"cannot reach signal-cli"**: start its daemon with `--http` (not `--socket` or `--dbus`), and give the address
  it listens on. **"signal-cli has no account"**: the number is not registered or linked in that daemon's data.
- **"BlueBubbles refused this password"**: copy the server password again (BlueBubbles → Settings → Connection).
  Nothing arrives: check the address works from this machine (`curl <address>/api/v1/ping?password=…`).
- **"Matrix refused this access token"**: the token was logged out; make a new one. The bot joins but stays
  silent: the room is encrypted (see above).
