# Running Myrmidon on another machine

Myrmidon can run on a VPS or a home server (a "gateway") while you use it from your Mac, a laptop or a phone. It
works the way Hermes Agent and OpenClaw do: the gateway stays private by default, you reach it over **Tailscale** or
an **SSH tunnel**, and every device you use it from is **paired** once and can be revoked.


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
- Pages agents build open on a **separate preview port**, so their scripts cannot act as the dashboard. Each device
  gets its own preview key, and revoking the device ends its previews too.

## Previews of agent-built pages

Previews need their own address: another port (or host) than the dashboard, never a path under it. Start the
gateway with a fixed `--preview-port` and, unless you only use an SSH tunnel, a `--preview-url` saying where devices
reach that port. Without one, a device sees the page's code with a note instead of the preview.

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
myrmidon serve --port 4318 --preview-port 4320
```

On your Mac (forward both ports, each to the same number):

```bash
ssh -N -L 4318:127.0.0.1:4318 -L 4320:127.0.0.1:4320 you@box
```

Then open the `http://127.0.0.1:4318/#token=…` link the server printed. Through the tunnel the gateway sees a local
request, so its token works and no pairing is needed. Anyone who can reach it this way can already log in to the
server over SSH.

## Option 2: Tailscale Serve (recommended for phones and several devices)

On the server (with Tailscale installed and logged in; find its name with `tailscale status`):

```bash
myrmidon serve --port 4318 --public-url https://box.tail1234.ts.net \
  --preview-port 4320 --preview-url https://box.tail1234.ts.net:8443
```

```bash
tailscale serve --bg 4318
```

```bash
tailscale serve --bg --https=8443 4320
```

Tailscale gives the gateway an HTTPS address only your tailnet can reach and proxies it to `127.0.0.1:4318` (and
port 8443 to the previews on 4320). Then run `myrmidon pair` on the server and open the link on each device. Do not use Tailscale **Funnel** (public internet)
without thinking it through: pairing then stands between the internet and your machine.

## Option 3: listen on the tailnet address

```bash
myrmidon serve --host 100.101.102.103 --port 4318 --public-url http://100.101.102.103:4318 --preview-port 4320
```

Every request then needs a paired device. Previews open at `http://100.101.102.103:4320` without a `--preview-url`. Over plain HTTP the cookie cannot be Secure; prefer option 2's HTTPS.

## Setting up a Linux server

- **Bun**: `curl -fsSL https://bun.sh/install | bash`.
- **Sandbox**: agents' shell commands run in bubblewrap: `sudo apt install bubblewrap`. On Ubuntu 24.04 and later,
  AppArmor blocks the unprivileged user namespaces bubblewrap needs; if Settings shows the sandbox as `none`, see
  Ubuntu's notes on `kernel.apparmor_restrict_unprivileged_userns` or add an AppArmor profile for `bwrap`.
- **Browser tools**: `sudo apt install chromium` (or set `MYR_CHROME` to a Chrome binary); it runs headless.
- **Keep it running** with a systemd user service, e.g. `~/.config/systemd/user/myrmidon.service`:

```ini
[Unit]
Description=Myrmidon gateway
After=network-online.target

[Service]
ExecStart=%h/.bun/bin/bun %h/myrmidon/apps/cli/src/main.ts serve --port 4318 --public-url https://box.tail1234.ts.net --preview-port 4320 --preview-url https://box.tail1234.ts.net:8443
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

## Several gateways in one window

The Myrmidon on your Mac can show your other gateways too (a VPS, a home server), one at a time:

1. On the gateway, run `myrmidon pair` (full access, or `--scope chat` for chats only).
2. On your Mac, open **Settings → Gateways**, paste the link and press **Add a gateway**.
3. Switch at the top of the sidebar: **This Mac** or a gateway, with a green or red dot for whether it answers.

Each window remembers what it shows; chats, files, Settings and the terminal always belong to that gateway, and
nothing mixes between them. Your Mac pairs with the gateway as one more device ("Myrmidon on <your Mac>") and keeps
that access in `<home>/gateways.json`, readable only by you; the page never sees it. Requests and sockets go
through your Mac to the gateway's API only, and a gateway's pages open on your Mac's own preview address, so they
work even when the gateway has no `--preview-url`. Removing a gateway also unpairs your Mac there when it can be
reached. A plugin's own screen from another gateway does not open in this window, since it would run with your
Mac's access; open that gateway's address instead.

If a gateway shown in a window stops answering, the window says why and offers to go back to This Mac.

## Setting it up from the terminal

A VPS usually has no desktop, so everything can be done over SSH. Start the gateway first (the service above, or
`myrmidon serve …` in another session), then:

```bash
myrmidon setup
```

It walks through a way to reach a model, the default model and pairing your first device, then checks everything.
Each step is also its own command:

- `myrmidon login [ID]` signs in with a subscription (ChatGPT, Claude, Copilot, Gemini…). It prints a link to open
  on your laptop or phone. Sign-ins with a device code ("…headless/device") just need the code typed there. The
  others end on a `127.0.0.1` page that does not load on your laptop: copy that page's whole address and paste it
  into the terminal. Or forward the port it names first (`ssh -N -L 1455:127.0.0.1:1455 you@box`) and it finishes by
  itself. The same works from Settings → Models on a paired device.
- `myrmidon key [PROVIDER]` stores an API key, typed without showing it. For scripts, pipe it in so it never lands
  in your shell history: `myrmidon key openai < openai.key`. The key is tried with one of that provider's models.
- `myrmidon model [PROVIDER/MODEL]` shows or sets the default model; it is saved only after it answers.
- `myrmidon doctor` checks the server, models, the default model, the sandbox (by running something in it), the
  browser tools, previews and paired devices, with a fix for each problem. It exits 1 when something needs attention.

Run without a terminal (a script, a pipe), `myrmidon setup` prints these commands instead of waiting for answers.

## When something does not connect

- **"unauthorized" on every request**: the address you opened is not one the gateway answers to. Use exactly the
  `--public-url`, or add the address with `--allow-host name:port`.
- **The pairing page keeps coming back**: the device's cookie was not kept (private browsing, or a different address
  than the one you paired on). Pair again on the address you will use.
- **A page shows its code with a note instead of a preview**: the gateway has no preview address for that device;
  add `--preview-port` and `--preview-url` (or forward the preview port in your tunnel).
- **The preview frame says "unauthorized"**: the preview URL's host is not the one in `--preview-url`, or the device
  was revoked.
- **"this device can use chats only"**: it was paired with chats-only access; pair it again with full access.
