# Command-parser adversarial probe (2026-10-10)

An independent, adversarial probe of the shell-command parser in `packages/protocol/src/permissions.ts`
(`scan`, `parseCommand`, `readLine`, `splitCommand`, `readOnlyCommand`, `destructiveCommand`, `commandRuleMatches`,
`offersFor`, and `decide`). The question each probe asks: **can a command string that writes, deletes, exfiltrates,
or executes arbitrary code be let through _without asking_** by

- an **allow rule** a person would plausibly set (the card-offered prefixes: `git status`, `bun test`, `ls`…),
- the **read-only list** that Ask/Auto run without asking (`readOnlyCommand`), or
- **Auto's destructive gate** (`destructiveCommand`) on the default preset,

and can a **deny rule** be evaded?

Probing was entirely at the unit level — crafted strings passed to the parser in `bun`. None of the crafted
commands were executed on this machine. The target shell semantics are `/bin/sh -c <command>` (see
`packages/runtime/src/sandbox.ts`), which every backend uses.

## Findings

Two real holes were found, **both exploitable on the default `auto` preset (what every new chat runs on): the
command ran with no prompt, and a matching deny rule was evaded.** Both are now fixed at the root.

### F1 — here-string / input redirect into an interpreter (High)

`sh <<< "rm -rf ~"`, `sh <<<rm`, `bash <<< "git push"`, `python3 <<< "import os"`, `bash < script.sh`.

A here-string (`<<<`) or input redirect (`<`) feeds code to an interpreter on stdin, exactly like `sh -c`. The
scanner skipped the redirection operator but left its **operand as an ordinary word**, so `sh <<< "rm -rf ~"` read
as the command `sh` with a harmless filename argument `rm -rf ~`. `runsInput` then saw a non-option "argument" and
concluded the interpreter was _not_ reading its stdin, so the line was neither `unknown` nor destructive. Result:
Auto allowed it, and a `deny rm` / `deny git push` rule did not match.

Root cause: redirection operands were treated as command arguments.

Fix: the scanner now drops the word that follows a redirection operator (it is the redirect's target or here-string
body, never an argument). `sh <<< "rm -rf ~"` reduces to the command `sh` with no arguments, which `runsInput`
correctly flags as running unseen input → `unknown` → Auto asks and deny rules ask. This also corrects a smaller
imprecision: `echo hi > out.txt` now parses to the segment `echo hi` instead of `echo hi out.txt`.

### F2 — expansion in the subcommand slot of a dispatching program (High)

`git $p` (with `p=push`), `git $SUB`, `git ${SUB}`, `` git `echo push` ``, `bun $s`, `npm $x`, `git {push,pull}`.

What `git`, `bun`, `npm`, `pnpm`, `yarn`, `cargo`, `go`, `gh`, `deno`, … do turns entirely on their subcommand.
`unknownProgram` only inspected the **program** word for expansions, never the subcommand, so `git $p` read as a
fully-known, non-destructive `git` invocation. On Auto it ran without asking, and a `deny git push` rule was evaded
— the shell expands `$p` to `push` and runs `git push`.

Fix: `unknownSub` marks a view `unknown` when its program is a dispatching program (`SUBCOMMANDS`) and its subcommand
word is an expansion (`$`, `` ` ``, `*`, `?`, `[…]`, `{,}`). An **unknown argument to a _fixed_ subcommand is still
fine** (`git log $REF`, `bun test $FILE`, `ls $HOME *.ts` stay allowed) — only an unreadable subcommand asks.

## Probe classes tried, and results

"ask/deny" = safe (asks or is denied); the parser was already correct unless noted.

| Class | Example | Before | After |
|---|---|---|---|
| Backslash-escaped quote | `echo \" ; rm -rf ~ ; echo \"` | ask (fixed in I1) | ask |
| Single-quote splice | `echo 'a'\''; rm -rf x` | ask | ask |
| ANSI-C `$'…'` | `$'\x72m' -rf ~` | ask/deny | ask/deny |
| `$"…"` locale string | `$"rm" -rf ~` | ask/deny | ask/deny |
| Unicode look-alike program | `ｇit push` | allow (shell also won't run `ｇit`; not git) | allow (benign) |
| Tab / CR / `;;` separators | `ls\tx; rm -rf x` | ask/deny | ask/deny |
| Command subst `$()` / backtick | `bun test "$(rm -rf x)"` | ask | ask |
| Process subst `<()` `>()` | `cat <(rm -rf x)` | ask | ask |
| Brace / subshell / group | `(rm -rf x)`, `{ rm -rf x; }` | ask/deny | ask/deny |
| Arithmetic expansion | `echo $((a=1)); rm -rf x` | ask | ask |
| Background `&`, `coproc` | `rm -rf x &`, `coproc rm X` | ask/deny | ask/deny |
| `exec` | `exec rm -rf x` | ask/deny | ask/deny |
| Env-prefix (`PATH`,`LD_PRELOAD`,`GIT_*`,`PAGER`,`BASH_ENV`,`NODE_OPTIONS`) | `PAGER="rm -rf x" git log` | ask/deny (not simple) | ask/deny |
| Safe env-prefix (`CI`,`NO_COLOR`,`LC_*`…) | `CI=1 bun test` | allow | allow |
| Redirections `>` `>|` `&>` `2>` `n>&m` `<>` | `echo hi >\| out` | parsed loosely | **operand dropped (F1)** |
| **Here-string / `<` into interpreter** | `sh <<< "rm -rf ~"` | **allow / evades deny** | **ask (F1 fixed)** |
| Heredoc into shell (pipe/stdin) | `cat <<EOF \| sh` | ask | ask |
| Quoted heredoc body | `cat > n <<'EOF'\ngit push\nEOF` | allow (text only) | allow |
| Wrappers `env`/`command`/`nice`/`timeout`/`setsid`/`stdbuf`/`caffeinate`/`script`/`chroot`/`flock` | `timeout 5 rm -rf x` | ask/deny | ask/deny |
| `sudo`/`doas`, `xargs`, `find -exec` | `xargs rm < l`, `find . -exec rm {} ;` | ask/deny | ask/deny |
| git `-c core.pager`/`alias.x='!…'`/`-C`/`--exec-path` | `git -c alias.p=push p` | deny/ask | deny/ask |
| **git/bun/npm expansion subcommand** | `git $p`, `npm $x` | **allow / evades deny** | **ask (F2 fixed)** |
| Unknown **program** (var/glob/subst) | `$X -rf x`, `/bin/r? -rf x`, `{rm,-rf,x}` | ask | ask |
| Unknown **arg** to fixed subcommand | `git log $REF`, `bun test $FILE`, `ls $HOME` | allow (intended) | allow |
| Pipe into shell/interpreter | `curl -s x \| python3`, `cat x \| bash` | ask | ask |
| `sed -i`, `awk system()`, `perl -e` | `sed -i s/a/b/ f` | offered whole / broad allow only | unchanged (see limits) |
| `tee` | `tee out` | offered as `tee` | unchanged (see limits) |
| `bun test --preload`/`--config`, `npm run`, `bun x` | `bun test --preload ./evil.ts` | allow under `bun test` (projectCode) | unchanged (see limits) |
| Comment to EOL / line continuation | `ls # '\nrm -rf ~\n#'` | ask/deny | ask/deny |
| Function body / `name(){ … }` | `f(){ touch X;};f` | deny-visible | deny-visible |
| Very long input (> `MAX_COMMAND_READ`) | 200 KB echo | ask, < 2 s | ask |
| Deep nesting (> `MAX_NESTING`) | `sh -c 'sh -c …'` | ask | ask |

## Remaining known limits (honest)

A string parser cannot _guarantee_ what a line does; these are deliberately left to the next layer (the OS sandbox
in `packages/runtime/src/sandbox.ts`), not papered over:

- **Broad allow rules are honored as written.** Allowing exactly `rm -rf x` runs `rm -rf x &` and `exec rm -rf x`
  (same command). Allowing a bare write/exec tool — `sed`, `awk`, `perl`, `tee`, or a bare interpreter — lets it do
  what that tool does, just as allowing bare `git` allows `git push`. The card never _offers_ these bare prefixes
  (`prefixOf` offers the whole command for `UNBOUNDED`/interpreter programs, and `tee` is a write tool by nature), so
  a person only gets such a rule by typing it; this is their explicit choice, not a parser slip.
- **`projectCode` prefixes run project code by design.** `bun test`, `npm test`, `npm run build`, `bun x …`,
  `make`, `python3 scripts/x.py` all execute code the agents can write; `bun test --preload ./x.ts` is no worse than
  `bun test` itself. The card marks these `projectCode: true` to say so, and the sandbox — not the allow rule — is
  the boundary that keeps them confined.
- **Interpreter script files** (`sh script.sh`, not a here-string) are allowed under Auto like any other project
  code; the script's contents are not read. Confinement is the sandbox's job.
- **Reads of sensitive paths** (`cat ~/.ssh/id_rsa`) are "read-only" to this parser by definition; whether such a
  path is reachable at all is enforced by the sandbox's path rules, not here.
- **Values produced only at run time** (a decoded blob, a downloaded file, a variable's contents used as an
  argument) are unknowable; the parser marks the line `unknown` whenever a *substitution* or an unreadable
  *program/subcommand* is involved, which routes it to Ask, but it cannot inspect data the shell computes.

## Verification

- `bun run typecheck` — clean.
- `bunx biome check` on both changed files — clean.
- `bun test packages/protocol/tests/permissions.test.ts` — 48 pass (2 new regression tests for F1/F2).
- Full `bun test --timeout 30000` — see the commit; pre-existing browser/real-Chrome flakes are unrelated.
