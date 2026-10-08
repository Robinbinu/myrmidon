# Remote gateways: how Hermes Agent and OpenClaw do it, and what it means for Myrmidon

Researched 2026-10-08 from `NousResearch/hermes-agent` (6c62eeb4) and `openclaw/openclaw` (109bd479) and their docs.
Asked for: "a Hermes agent / OpenClaw-like mode where we host our gateway on a remote server and use the client to
access it, like Hermes; local Myrmidon; gateways on N servers".

## What both converge on

- The server binds to **loopback by default**; remote use goes through an **SSH tunnel or Tailscale**.
- **Any non-loopback bind forces auth** or the server refuses to start.
- Clients get **per-device credentials** (OpenClaw: keypair device identity + scoped device tokens; Hermes:
  password/OIDC sessions + single-use WebSocket tickets), never one shared token in URLs.
- **Host/Origin checks are exact-match allowlists** derived from a configured public URL (DNS-rebinding defence);
  forwarded headers are trusted only from listed proxies.
- **One gateway = one trust boundary.** Clients that know several gateways keep one active per workspace view.

## Hermes Agent

- Processes: `hermes serve` (REST + `/api/ws` + `/api/pty` + web dashboard, what the desktop attaches to),
  `hermes gateway` (20+ messaging adapters, optional OpenAI-compatible API on :8642), and the agent loop inside either.
  State in SQLite + `~/.hermes`, secrets in a 0600 `.env`.
- Commands run through terminal backends: local, Docker (capabilities dropped, no-new-privileges, env allowlist),
  SSH, Singularity, Modal, Daytona, Vercel Sandbox (the hibernating ones are its "serverless").
- Auth: binding beyond loopback requires an auth provider (password with scrypt, Nous Portal OAuth, or self-hosted
  OIDC + PKCE). HttpOnly session cookie; WebSockets open with a single-use ticket. API server always needs a key.
- Remote access: Tailscale (tailnet bind or Serve in front of loopback), TLS reverse proxy with `public_url`, or SSH
  (the desktop opens the tunnel, starts the dashboard remotely, adopts its token). OAuth sign-ins on a headless box
  need an `ssh -L` forward or paste-back.
- Multi-gateway desktop: a registry (Local, Remote URL, SSH, Hermes Cloud), tokens in 0600 files in the Electron main
  process (keychain opt-in), lazily opened sockets per gateway, one gateway shown at a time, "update all instances".
- Cross-machine work: the desktop relays, or `hermes peer add/dm/run/status/stop` links gateways directly over the
  peer's API with an idempotency key; NAT makes it one-way, so put the hub on the VPS or use Tailscale.
- Docs: hermes-agent.nousresearch.com/docs (architecture, gateway-internals, web-dashboard, multi-connection-desktop,
  bot-mode, security, secrets, oauth-over-ssh).

## OpenClaw

- One Gateway daemon per host (`127.0.0.1:18789`) owns channels, sessions, auth profiles and state. Operators (CLI,
  macOS app, web Control UI) and nodes (macOS/iOS/Android/headless devices with `role: "node"`) are clients.
- Protocol: WebSocket JSON frames; first frame `connect`; `{type:"req",id,method,params}` → `res`; server `event`s with
  `seq`/`stateVersion`; idempotency keys on side effects; no replay (refresh on gaps); TypeBox schema → JSON Schema →
  Swift models.
- Auth: gateway secret (token/password), Tailscale Serve identity (`tailscale whois`), or trusted proxy; plus a
  keypair device identity that signs a `connect.challenge` nonce; new devices need approval (loopback may
  auto-approve); per-device, per-role tokens with scopes (`operator.read/write/admin/pairing/approvals`); nodes enroll
  with an `oc-pair://` link (endpoint, 10-minute single-use bootstrap token, TLS pin).
- Remote: loopback + Tailscale Serve (preferred, auto-configured; Funnel requires a password), tailnet bind with a
  token, managed SSH tunnels with strict host keys; `ws://` only for loopback/private/`.local`/`.ts.net`, otherwise
  `wss://` with optional certificate pinning; Cloudflare Access via edge auth headers; public Control UI needs
  `allowedOrigins`.
- Previews ("Portals"): each agent dev server gets its own origin (port or random wildcard hostname) and a URL token
  moved into a per-portal HttpOnly cookie. A tunnel to the gateway port alone does not expose previews.
- Multiple gateways: several per host (profiles, ports ≥120 apart); the mac app's Gateways menu (⌘1…9), Keychain
  secrets, TLS pins, one window per gateway; secondary gateways are operator-only.
- Delegation: nodes can host sessions; cloud workers boot a throwaway machine that enrolls as a node over an outbound
  pinned connection; the turn loop and files run there while model calls and provider auth stay on the Gateway, and
  the transcript stays on the Gateway via the worker's replayable event stream.
- Docs: docs.openclaw.ai (architecture, nodes, gateway/protocol, protocol/auth, pairing, operator-scopes, remote,
  tailscale, portals, multiple-gateways, cloud-workers, nodes/session-hosting, security/trust-model).

## Other prior art

- **Goose**: `goosed` on a remote box, `X-Secret-Key` header, TLS on by default with a self-signed certificate whose
  fingerprint the desktop pins (or trusts on first use). The smallest working version of a remote mode.
- **Claude Code Remote Control**: the local session only makes outbound HTTPS calls to a relay; no inbound ports.
- **OpenHands**: app server separate from a remote agent-server sandbox (`SANDBOX_REMOTE_RUNTIME_API_URL` + key).
- **code-server**: password plus SSH forwarding, otherwise Caddy/nginx with Let's Encrypt.

## Myrmidon today (what blocks remote use)

- `authorized()` hard-codes Host to `127.0.0.1:<port>`/`localhost:<port>` and Origin to match
  (`apps/web/src/server.ts`).
- One random token, accepted from a header or `?token=`; the page keeps it from the URL hash in `sessionStorage`.
- The preview server binds `127.0.0.1` on a random port and hands the page a `127.0.0.1` origin.
- `/api/terminal` opens a login shell; the folder picker browses the server's disk.
- The sandbox already has a Linux bubblewrap mode; the browser needs headless Chromium on Linux.

## Options

**(a) Headless Myrmidon on a remote machine, the local app/web UI against it.**
1. Baseline with almost no code: keep loopback and use `ssh -L 4318:127.0.0.1:4318` (Host still reads 127.0.0.1);
   add a fixed preview port so a second `-L` exposes previews. Document it.
2. Real remote mode (`myrmidon serve --host … --public-url …`): refuse non-loopback binds without auth; exact-match
   Host/Origin allowlist from the public URL; trusted proxies; pairing with a short-lived setup code (or QR) that
   issues revocable per-device tokens with scopes (read / write / admin gating the terminal, the vault and settings);
   no `?token=` remotely, single-use WebSocket tickets instead; TLS via Tailscale Serve or Caddy (optionally a
   self-signed certificate with fingerprint pinning); a configurable public preview origin (fixed port or wildcard
   subdomain); headless Chromium; uploads and the folder picker speak for the server's disk; model sign-ins that
   redirect to 127.0.0.1 need device-code, paste-back or an SSH forward; a systemd unit and a stable signing secret.

**(b) One client, N gateways.** A registry in the desktop app (name, URL, kind local/remote/SSH, device token in the
keychain, never in the page); one active gateway per workspace view; gateway-qualified colony ids; HTTP + WebSocket
health checks. In a plain browser each gateway serves its own UI, so switching is navigation.

**(c) Local Myrmidon delegating to remote nodes.**
1. Peer model (Hermes `peer run`): each remote is a full Myrmidon with its own vault; local hands it a task over its
   API (task → run id → event stream → result and files) with an idempotency key and mirrors the remote events into a
   local colony. Simplest; fits specialists.
2. Worker/node model (OpenClaw): local owns the log and the credentials; the remote connects outward, runs tools and
   the workspace, and proxies model calls back. Fits the append-only log, but needs a node role, protocol versioning,
   workspace sync and model-call proxying.

Crossing a machine boundary changes trust: make it an explicit choice, never a silent routing decision.

**Researcher's recommendation:** ship (a) first (loopback + Tailscale/SSH, configurable hosts/origins, device
pairing with scopes, WebSocket tickets, configurable preview origin), then the (b) registry, then (c) as the peer
model; take on the worker model only to centralise credentials and history on one machine.

Not verified: Hermes Cloud internals and the Nous OAuth contract; Claude Code Remote Control and OpenHands come from
summarised docs and articles; whether Tailscale Serve preserves the Host header Myrmidon checks today.
