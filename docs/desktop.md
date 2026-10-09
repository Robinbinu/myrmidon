# Desktop app (macOS)

`apps/desktop` wraps the Myrmidon dashboard in a native macOS window with [Electrobun](https://github.com/blackboardsh/electrobun)
2.0.2 (pinned exactly in `apps/desktop/package.json`). The main process runs on Bun (`build.mainProcess: "bun"`), the
page is the same web client a browser gets, and macOS's own WebKit (WKWebView) renders it. Design background:
`superpowers/specs/2026-10-07-native-ui-design.md`.

What the app adds to the web client:

- **Its own server, or yours.** On launch it reads `<home>/server.json` the way `myrmidon ask` does (home is
  `$MYRMIDON_HOME`, else `~/.myrmidon`). If a server for that home answers, the window opens on it and leaves it
  running on quit. Otherwise the app starts `myrmidon serve` on a free loopback port, shows "Starting Myrmidon…" until
  it answers, and on quit sends it SIGTERM (it stops running chats first) and waits up to 10 s before killing it.
- **Native chrome.** A hidden-inset title bar with the traffic lights centered in the client's 52 px toolbar row.
  Before the page renders, the app sets `data-shell="desktop"` and `--titlebar-inset: 78px` on `<html>`; the toolbars
  are already drag regions (`app-region: drag`).
- **App menu.** Myrmidon (About, Settings… ⌘,, Hide, Quit), File (New Chat ⌘N, Close), Edit (the standard roles, so
  ⌘C/⌘V work in text fields), View (Command Menu ⌘K, Toggle Sidebar ⌘B, Reload ⌘R, Developer Tools ⌥⌘I, Full
  Screen), Window. A menu item sends its shortcut into the page as a `myrmidon:shortcut` event, which runs the same
  handler as the key (`useHotkeys`), so the menu and the keyboard can never disagree. ⌘K currently does what the client
  binds to it (a new chat); the menu follows when the client's command menu changes.
- **A small bridge**, `window.myrmidonDesktop` (`apps/web/src/client/ui/desktop.ts`), used only when present:
  - **Add a project folder** opens the native folder dialog instead of the server-side folder browser (not while the
    window shows another gateway, whose folders are on another machine);
  - **Show in Finder** next to the data folder on the System page;
  - **Notifications** ("Notify me when a run finishes" in Settings) are native ones, posted when the window is not
    focused;
  - **The Dock badge** shows how many chats need you (the same count as the window title).

External links (`target=_blank`, `window.open`) open in the default browser.

## Run it in development

```sh
bun install
bun run desktop
```

The first run downloads Electrobun's toolchain (Hutch, its runtimes and a Bun toolchain: about 200 MB in
`~/.hutch`) and writes the generated SDK to `apps/desktop/.hutch/` (git-ignored). The development build runs the server from this checkout
(`bun apps/cli/src/main.ts serve`, from the repository root so `bunfig.toml` builds the dashboard's CSS). If you
already run `bun run dev`, the window opens on that server instead. To try it against a scratch home:
`MYRMIDON_HOME=/tmp/myr-scratch bun run desktop`. Ctrl-C in the terminal quits the app (and the server it started).

Type-check the main process (it imports Electrobun's SDK from the generated devkit, so it is not part of
`bun run typecheck`): `bun run desktop:typecheck`. The pure parts (`apps/desktop/src`) are type-checked and tested
with the rest of the repository.

## Build a release

```sh
bun run desktop:build        # = bun run desktop:sidecar, then electrobun build --env=stable
```

`desktop:sidecar` compiles the server with `bun build --compile` (Tailwind plugin included) into
`apps/desktop/dist/myrmidon` (about 120 MB), with oh-my-pi's native addon (`pi_natives.<platform>-<arch>.node`) beside
it. The build hook (`apps/desktop/scripts/bundle-hook.ts`) copies both into the app's `Resources/app/sidecar` and sets
the microphone usage text. Output: `apps/desktop/artifacts/` (`macos-arm64-Myrmidon.dmg`, the update archive and
`stable-macos-arm64-update.json`). `--env=canary` builds a canary channel that installs beside the stable app.

What was checked on 2026-10-09: the sidecar starts, serves the dashboard with its CSS and answers the API; the built app
extracts itself, starts the sidecar and stops it on quit. Not checked yet: voice calls from the sidecar (the speech
engines use a worker file, a bundled WAV and the sherpa-onnx native addon, which `bun build --compile` may not carry),
and the app started from Finder rather than a terminal (see the PATH risk below).

### Signing and notarization

Hutch signs, notarizes and staples canary and stable builds (never dev builds). In `electrobun.config.ts` set
`build.mac.codesign: true` and `build.mac.notarize: true`, then export:

```sh
export ELECTROBUN_DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
# App Store Connect API key (preferred)…
export ELECTROBUN_APPLEAPIKEYPATH=~/private_keys/AuthKey_XXXX.p8 ELECTROBUN_APPLEAPIKEY=XXXX ELECTROBUN_APPLEAPIISSUER=…
# …or an Apple ID with an app-specific password
export ELECTROBUN_APPLEID=you@example.com ELECTROBUN_APPLEIDPASS=xxxx-xxxx-xxxx-xxxx ELECTROBUN_TEAMID=TEAMID
```

`ELECTROBUN_SKIP_NOTARIZATION=1` signs without submitting to Apple. The config already asks for the
`com.apple.security.device.audio-input` entitlement (the hardened runtime blocks the microphone without it). Unsigned
builds downloaded from the internet are stopped by Gatekeeper; for internal testing, `xattr -cr Myrmidon.app`.

The sidecar is a Bun-compiled executable that JIT-compiles; Hutch signs nested executables, but whether it then runs
under the hardened runtime with Electrobun's default JIT entitlements has not been tried. Test a signed build before
shipping it.

## Known risks with WebKit

The app uses the system WKWebView, not Chromium. Things that behave differently from Chrome:

- **Microphone in WKWebView.** Voice calls need `getUserMedia`. Electrobun answers WebKit's permission request with
  its own Allow/Block alert (remembered per origin, `http://127.0.0.1`), and macOS asks once more for the app itself.
  That needs `NSMicrophoneUsageDescription` in `Info.plist`, which the build hook sets in every build. In a dev build
  started from a terminal, macOS may attribute the request to the terminal app instead.
- **AudioWorklet from a blob URL.** The call client loads its capture worklet with
  `audioWorklet.addModule(URL.createObjectURL(blob))` (`apps/web/src/client/voice/call-client.ts`). Whether WKWebView
  accepts a blob-URL worklet module has not been tried; if a call fails to start in the app, this is the first suspect
  (serving the worklet as a file from the server avoids the question).
- **Notifications** from the page go through the bridge, not the Web Notification API, and cannot reopen a chat when
  clicked yet (Electrobun's `showNotification` has no click event).
- **The folder dialog blocks the main process** while it is open (Electrobun waits for it), so menu items and Ctrl-C
  wait until it is closed.

If WebKit gets in the way, Electrobun can bundle Chromium (CEF) instead: set `build.mac.bundleCEF: true` and
`defaultRenderer: "cef"` in `electrobun.config.ts` (or `renderer: "cef"` on the `BrowserWindow`). The app grows
considerably, since Chromium ships inside it. The bridge only uses Electrobun's preload and `executeJavascript`, so it
should carry over, but the CEF build has not been tried.

## Other known gaps

- **App icon**: `apps/desktop/assets/icon.svg` (the web favicon on Apple's 824/1024 icon grid) is rendered into
  `assets/icon.iconset` by `bun scripts/icons.ts` (run from `apps/desktop`; needs Chrome); commit the result.
- **PATH from Finder**: an app opened from Finder gets the system's minimal PATH, so agents' shell commands may not
  find tools installed with Homebrew, bun or uv. Started from a terminal it inherits your shell's PATH.
- **A crash leaves the server running.** The next launch finds it through `server.json` and uses it (but then does not
  stop it on quit).
- macOS only for now; Electrobun's Windows and Linux builds are untried.
