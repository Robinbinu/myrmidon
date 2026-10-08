# Channels: talk to your agents from Telegram

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Telegram, Discord and Slack are built in; plugins add more platforms. Design:
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
