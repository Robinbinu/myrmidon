# Channels: talk to your agents from Telegram

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Telegram, Mattermost, email, SMS (Twilio) and ntfy are built in; plugins
add more platforms. Design:
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
for every text (`<public-url>/hooks/channels/sms`, signed by Twilio). Email and ntfy never need one.

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
