# Desktop app

`apps/desktop` wraps the Myrmidon dashboard in a native window with [Electrobun](https://github.com/blackboardsh/electrobun)
2.0.2 (pinned exactly in `apps/desktop/package.json`). The main process runs on Bun (`build.mainProcess: "bun"`), the
page is the same web client a browser gets, and the system's web view renders it (WebKit on macOS, WebKitGTK on
Linux, WebView2 on Windows). Design background: `superpowers/specs/2026-10-07-native-ui-design.md`.

**Platforms.** The app is written for macOS, Linux and Windows, but so far it has been built and run on macOS
(arm64) only. See [Platforms](#platforms) for what differs and what has and has not been tried on each.

What the app adds to the web client:

- **Its own server, or yours.** On launch it reads `<home>/server.json` the way `myrmidon ask` does (home is
  `$MYRMIDON_HOME`, else `~/.myrmidon`). If a server for that home answers, the window opens on it and leaves it
  running on quit. Otherwise the app starts `myrmidon serve` on a free loopback port, shows "Starting Myrmidon…" until
  it answers, and on quit asks it to stop (`POST /api/shutdown` with the token from its `server.json`, which works the
  same on every platform; it stops running chats first), falling back to SIGTERM where there are signals, and after
  10 s ends it and everything it started. The app tells its own server's `server.json` from another one's by a
  launch ID it passes in `MYRMIDON_LAUNCH_ID`, which `serve` writes back as `launch`.
- **Native chrome.** On macOS a hidden-inset title bar with the traffic lights centered in the client's 52 px toolbar
  row; before the page renders, the app sets `data-shell="desktop"` and `--titlebar-inset: 78px` on `<html>` (the
  toolbars are already drag regions, `app-region: drag`). On Linux and Windows the window keeps the system's title
  bar and the inset is 0.
- **App menu.** Myrmidon (About, Settings… ⌘,, Hide, Quit; Hide, Hide Others, Show All and Window → Bring All to
  Front are macOS-only and left out elsewhere), File (New Chat ⌘N, Close), Edit (the standard roles, so
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
  - **The Dock badge** shows how many chats need you (the same count as the window title); macOS only, as it goes
    through the Objective-C runtime, which is loaded on the first badge and never on Linux or Windows.

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
`apps/desktop/dist/<platform>-<arch>/myrmidon` (`myrmidon.exe` on Windows; about 125 MB) from
`apps/desktop/src/sidecar.ts`, which is the CLI and, started as `myrmidon kitten-worker <model folder>`, Kitten TTS's
worker (a compiled build has no script file to run it from). Beside it goes the native code it loads from there:
oh-my-pi's addon (`pi_natives.<platform>-<arch>*.node`) and onnxruntime's (`onnxruntime_binding.node` and the library
it links to: `libonnxruntime.1.dylib`, `libonnxruntime.so.1`, or `onnxruntime.dll` with the DirectML DLLs; the speech
detector, the turn model and Kitten use it; the build rewrites onnxruntime-node to load them beside the executable,
since the compiled build would unpack its addon to a temporary folder without the library it links to).

The agents' browser engine, chrome-devtools-mcp (pinned in `packages/runtime/package.json`), runs on Bun: the
sidecar build copies the package's `build/` folder to `chrome-devtools-mcp/` beside the executable, and the server
runs its entry script on its own runtime (a compiled Myrmidon acts as the bun CLI with `BUN_BE_BUN=1`).
`packages/runtime/src/cdm.ts` looks there first, then at `MYR_CDM`, then at the package in `node_modules` (development).
No Node is needed or shipped.

It builds for the host by default; `bun run desktop:sidecar --target=bun-linux-x64` cross-compiles for another
platform (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`,
`bun-windows-arm64`). That needs the target's oh-my-pi addon, an optional dependency installed only for the host:
`bun install --os='*' --cpu='*'` installs all of them. onnxruntime-node 1.30 ships no `darwin-x64` addon, so Intel
Macs cannot be built for. Cross-compiling has not been tried yet.

The build hook (`apps/desktop/scripts/bundle-hook.ts`) copies the build for Electrobun's OS and architecture into the
app's `Resources/app/sidecar` (and on macOS sets the microphone usage text). Where `Resources` is:

| Platform | App | Sidecar |
| --- | --- | --- |
| macOS | `Myrmidon.app` | `Myrmidon.app/Contents/Resources/app/sidecar/myrmidon` |
| Linux | `Myrmidon/` (`bin/launcher` beside `Resources/`) | `Myrmidon/Resources/app/sidecar/myrmidon` |
| Windows | `Myrmidon\` (`bin\` beside `Resources\`) | `Myrmidon\Resources\app\sidecar\myrmidon.exe` |

Output: `apps/desktop/artifacts/` (on macOS `macos-arm64-Myrmidon.dmg`, the update archive and
`stable-macos-arm64-update.json`). `--env=canary` builds a canary channel that installs beside the stable app.
`apps/desktop/tests/sidecar.test.ts` builds the sidecar and runs its Kitten worker from outside the repository.

What was checked on 2026-10-09: the sidecar starts, serves the dashboard with its CSS and answers the API; the built app
extracts itself, starts the sidecar and stops it on quit. The sidecar alone (`MYRMIDON_HOME=<scratch>
apps/desktop/dist/myrmidon serve --dev`, from outside the repository) with voice on loads the speech detector and the
turn model, warms Phonon-2 with its bundled clip, and speaks with Kitten (Settings → Voice → Try it). Not checked yet:
a whole voice call through the built app, and the app started from Finder rather than a terminal (see the PATH risk
below).

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
  `assets/icon.iconset` (macOS; its 1024 px PNG is the Linux icon) and packed into `assets/icon.ico` (Windows: 16,
  32, 48, 64, 128 and 256 px as PNGs) by `bun scripts/icons.ts` (run from `apps/desktop`; macOS only, needs Chrome and
  `sips`; `--ico` repacks only the .ico); commit the result, so other platforms never need the script.
- **PATH from Finder**: an app opened from Finder gets the system's minimal PATH, so agents' shell commands may not
  find tools installed with Homebrew, bun or uv. Started from a terminal it inherits your shell's PATH.
- **A crash leaves the server running.** The next launch finds it through `server.json` and uses it (but then does not
  stop it on quit).

## Platforms

What differs is decided in `apps/desktop/src/platform.ts` as pure functions of the platform, tested on any machine
(`apps/desktop/tests/platform.test.ts`, and the server start/stop tests run each platform's stop path).

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Title bar | hidden inset, traffic lights in the toolbar | the system's | the system's |
| Menu | all roles | without Hide/Hide Others/Show All/Bring All to Front | same as Linux |
| Dock badge | yes | no | no |
| Stopping the server | `POST /api/shutdown`, then SIGTERM, then the leash | same | `POST /api/shutdown`, then the leash (a kill there would end only the leash) |
| Icon | `assets/icon.iconset` (.icns) | the iconset's 1024 px PNG | `assets/icon.ico` |
| Electrobun builds | arm64 | x64, arm64 | x64 only (Electrobun builds no arm64 Windows app) |

What has been tried, as of 2026-10-10:

- **macOS arm64:** built with `bun run desktop:build`, sidecar in the archive, launched against a scratch home, the
  window loaded the dashboard, and quitting stopped the server and removed its `server.json`.
- **Linux (x64, arm64) and Windows (x64):** not built or run yet. The platform logic above is unit-tested on macOS
  with the platform passed in; the desktop tests (including the sidecar build) are meant to run on Linux and Windows
  in CI. Whether Electrobun's Linux and Windows bundles have the layout in the table above, and whether the build
  hook runs there with the same environment, is read from Electrobun's SDK, not seen in a build.
- **macOS x64 and Windows arm64:** not supported: onnxruntime-node ships no Intel Mac addon, Electrobun's npm
  bootstrap has no Intel Mac toolchain, and Electrobun builds Windows apps for x64 only (they would run under
  emulation on arm64).
- Known gaps beyond the shell on Linux and Windows: the process leash and Windows' command sandbox are separate work
  (see TODO.md), computer use drives a Mac only, and the microphone prompt in WebKitGTK and WebView2 is untried.
