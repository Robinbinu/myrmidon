# Channels — design

Approved choices (2026-10-08): **Telegram first**; access is **me plus people I approve** (pairing codes); **approvals
and questions answered in the chat**; progress as **a status line that updates**, then the answer as a new message.
Research: `docs/research/2026-10-08-channels.md`.

## Goals

- Talk to Myrmidon from a messaging app, most usefully to a gateway on a VPS: start work, follow it, answer its
  questions and approvals, get the answer — from a phone.
- One channel layer that every platform shares, so WhatsApp, Slack, Discord, Signal or email are each a small
  adapter later.
- Nothing about the app gets weaker: a channel is just another way into the same chats, with the same permissions.

## Architecture

```
Telegram ⇄ TelegramAdapter ⇄ ChannelHub (access · sessions · progress · approvals · ledger) ⇄ ChatService
```

**Adapter** (`packages/runtime/src/channels/types.ts`): what a platform implements, and nothing more.

```ts
interface ChannelAdapter {
  readonly id: string                       // 'telegram'
  readonly label: string                    // 'Telegram'
  readonly limits: { text: number; editMs: number }   // 4096 chars; ≥1000 ms between edits of one message
  readonly can: { buttons: boolean; edit: boolean; typing: boolean }
  start(io: AdapterIO): Promise<void>       // begins receiving; calls io.receive(inbound) for each message
  stop(): Promise<void>
  send(to: ChatAddress, message: OutMessage): Promise<SentRef>
  edit(ref: SentRef, message: OutMessage): Promise<void>
  typing(to: ChatAddress): Promise<void>
  answerButton?(press: ButtonPress, note?: string): Promise<void>
}
interface Inbound {
  messageId: string; chat: { id: string; kind: 'dm' | 'group'; title?: string }
  sender: { id: string; name: string; handle?: string }; text: string
  mentioned: boolean; press?: ButtonPress; time: string
}
interface OutMessage { text: string /* Markdown, the adapter renders it */; buttons?: Button[][] }
```

**ChannelHub** (`packages/runtime/src/channels/hub.ts`) owns everything shared: access, sessions, commands,
progress, approvals, chunking, dedupe and delivery. It talks to chats only through `ChatService` (send, stream,
approvals, stop), so it works the same for the lead/worker team, the swarm and a future org mode; `@name` in a
message already reaches one agent directly.

**Built-in and plugin adapters.** Telegram is built in (`channels/telegram.ts`), started by the server when it has a
token. Plugins add more later through `ctx.channels.register(adapter)`, so WhatsApp (Baileys or the Cloud API) can be
a plugin with its own dependency, switched on by the person.

**State** (`<home>/channels/`, owner-only): `channels.json` (0600: tokens, approved people, chat → Myrmidon chat
map) and `channels.sqlite` (inbound dedupe, Telegram's polling offset, the delivery ledger).

## Access: me plus people I approve

- **Deny by default.** A message from anyone not approved is **not acted on and not stored**; the sender gets a
  **pairing code** and the command to approve it. Codes: 8 characters without look-alikes, valid 1 hour, at most 3
  waiting per channel, one per sender per 10 minutes, stored hashed (as Hermes and OpenClaw do).
- **Approving**: Settings → Channels (a list of waiting codes with who sent them) or `myrmidon channels approve
  telegram <code>`. The **first person approved is the owner**; later ones are **members**. Revoke any time.
- **Owner vs members**: both chat with the agents; only the owner approves risky steps and runs `/model`-style
  commands. A member's round that needs an approval asks the owner (in the owner's own chat with the bot).
- **Groups** are off unless the owner approves the group; then the bot answers only when **mentioned** (or replied
  to) by an approved person, and ignores everyone else.
- **Untrusted text**: names, handles and group titles go into prompts quoted, length-bounded and marked as not
  instructions. Channel messages carry the sender ("Alice on Telegram") so agents know who is asking.
- Bots are never paired, and a loop guard stops answering a chat that sends more than 20 messages a minute.

## Sessions

- One Myrmidon chat per DM, and per group; it appears in the sidebar with a Telegram mark and a title like
  "Telegram · Alice". The app and the channel show the same chat: either can continue it.
- Rounds use the person's default team and, if set, a default project for the channel.
- A message while a round runs **steers** it (Myrmidon's existing delivery), as OpenClaw does by default.
- Commands: `/new` (a fresh chat), `/stop`, `/status` (what is running), `/help`; Telegram's command menu lists them.

## While it works, and the answer

- **Status line**: when a round starts, one message (`Working…`) that edits itself as the round moves: the phase
  and what each agent is doing ("researcher: reading 3 pages · coder: running tests"), at most once per
  `limits.editMs`. When the round ends it reads `Done · 2m 10s · $0.04` (or why it stopped).
- **The answer** arrives as a **new message** (so the phone notifies): the final reply, Markdown rendered for the
  platform, split at the limit on paragraph or line breaks with code fences kept balanced and `(1/3)` marks.
- **Files the round made** are listed by name with a link to open them in the app (sending files is phase 3).
- **Typing** is shown while a round runs (renewed every 4 s), paused while waiting on the person.

## Approvals and questions in the chat

- A tool call waiting for approval is sent to the owner's chat: what it wants to do (the same summary the app's card
  shows) with **Approve** / **Deny** buttons. A change the app would let you edit (a file or commit) gets the
  buttons plus "Open in Myrmidon to edit". The first answer, from the chat or the app, wins; the message then shows
  the outcome. Unanswered after **30 minutes** → denied.
- `ask_user` questions are sent to the chat that started the round; options become buttons, and otherwise the next
  message from that person is the answer.
- Buttons carry a short random id, checked against who may answer it (the owner for approvals, the asker for
  questions); a press by anyone else is refused.

## Reliability

- **Inbound**: each update is recorded (channel, chat, message id) before it is handled, so redeliveries are dropped
  (kept 7 days); Telegram's polling offset is saved only after that. One lane per chat keeps order.
- **Outbound**: answers go through a ledger (pending → sent / failed), retried 3 times with backoff and once more
  after a restart if still fresh (24 hours).
- **Connection**: long polling (30 s); network errors back off 2 s → 60 s with jitter; Telegram's `retry_after` is
  honoured; a 409 means another program reads this bot, shown in Settings and `myrmidon doctor`.

## Setting it up

- **Settings → Channels → Telegram**: paste the bot token from @BotFather (checked with `getMe`, then shown as
  `@yourbot`), start or stop it, see its status, the codes waiting for approval, and the approved people and groups
  with Revoke. Optional default project.
- **CLI** for servers with no desktop: `myrmidon channels` (status), `myrmidon channels telegram` (token, hidden or
  piped), `myrmidon channels approve telegram <code>`, `myrmidon channels revoke telegram <person>`; `myrmidon doctor`
  checks each channel.
- `docs/channels.md`: creating the bot, privacy mode for groups, approving yourself first.

## Errors and edge cases

- An invalid or revoked token stops the channel with the reason in Settings and doctor; nothing retries forever.
- A message too long for a model's context, or with only an unsupported attachment, gets a short reply saying so.
- If the round's chat was deleted in the app, the next message starts a new one.
- Restarting the server loses no approved person, mapping or unsent answer.

## Testing

- Hub with a fake adapter: pairing (code, expiry, limits, not processed before approval, owner first), groups
  (mention-only, approved senders only), sessions (one chat per DM, `/new`, steer while running), status-line
  throttling, chunking (fences, limits), approvals (owner only, first answer wins, 30-minute denial), dedupe and the
  ledger across a restart.
- Telegram adapter against a local fake Bot API server: polling, offset handling, 409, `retry_after`, rendering,
  buttons.
- A manual run with a real bot, written up in `docs/channels.md`.

## Phases

1. Channel core + Telegram text: adapter interface, access and pairing, sessions and commands, status line and
   answer, chunking, dedupe/offset, Settings → Channels, CLI, doctor.
2. Approvals and questions in the chat (buttons), delivery ledger with retries.
3. Media: photos and files in (as attachments) and out (files the round made), voice notes with transcription;
   schedules that deliver to a channel.
4. More platforms through `ctx.channels.register`: WhatsApp first (the person picks Baileys or the Cloud API then).
