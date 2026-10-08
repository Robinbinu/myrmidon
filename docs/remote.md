# Running Myrmidon on another machine

Myrmidon can run on a VPS or a home server (a "gateway") while you use it from your Mac, a laptop or a phone. It
works the way Hermes Agent and OpenClaw do: the gateway stays private by default, you reach it over **Tailscale** or
an **SSH tunnel**, and every device you use it from is **paired** once and can be revoked.

> Not yet: previews of agent-built pages from a remote gateway, and switching between several gateways in one window.
> Both are coming (see `docs/superpowers/specs/2026-10-08-remote-gateways-design.md`).

## How it stays safe

- `myrmidon serve` listens on `127.0.0.1` unless you say otherwise. A non-loopback `--host`, or a `--public-url`,
  makes it a **remote gateway**: every device must be paired, and `--dev` (no sign-in) is refused.
- The server answers only to its own names: `127.0.0.1`/`localhost` on its port, the address it is bound to, the
  `--public-url`'s host, and any `--allow-host`. Pages from other sites cannot use it (this stops DNS rebinding).
- A paired device holds its own token in an HttpOnly cookie (`__Host-` prefixed and Secure over HTTPS), which the
  page itself can never read. Only a hash is stored on the gateway (`<home>/devices.json`, readable only by you).
- The token `myrmidon serve` prints works only on the machine itself (an SSH tunnel counts as that machine).
- Devices are **full access** or **chats only** (chats, files and approvals; not the terminal, keys, Settings,
  plugins, MCP, hooks, folders or devices).
- Pairings, wrong codes, revocations and rejected devices are written to `<home>/logs/device-auth.log` (no tokens or
  codes).

## Pairing a device

On the gateway:

```bash
myrmidon pair
```

It prints a link like `https://box.tail1234.ts.net/#pair=K7QX3MNPRT`, valid for 10 minutes and usable once
(`--scope chat` for chats-only access). Open it on the device, check its name, and press **Pair**. You can also make a
link from **Settings → Devices** on a device that already has full access; that page lists every device, when it was
last seen, and lets you **Revoke** it, which locks it out at once.

## Option 1: an SSH tunnel (nothing to install)

On the server:

```bash
myrmidon serve --port 4318
```

On your Mac:

```bash
ssh -N -L 4318:127.0.0.1:4318 you@box
```

Then open the `http://127.0.0.1:4318/#token=…` link the server printed. Through the tunnel the gateway sees a local
request, so its token works and no pairing is needed. Anyone who can reach it this way can already log in to the
server over SSH.

## Option 2: Tailscale Serve (recommended for phones and several devices)

On the server (with Tailscale installed and logged in; find its name with `tailscale status`):

```bash
myrmidon serve --port 4318 --public-url https://box.tail1234.ts.net
```

```bash
tailscale serve --bg 4318
```

Tailscale gives the gateway an HTTPS address only your tailnet can reach and proxies it to `127.0.0.1:4318`. Then run
`myrmidon pair` on the server and open the link on each device. Do not use Tailscale **Funnel** (public internet)
without thinking it through: pairing then stands between the internet and your machine.

## Option 3: listen on the tailnet address

```bash
myrmidon serve --host 100.101.102.103 --port 4318 --public-url http://100.101.102.103:4318
```

Every request then needs a paired device. Over plain HTTP the cookie cannot be Secure; prefer option 2's HTTPS.

## Setting up a Linux server

- **Bun**: `curl -fsSL https://bun.sh/install | bash`.
- **Sandbox**: agents' shell commands run in bubblewrap: `sudo apt install bubblewrap`. On Ubuntu 24.04 and later,
  AppArmor blocks the unprivileged user namespaces bubblewrap needs; if Settings shows the sandbox as `none`, see
  Ubuntu's notes on `kernel.apparmor_restrict_unprivileged_userns` or add an AppArmor profile for `bwrap`.
- **Browser tools**: `sudo apt install chromium` (or set `MYR_CHROME` to a Chrome binary); it runs headless.
- **Model sign-ins** that send you back to `127.0.0.1` (OAuth) finish on the machine that opened them: run them over
  the SSH tunnel (option 1), or add API keys instead.
- **Keep it running** with a systemd user service, e.g. `~/.config/systemd/user/myrmidon.service`:

```ini
[Unit]
Description=Myrmidon gateway
After=network-online.target

[Service]
ExecStart=%h/.bun/bin/bun %h/myrmidon/apps/cli/src/main.ts serve --port 4318 --public-url https://box.tail1234.ts.net
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now myrmidon
```

```bash
loginctl enable-linger $USER
```

## When something does not connect

- **"unauthorized" on every request**: the address you opened is not one the gateway answers to. Use exactly the
  `--public-url`, or add the address with `--allow-host name:port`.
- **The pairing page keeps coming back**: the device's cookie was not kept (private browsing, or a different address
  than the one you paired on). Pair again on the address you will use.
- **"this device can use chats only"**: it was paired with chats-only access; pair it again with full access.
