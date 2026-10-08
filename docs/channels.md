# Channels: talk to your agents from Telegram

A channel lets you start work, follow it and get the answer from a messaging app, which is most useful with a
gateway on a server (see `remote.md`). Telegram, Feishu / Lark, DingTalk, WeCom, WeChat and QQ are built in (the
last five are set up [below](#feishu--lark)); plugins add more platforms. Design:
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

## Feishu / Lark

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

## DingTalk

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

## WeCom

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

## WeChat

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

## QQ

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

## Troubleshooting

- **"another program is reading this bot"**: only one program may poll a bot (another Myrmidon, or a script).
  Stop it, or make a separate bot.
- **"Telegram refused this token"**: copy it again from @BotFather (`/mybots` → the bot → API Token).
- `MYR_TELEGRAM_API=http://host:port` points Myrmidon at a self-hosted Telegram Bot API server instead of
  api.telegram.org.
