# Channels: talk to your agents from Telegram

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Telegram, IRC, Twitch, X, Nostr and Zalo are built in; plugins add more
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

## Platforms without buttons or edits

IRC, Twitch, X, Nostr and Zalo show plain text only: answers arrive as plain text (Markdown markers dropped, links
as `label (url)`), there is no status line to edit (only the answer when done), approvals are answered by typing
`/approve KEY`, `/approve KEY always` or `/deny KEY`, questions by the option's number, and the files a run made
are listed by name (open them in the app). IRC and Twitch clients keep `/…` for their own commands, so there the
commands are typed with `!` instead: `!approve KEY`, `!new`, `!stop`, `!status`, `!help`.

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
   username** under "Let in without a code" (you become the owner) and set **Groups** to *any group*. It then
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

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.
