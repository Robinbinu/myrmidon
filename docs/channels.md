# Channels: talk to your agents from Telegram

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Telegram is built in; plugins add more platforms. Design:
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

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.

## WhatsApp (linked device)

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

## WhatsApp Cloud API

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
