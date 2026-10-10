# CI

`.github/workflows/ci.yml` proves Myrmidon builds and passes its suite on macOS, Linux and Windows.

## When it runs

- every push to `develop`, and to any `xp-*` branch (the platform branches);
- every pull request to `main` or `develop`;
- by hand (`workflow_dispatch`), for one OS or all, optionally for some test files only.

A newer push to the same branch cancels the run in progress.

## What runs where

One job per OS, `fail-fast` off so each OS reports on its own, 45 minutes at most:

| Runner | Machine |
| --- | --- |
| `macos-latest` | macOS on Apple silicon (arm64) |
| `ubuntu-latest` | Ubuntu 24.04, x64 |
| `windows-latest` | Windows Server, x64 |

Each job runs, in order (later steps run even when an earlier check fails, so one run shows everything):

1. `bun install --frozen-lockfile` with Bun 1.3.14 (the `engines` floor), from a cache of Bun's packages and the
   Electrobun toolchain keyed by `bun.lock`;
2. `bun run desktop:typecheck` (it downloads the paired Hutch toolchain the first time);
3. `bun run typecheck`;
4. `bun run lint` (Biome);
5. on Linux: installs bubblewrap and allows unprivileged user namespaces
   (`kernel.apparmor_restrict_unprivileged_userns=0`), so the command sandbox runs for real instead of being skipped;
6. `bun test --timeout 30000`.

Windows checks out with LF line endings (`core.autocrlf false`), as the repository is written.

The jobs use no secrets. Beyond the installs and that toolchain download, tests reach only loopback servers they start
themselves; browser tests use the Chrome each runner already has.

## Platform-pending tests

macOS is the reference: nothing is skipped there for being macOS. A test that cannot pass on Linux or Windows until
the product changes is marked in the test with one helper from `tests/platform.ts`:

```ts
import { pendingOn } from '../../../tests/platform.ts'

pendingOn('win32', 'worktreesOnWindows')('workers edit their own worktrees…', async () => { … })
```

`pendingOn(os, gap)` skips the test on that OS only and logs the gap's reason once. Every gap is an entry in
`GAPS` in `tests/platform.ts`: when a fix lands, delete the entry and typecheck points at every test to un-mark.
`notOn(os, why)` is the same for tests of another system's own mechanism (a Seatbelt profile, bubblewrap mounts),
which are not gaps. `expectOwnerOnly` checks a private file the way each system keeps one (a mode, or an access list).

### Pending on Linux (Ubuntu 24.04)

| Gap | Tests | What has to change |
| --- | --- | --- |
| `bwrapHiddenFolders` | read-access: *cannot read the home, other chats or keys…*; full-access: *with the sandbox off a chat runs commands…* | bubblewrap hides a folder with an empty, writable tmpfs, so `ls` there and writes into it succeed (into a throwaway layer) where macOS denies them (`sandbox.ts` `bwrapMounts`) |
| `voiceWarmupRace` | server-voice: *a call whose page closes while the engines warm up is never made* | the call that closed during warm-up still greets, so the next call is spoken twice (2 instead of 1) |

### Pending on Windows

| Gap | Tests | What has to change |
| --- | --- | --- |
| `windowsRoundsStall` | chat: 9 (@name, member writing into a round, preset chat, someone else's round ×2, stopped-and-resumed round, allow all file changes, per-tool rules, review cards); full-access: 2 | rounds waiting on cards, crew messages or a resume never reach their state (25 s); cause not isolated, possibly the file-tool refusals |
| `worktreesOnWindows` | worktrees: 5; chat: *team workers in a git project…* | `git add` in a worker's worktree trips over the linked `node_modules` ("paths are ignored") |
| `cuaDriverOnWindows` | computer: 14; server-computer: 1 | no Cua Driver on Windows: its manifest and daemon never answer, so computer tools fail |
| `processTreeTests` | children: 11 | the test reads process trees with `ps` and drives sh/sleep/trap and signals; it needs a Windows port (test-side) |
| `bunWindowsSockets` | channels-irc: 7 | Bun 1.3.14 on Windows crashes (segfault, or exit 127) in the IRC raw-socket tests, ending the whole run |
| `windowsShellPath` | sandbox: *keeps HOME and TMPDIR in the agent scratch* | commands run in Git's `sh.exe` with a PATH lacking Git's `usr\bin`: `mkdir: command not found` |
| `timeoutStopOnWindows` | sandbox: *a full-access command that runs too long is stopped* | `run()` does not return at its timeout on Windows |
| `settingsPosixPaths` | read-access: *a folder listed in Settings opens for every chat…* | Settings' `sandbox.read` accepts only `~`, `~/…` or `/…` |
| `serverJsonAfterKill` | desktop server: *the server the app started stops when the app is killed…* | killing the app leaves `server.json` behind on Windows |
| `terminalForeground` | server-terminal: *several terminals run their own shells…* | terminals do not report their foreground program (ConPTY) |

### Not on Windows (by design)

`notOn('win32', …)`: the Seatbelt profile test (`macProfile`), the bubblewrap mounts test (`bwrapMounts`) and the
POSIX PATH test (`posixPath`; `cross-platform.test.ts` checks Windows' PATH).

### Known flake

chat: *a round stopped after reaching outside Myrmidon tells its agents what was already done when it resumes* failed
once on macOS (`seen[0]` was undefined after the resume) and passed on the next runs; on Windows it stalls every time
(`windowsRoundsStall`).

The existing skips that do not depend on the OS stay as they were: no sandbox (`detectSandbox().kind === 'none'`,
which is Windows today), no Chrome, no Kitten or Pythia model, and the opt-in end-to-end voice and model tests.

## Running one OS by hand

```sh
gh workflow run ci.yml --ref <branch> -f os=windows-latest
gh workflow run ci.yml --ref <branch> -f os=ubuntu-latest -f tests="sandbox read-access"
gh workflow run ci.yml --ref <branch> -f os=windows-latest -f pending=true
gh run watch
```

`os` is `all`, `macos-latest`, `ubuntu-latest` or `windows-latest`; `tests` takes path fragments, as `bun test`
does; `pending` also runs the tests pending on that OS (`MYR_RUN_PENDING=1`, which works locally too), to see
whether a fix closes their gap and how they fail if it does not. Or use **Actions → CI → Run workflow** on GitHub.

## Minutes

The repository is private, so minutes count: a macOS minute costs 10, a Windows minute 2, a Linux minute 1. A full
run takes about 7 minutes on macOS and Linux and about 10 on Windows. Prefer a single-OS manual run while working
on one platform.
