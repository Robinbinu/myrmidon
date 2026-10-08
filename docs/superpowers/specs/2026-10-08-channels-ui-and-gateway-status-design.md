# Channels UI and gateway status — design

Asked 2026-10-08: "add channel logos… the ui looks boring", "the channels ui and usage feels very bad", "like hermes we
should also have a gateway indicator and gateway inspector". Research: Hermes's status-bar "Backend" pill and popover
(`apps/desktop/src/app/shell/gateway-menu-panel.tsx`, `GET /api/status`) and OpenClaw's Control UI (an indicator only
when unhealthy, per-channel health with last in/out, reconnects, last error).

Choices made: **logo gallery + detail sheet**; **detailed access switches** (not presets); channels shown **elsewhere
too** (logo on chats, badge when someone waits, a notification on a new request, activity per channel); the gateway
indicator **only when something is wrong** (OpenClaw), with the detail on a **System** page.

## Server

- **Channel health** (hub, in memory): per channel the connection state (as now), when it last connected, how many
  reconnects since, the last error, when a message last came in and an answer last went out, answers still owed.
- **Channel activity**: the last 100 events per channel — connected, reconnecting (why), a message from someone, an
  answer delivered or failed, a pairing code sent, someone approved, an approval asked and decided. Names only, never
  message text.
- `GET /api/channels` adds `health` per channel; `GET /api/channels/:id/activity` returns its events;
  `GET /api/channels/chats` maps chat ids to the channel each came from (for logos on chats).
- `GET /api/status` (the inspector's data, polled by the page every 10 s and on focus): version, uptime, whether this
  is a remote gateway and its address, models ready, the sandbox, active runs, every set-up channel's health and the
  waiting requests, and an `overall` of `ok` or `degraded` with the reasons (a channel down, no model can answer).

## Client

- **Logos** (`channel-logos.ts`): each app's mark and colour as inline SVG paths taken from Simple Icons (CC0), with a
  generic icon for email, SMS, IRC, webhook and apps it lacks. No new dependency.
- **Settings → Channels**: connected channels first, as logo tiles with a status dot and a waiting-count badge; then
  "Add a channel" — every other app as a logo tile in groups (Messengers, Work chat, Other) with a search box. A tile
  opens a sheet: header (logo, name, status, On switch), tabs **Setup** (the platform's steps and fields, the QR code
  when linking, the project), **People** (waiting requests first with Approve/Dismiss, then approved people and
  groups), **Rules** (today's switches) and **Activity** (the channel's events, newest first, with health above).
- **Elsewhere**: the sidebar shows a chat's channel logo; Settings and the Channels section show how many people are
  waiting; a new request raises a toast with **Approve** (and a desktop notification when those are on).
- **Gateway indicator**: hidden while all is well. When the server stops answering, a chip "Offline · Retry" at the
  bottom of the sidebar (Retry checks again at once); when it answers but something is wrong, a chip naming it
  ("Telegram down", "No model can answer") that opens System.
- **System page** (a view like Compare runs, also reached from the indicator and Settings): this gateway (name, address,
  version, uptime, remote or local), a ping time, models ready, the sandbox, active runs, and each channel's health in
  detail (state, account, last in/out, reconnects, last error, Turn off/on to restart it), then recent activity across
  channels.
