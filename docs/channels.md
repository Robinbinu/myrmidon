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

Microsoft Teams, Google Chat and LINE only push, so they **need** the public HTTPS address: each posts to
`<public-url>/hooks/channels/<id>` (`msteams`, `googlechat`, `line`), and without `--public-url` the channel shows
an error saying so instead of starting. Every post is checked before anything in it is read: Teams' and Google's
signed tokens against their published keys, LINE's signature against the channel secret.

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
- **Files out**: images up to 4 MB, inline. Other files are listed by name: a bot sends those through a file
  consent card or SharePoint, which are not ported.
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
- **Files out**: listed by name. Uploading needs a person's authorization, which an app does not have.
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
- **Files out**: listed by name. LINE only takes files from a public address of their own, which the gateway does
  not serve.

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.
