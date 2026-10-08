# Remote gateways — design

Approved scope (2026-10-08): **remote server mode** and **switching between N gateways**; reached over **Tailscale or
SSH by default** (public HTTPS opt-in). Handing work between gateways and OpenClaw-style worker nodes are later.
Research: `docs/research/2026-10-08-remote-gateways.md`.

## Goals

- Run Myrmidon on a VPS or home server ("a gateway") and use it from this Mac as if it were local.
- Keep a list of gateways (this Mac, a VPS, a home server) and switch between them, one at a time.
- Nothing about the local, single-machine default gets weaker.

## Part A: remote server mode

**Binding.** `myrmidon serve` keeps binding `127.0.0.1` by default. `--host <addr>` (or `0.0.0.0`) binds elsewhere;
`--public-url <url>` names the address clients use (e.g. `https://box.tail1234.ts.net`). A non-loopback bind or a
public URL turns on **device auth**, and the server refuses to start with `--dev` (no auth) in that case.

**Allowed addresses.** The Host check becomes an exact-match allowlist: `127.0.0.1:<port>`, `localhost:<port>`, the
public URL's host, and any `--allow-host`. Origin must be one of the same origins (http for loopback, the public URL's
scheme otherwise). No wildcards: this is the DNS-rebinding defence. `X-Forwarded-*` is ignored (Tailscale Serve and
SSH need none); trusted proxies can come later with public HTTPS.

**Devices and pairing.**
- `<home>/devices.json` lists paired devices: id, name, scope, a SHA-256 hash of the device token (never the token),
  created and last-seen times.
- Pairing: `myrmidon pair [--scope full|chat]` on the server prints a link `<public-url>/#pair=<code>`; a signed-in
  device can also make one in Settings → Devices. The code is 10 characters, single use, valid 10 minutes, kept only
  in memory.
- Opening the link, the page asks for a device name and calls `POST /api/pair { code, name }`. The server answers
  with an **HttpOnly, SameSite=Strict cookie** holding the device token (Secure over HTTPS), so the token is never
  readable by the page and WebSockets carry it without `?token=`. A gateway hub (part B) pairs the same way and gets
  the token in the response body instead, to keep server-side.
- Scopes: `full` (everything) and `chat` (chats, files, approvals; not the terminal, Settings writes, providers and
  keys, plugins, MCP or hooks).
- Settings → Devices lists devices (name, scope, last seen, this one marked) with **Revoke**; revoking takes effect
  on the next request and closes that device's sockets.
- The loopback bearer token (the CLI's `#token=` link) keeps working on loopback only. Remotely, `?token=` is not
  accepted.

**Previews.** Agent-built pages keep their own origin. `--preview-port <n>` fixes the preview port and
`--preview-url <url>` names it for clients (`/api/config` hands that out instead of `127.0.0.1`). Without a
preview URL on a remote gateway, previews open through the hub (part B) or show a hint to set one.

**Headless Linux.** The Linux sandbox (bubblewrap) and headless Chromium already exist; `docs/remote.md` covers
installing them, a systemd unit, Tailscale Serve (`tailscale serve --bg 4318`, plus the preview port) and an SSH
tunnel (`ssh -L 4318:127.0.0.1:4318 -L 4320:127.0.0.1:4320 box`). Folder pickers and uploads already act on the
server's disk; the UI labels the gateway they belong to.

## Part B: N gateways from one client

**Where tokens live.** The local Myrmidon is the hub. `<home>/gateways.json` (mode 0600) lists remote gateways: id,
name, URL, device token, scope, added time. The page never sees a remote token.

**Adding one.** Settings → Gateways → Add: the person pastes the pairing link made on the remote (or its URL and
code). The hub calls the remote's `/api/pair` with `hub: true` and stores the token it gets. Remove forgets it (and
revokes it on the remote when reachable).

**Switching.** A gateway switcher at the top of the sidebar ("This Mac" and each remote, with a dot for reachable /
unreachable). The active gateway is per window (remembered locally). With a remote active, every API call and
WebSocket goes to `/gw/<id>/…` on the hub, which forwards it to the remote with that gateway's token (HTTP via fetch,
WebSockets bridged frame for frame), and previews through `/gw/<id>/preview/…` on the hub's preview origin. The page
code changes only in one place: the base path its API and socket helpers use.

**One at a time.** Chats, Settings, files, the terminal: all belong to the active gateway, and the window says which
("on box"). Nothing mixes gateways; a chat id is only meaningful on its gateway.

**Health.** Each remote is checked over HTTP and over a WebSocket (many failures are WebSocket-only), shown in the
switcher and in Settings → Gateways with the error when it fails.

## Errors and edge cases

- A revoked or unknown device gets 401; the page shows "this device is no longer paired" with how to pair again.
- A remote that is unreachable keeps its place in the switcher, greyed, with the reason; switching to it shows that.
- Pairing codes: wrong code → 401 after a short delay; after 10 wrong tries the pairing window closes.
- A hub never forwards to a gateway URL that is not in its list (no open proxy).

## Testing

- Server: Host/Origin allowlist (accepted, rejected, rebinding), `--dev` refused when remote, pairing (code once,
  expiry, cookie flags, scopes enforced, revoke closes access), `?token=` refused remotely.
- Hub: add (pair) a second in-process gateway, proxy an API call and a WebSocket stream through `/gw/<id>`, refuse
  unknown ids, show unreachable.
- A manual run over an SSH tunnel and over Tailscale Serve, written up in `docs/remote.md`.

## Phases

1. Part A without previews: allowlist, binding rules, devices, pairing, scopes, Settings → Devices, docs.
2. Previews for remote gateways (fixed port + preview URL).
3. Part B: gateways registry, pairing from the hub, proxy for HTTP and WebSockets, switcher, health.
