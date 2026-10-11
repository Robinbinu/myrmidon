# CI

`.github/workflows/ci.yml` proves Myrmidon builds and passes its suite on macOS. Myrmidon is built for macOS first:
full Linux and Windows support comes later, tracked in GitHub issues #27 (Linux) and #28 (Windows) with labels
`linux` and `windows`. Their jobs still exist and run by hand.

## When it runs

- every push to `develop`, and to any `xp-*` branch (the platform branches): macOS;
- every pull request to `main` or `develop`: macOS;
- by hand (`workflow_dispatch`), for one OS or all (macOS by default), optionally for some test files only.

A newer push to the same branch cancels the run in progress.

## What runs where

One job per OS run, `fail-fast` off so each OS reports on its own, 45 minutes at most:

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
6. `bun test --timeout 30000`, stopped after 25 minutes (a whole run takes about 12) with a list of what was running,
   so a stuck run says where it is stuck instead of holding the job to its 45.

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
| `devtoolsPortOnLinux` | sandbox: *cannot reach a guarded loopback port…* | bubblewrap cannot filter ports, so sandboxed commands still reach the managed Chrome's DevTools port (every tab and its cookies). A network namespace per command would also cut them off from the dev servers they start and the browser loads, and slirp4netns or pasta (to give it the network back) are missing on most desktops; DevTools over a pipe needs a Bun that does not double-close it |

### Pending on Windows

| Gap | Tests | What has to change |
| --- | --- | --- |
| `cuaDriverOnWindows` | computer: 14; server-computer: 1 | no Cua Driver on Windows: its manifest and daemon never answer, so computer tools fail |
| `bunWindowsSockets` | channels-irc: 7 | Bun's Windows sockets corrupt its heap when a TCP connection ends or drops (a segfault in usockets' socket close, or a later malloc), in Bun 1.3.14 and 1.4.3 alike, ending the run; a Bun bug to report upstream, then a Bun upgrade |
| `ptyTerminalOnWindows` | person-terminal: 1 | the PowerShell answer never comes back through the ConPTY session on the runner |

### Not on Windows (by design)

`notOn('win32', …)`: the Seatbelt profile test (`macProfile`), the bubblewrap mounts test (`bwrapMounts`) and the
POSIX PATH test (`posixPath`; `cross-platform.test.ts` checks Windows' PATH).

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
whether a fix closes their gap and how they fail if it does not; `bun` runs with another Bun version than the
`engines` floor, to see whether a newer one fixes a crash. Or use **Actions → CI → Run workflow** on GitHub.

## Minutes

The repository is private, so minutes count: a macOS minute costs 10, a Windows minute 2, a Linux minute 1. A full
run takes about 7 minutes on macOS and Linux and about 10 on Windows. Prefer a single-OS manual run while working
on one platform.

## The weekly omp bump

`.github/workflows/omp-bump.yml` keeps omp current. Mondays at 06:00 UTC (or by hand, **Actions → omp bump → Run
workflow**) it asks npm for omp's latest release and, when it is newer than the pinned one and not proposed yet:

1. pins every `@oh-my-pi/*` package to it, exactly, and renames the pi-ai patch to match
   (`bun .github/scripts/omp-bump.ts set <version>`; `current` and `changelog <from>` are the script's other
   commands, which work locally too);
2. runs `bun install`, `bun run typecheck` and `bun test` on Linux, each going on when one before it fails;
3. pushes `omp-bump-<version>` and opens a pull request to `develop` with what passed and omp's changelog since the
   pinned version, a draft when something failed. CI then runs the three-OS suite on it.

omp is imported only in `packages/runtime/src/omp/` (`omp-boundary.test.ts` fails on an import anywhere else), and
`omp-contract.test.ts` checks what Myrmidon relies on from each part of omp, so a bump that breaks something shows
there first. The install and tests run without a token in the checkout. A pull request opened with the workflow's
own token starts no CI run; with a repository secret `OMP_BUMP_TOKEN` (a token with contents and pull-requests
write) it does. Linux minutes only: about 10 a week.
