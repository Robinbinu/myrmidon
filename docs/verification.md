# Verification

How a change to Myrmidon is shown to work, and to break nothing, before it reaches the macOS app. Six tiers, from
the one every change runs in seconds to the ones that spend minutes or money. Each has an exact command, a pass
mark, and what to do when it fails.

**Done means verified.** A TODO item or a change is done when a test asserts it or it was tried in the macOS app,
and the item or the commit says which. Code inspection or a successful build alone is not evidence (TODO.md's
header has the rule).

| Tier | What | Command | Where it runs | Blocks a release |
| --- | --- | --- | --- | --- |
| 1 | Unit and deterministic regression tests | `bun run test` (`bun run test:changed` while working) | every change; CI on every push and PR | yes |
| 2 | Integration groups: runtime, server, UI, permissions, lifecycle | `bun run test:integration`, or `bun run test:group <name>` | inside tier 1; on its own while working on one area | yes (as part of tier 1) |
| 3 | macOS desktop build and packaged-app smoke test | `bun run smoke:desktop` | CI on pushes to develop and main, and PRs to main; by hand before a release | yes |
| 4 | Model evaluations with real models | `bun run eval …` / the **Model eval** workflow | opt-in only: by hand, or weekly when enabled | no (advisory) |
| 5 | Performance budgets | `bun run test:perf` | inside tier 1 (budgets enforced); on its own for timings | yes (as part of tier 1) |
| 6 | Security regressions: permission and sandbox boundaries | `bun run test:security` | inside tier 1; on its own after touching permissions, the sandbox or file tools | yes (as part of tier 1) |

Plus, before every merge: `bun run typecheck`, `bun run lint` (Biome) and `bun run desktop:typecheck`, which CI runs
beside the suite.

## Tier 1 — unit and deterministic regression tests

```sh
bun run test:changed            # while working: only the test files your git changes affect
bun run test:changed develop    # the same against a branch
bun run test                    # before a merge: the whole suite, in parallel (about 2 minutes)
bun run test:serial             # one process, for a failure that only shows there
```

`bun run test` is `bun test --parallel --timeout 30000` through `scripts/test.ts`, which stops a run still going after
`TEST_WALL_S` (600 s by default) as stuck, workers included. Every file runs in its own process (AGENTS.md). CI runs
the suite in one process (`bun test --timeout 30000`, stopped after 25 minutes) so its log reads in order
(docs/ci.md).

Deterministic means no network beyond loopback servers a test starts itself, no real model (runs use
`createMockModel` from `packages/runtime/src/omp/mock.ts`), and no wall-clock luck: a test waits on an event or a
condition, never on a sleep it hopes is long enough. A bug fix comes with the test that would have caught it.

**Pass mark:** 0 failures. Skips are the platform-pending and opt-in tests listed in docs/ci.md.

**One full parallel run per machine at a time.** Each `bun run test` starts a worker per core; two or three at once
(several agents or worktrees on one Mac) push the load far past the core count and tests time out that pass alone.
While others run, use `bun run test:changed` or named files, and for the one full run cap the workers:
`bun test --parallel=2 --timeout 60000`. A timeout seen only under that load is noise; rerun the file alone before
treating it as a failure. The same goes for tier 3, which builds the whole app: run it once, at the end.

**A stuck parallel run** (a worker at ~100% CPU that never reports): `sample <worker pid> 5` shows where it spins.
A loop in `kevent64` means a leaked pipe or handle, e.g. a test that kills a child but keeps its stdout reader open,
so the event loop wakes on the pipe forever. Release the reader and cancel the stream in the test. `bun run test`
stops such a run after `TEST_WALL_S`; a bare `bun test --parallel` does not.

**When it fails:** read the failing test's output; rerun just that file (`bun test <path>`), then the whole run. A
failure only in the parallel run usually means a file leaning on another file's state (AGENTS.md). Never weaken,
skip or delete a test to get green; if the test is wrong, say why in the commit. Known local exception: the PTY
terminal test (`packages/runtime/tests/person-terminal.test.ts`) can fail on a Mac whose zsh prompt (oh-my-zsh)
answers differently from the runner's; it passes in CI.

## Tier 2 — integration groups

Groups are named in `tests/groups.ts`; `tests/groups.test.ts` fails on an entry that names no file, so a renamed test
cannot fall out of its group. A file can be in several groups and is always in the whole suite.

| Group | Covers | Command |
| --- | --- | --- |
| `runtime` | chats, colonies, crews, tools, workers, cells, hooks, end to end with scripted models | `bun run test:group runtime` |
| `server` | the dashboard's HTTP server and the CLI over real loopback requests | `bun run test:group server` |
| `ui` | client components rendered in a DOM, clicked and typed into (`apps/web/tests/*.test.tsx`) | `bun run test:group ui` |
| `permissions` | presets, rules, approvals, full access, read access, who may use what | `bun run test:group permissions` |
| `lifecycle` | leashes, children, the server lock, ports, terminals, the desktop app starting and stopping its server | `bun run test:group lifecycle` |
| all five | | `bun run test:integration` |

`--list` prints a group's files instead of running them (`bun run test:group security --list`); other arguments go to
`bun test` (`bun run test:group runtime -t 'resume'`). Add a new test file to the groups it exercises.

**Pass mark and failures:** as tier 1; they are part of it.

## Tier 3 — macOS desktop build and packaged-app smoke test

```sh
bun run smoke:desktop                 # builds the release, then checks it (about 1 minute on an M-series Mac)
bun run smoke:desktop --skip-build    # checks apps/desktop/artifacts from an earlier build
bun run smoke:desktop --keep          # leaves the temporary folder (app, home, logs) for a look
```

`scripts/smoke-desktop.ts` builds `bun run desktop:build`, unpacks
`apps/desktop/artifacts/stable-macos-arm64-Myrmidon.app.tar.zst` into a temporary folder, and launches
`Myrmidon.app/Contents/MacOS/launcher` with `HOME` set to an empty folder and every `MYRMIDON_*` variable removed, so
no server, settings or login of the machine's can stand in for the app's own. It checks, each a line in its output:

1. the archive unpacks, and the app carries `Resources/app/bun/leash.ts` and the compiled server;
2. `codesign --verify --deep --strict` on the app inside the DMG (mounted read-only), and on the unpacked app;
3. the app starts its own server: `<home>/.myrmidon/server.json` appears with the app's launch ID, the API answers
   with its token, `<home>/.myrmidon/logs/desktop-server.log` exists and the dashboard page is served;
4. a full-access command runs through the app's compiled leash (`<sidecar> leash --grace=200 /bin/sh -c …`, the
   path `sandbox.ts` takes for a full-access command), from outside the repository;
5. quitting the app (SIGTERM to the launcher) stops its server and removes `server.json`.

It then kills anything left, detaches the DMG and removes the folder. It opens the app's window for a few seconds.

This is the class of failure beta.1 to beta.3 shipped: a bundle whose signature covered none of its resources
("damaged" on other Macs), an app that could not start its server because `leash.ts` was not beside its code, and
full-access commands failing on `Module not found /$bunfs/root/leash.ts`. None showed on the build machine, where a dev
server was always running for the app to join.

**Pass mark:** every blocking check `ok`; exit 0. One check is advisory by default: the unpacked update archive's
strict signature check, which fails today because Electrobun rewrites `Resources/version.json` after the build hook
signs the app (TODO.md, "Found by the verification tiers"). `--strict-archive` makes it blocking; make that the
default once it is fixed. The app inside the DMG, which Gatekeeper judges, is blocking.

**When it fails:** the failing line carries the reason; a server that did not start prints the end of
`desktop-server.log` and of the launcher's output. Rerun with `--skip-build --keep` and look in the kept folder. Before
a release also launch the DMG's app from the Finder on a Mac that never ran Myrmidon (docs/desktop.md): the smoke
test starts from a terminal, so it does not see the Finder's minimal PATH.

**CI:** the `macOS app smoke test` job in `.github/workflows/ci.yml`, after the suite passes, on pushes to develop
and main and on pull requests to main (by hand: **Run workflow** with `smoke` ticked). It uses no secrets: the app is
signed ad hoc and not notarized.

## Tier 4 — model evaluations (opt-in, costs money)

The eval harness (`apps/eval`, `bun run eval`) runs the standard cases against a running server with real models and
writes a report (`evals/results/<time>.json`, git-ignored). It is never part of `bun test` or of CI on a push or PR.

By hand, against a scratch server (never your own home):

```sh
bun run myr serve --home /tmp/myr-eval --port 4391 &
MYR_TOKEN=$(jq -r .token /tmp/myr-eval/server.json) bun run eval --base http://127.0.0.1:4391 \
  --model anthropic/<model> --trials 3 --out evals/results/<name>.json
bun run eval --compare before.json after.json
```

In CI: `.github/workflows/model-eval.yml`, **Actions → Model eval → Run workflow**. It runs only when

- a manual run ticks `spend` (and picks the provider whose key is a repository secret of the same name, e.g.
  `ANTHROPIC_API_KEY`, the model, judge, cases, modes and trials), or
- the weekly schedule (Mondays 07:00 UTC) fires and the repository variable `MODEL_EVAL_SCHEDULE` is `on` (with
  `MODEL_EVAL_PROVIDER`, `MODEL_EVAL_MODEL`, `MODEL_EVAL_JUDGE` as variables);

and it stops before starting a server when the key's secret is missing. The artifact `model-eval-<run id>` keeps the
report (it names model and judge), a `.run.json` beside it with commit, ref, provider, model, judge, cases, modes,
trials and runner, and the server's log, for 90 days. Nothing is spent by default: with no ticked `spend` and no
`MODEL_EVAL_SCHEDULE=on`, the job is skipped.

**Pass mark:** advisory; it does not block a release. The harness exits 1 on a hard failure (a run on the wrong tier,
a budget breach), which turns the run red to be looked at. Comparing a candidate with a baseline and the thresholds
for that are phase 2 of Task 12 (TODO.md).

## Tier 5 — performance budgets

```sh
bun run test:perf     # the perf group in one process, each timing printed beside its budget
```

Budgets live in `tests/perf-budgets.ts`, each several times what the work takes on an M-series Mac, so a budget
fails on a change in how the work grows (a fold turned quadratic, a read without its index), not on a busy machine:

| Budget | Work | Measured 2026-10-15 | Budget |
| --- | --- | --- | --- |
| `foldLongHistory` | fold a 20,000-event colony log into its state (the client's first render) | 12 ms | 250 ms |
| `streamOntoLongHistory` | 200 streamed batches of 10 events, the whole log refolded each time (`use-colony.ts`) | 0.4 s | 5 s |
| `appendLongHistory` | append 20,000 events to one SQLite log in batches of 50 | 0.5–4.1 s | 20 s |
| `readLongHistory` | read that log back whole, then its last page | 0.04–0.4 s | 3 s |
| `concurrentAppends` | 20 colonies appending 500 events each at once | 0.4–1.8 s | 12 s |
| `longSession` | read and compact a 2,000-turn agent transcript | 0.03–0.1 s | 1.5 s |

The perf files (`*/tests/perf-*.test.ts`) also run in tier 1 with the same budgets. The colony-UI stress test on
branch `fix-colony-perf` (`apps/web/tests/colony-clock.test.tsx`) joins the group when that branch lands; this tier
does not duplicate it.

**When one fails:** run `bun run test:perf` alone to see the time against the budget. A real slowdown is fixed, not
budgeted: find what grew (profile with `bun --cpu-prof`). Raise a budget only for new work the path must do, with the
reason in the commit.

## Tier 6 — security regressions

```sh
bun run test:security
```

The `security` group gathers the boundary tests that live with their features (`packages/protocol/tests/permissions`,
`packages/runtime/tests/{full-access,read-access,role-access,sandbox,projects,rule-files,secrets,provider-secrets,
security-scan,skill-scan,channels}`, `apps/web/tests/{server-auth,server-chat-permissions,server-full-access,
server-project-file,server-chat-share,share-seal}`) and `packages/runtime/tests/security-boundaries.test.ts`, which pins
what those did not: climbing out of the project with `..`, a sibling folder whose name starts like the project, links
in the project or scratch pointing outside, deny and ask rules still holding under the Full preset, a command a deny
rule cannot read asking instead of running, channel members asking for everything, a read-only project no chat lifts,
and a round never having full access when a member started it or the project is read-only.

A known gap is pinned as `test.failing` (it passes while the gap is open and fails the day it closes, so the marker
comes off with the fix): a dangling symlink lets a file tool write outside the project or scratch (TODO.md).

**Pass mark:** 0 failures, as tier 1. **When one fails:** treat it as a security bug, not a flaky test: find the
change that opened the boundary, and fix that.

## What blocks a release

Blocking, all on the release commit: tier 1 green in CI (which includes tiers 2, 5 and 6), typecheck and lint, the
tier 3 smoke test green in CI and once by hand on the release build, and the Finder launch on a clean Mac
(docs/desktop.md). Advisory: tier 4 results, the update archive's strict signature (until fixed), and the
Linux/Windows jobs (docs/ci.md).

## Reports

- **Major changes** (a new tier result, a release candidate, a perf or eval comparison worth keeping): a dated report
  in `docs/reports/<yyyy-mm-dd>-<topic>.md` with the commands run, their output (counts, timings, failures) and the
  commit. Quote real output; mark what was not run.
- **Eval runs:** `evals/results/` locally (git-ignored); the workflow's artifact in CI.
- **Smoke tests:** the job's log in CI; locally the script's output, and `--keep` for the folder.
