# gstack's features, and what Myrmidon takes from them

Research and build notes, 2026-10-15 (built 2026-10-16), branch `gstack-skills`. Companion to
`2026-10-15-mirofish-gstack-company-mode.md` (company mode: roles, playbooks, saved companies; **not** built here).

Source: [github.com/garrytan/gstack](https://github.com/garrytan/gstack) at `47d639ab` (VERSION 1.91.101.0), MIT. Every
mechanism below was read in that checkout (path given relative to its root); quotes are under 15 words. Myrmidon
references are to this branch. "Gap" is what Myrmidon lacks after this branch.

## 1. What gstack is, in one paragraph

58 skill folders (`*/SKILL.md.tmpl`, rendered to `SKILL.md` by `scripts/gen-skill-docs.ts`), each a slash command that
makes one Claude Code session play a role in a sprint: plan reviews, review, QA, ship, deploy, retro. The substance is
checklists with exact thresholds, stop rules ("STOP", 3-strike, blast-radius questions), fixed report shapes, a shared
confidence rubric (1-10 with display rules, `scripts/resolvers/confidence.ts`), a shared completion status
(DONE / DONE_WITH_CONCERNS / BLOCKED, `scripts/resolvers/preamble/generate-completion-status.ts`), and ~60 helper
scripts in `bin/` that make gates mechanical (review logs bound to a tree fingerprint, version-slot allocation, evidence
ledger). It publishes no with/without-gstack quality measurement.

## 2. Inventory

Browser: whether it needs a browser (Aside first; gstack's own `/browse` Chromium daemon as fallback).

| /skill | What it does | What makes it good (mechanism, file) | Browser | Myrmidon nearest (file:line) | Gap |
|---|---|---|---|---|---|
| /office-hours | YC-style product interrogation that ends in a design doc | Hard gate: no code, only a design doc; six forcing questions routed by stage; one question at a time (`office-hours/SKILL.md.tmpl`, `sections/phase-2a-*`) | no | `/plan` plan mode (`apps/web/src/client/chat/commands.ts:50`), `ask_user` | no product-interrogation playbook; company-mode territory |
| /plan-ceo-review | Founder-mode plan review in 4 scope modes | >15 planned files → recommend reduction; nine prime directives; premise challenge (`plan-ceo-review/SKILL.md.tmpl:71-80,389-410`) | no | plan mode + judge (`packages/runtime/src/prompts.ts:972`) | no plan reviewer role (company mode) |
| /plan-eng-review | Eng-manager review: architecture, data flow, tests | Complexity gate at 8+ files or 2+ new services; decision ledger; STOP until answered (`plan-eng-review/sections/review-sections.md.tmpl:331-335`) | no | plan mode | same (company mode) |
| /plan-design-review | Rates design dimensions 0-10, fixes the plan | Rate → what a 10 looks like → fix → re-rate; <7 triggers a mockup | no | none | no design reviewer |
| /plan-devex-review | DX plan review: personas, TTHW benchmarks | STOP gates 0A-0G; each pass scored with the evidence gap | no | none | none |
| /autoplan | Runs CEO → design → DX → eng reviews, auto-deciding | Mechanical / Taste / User Challenge classes ("NEVER auto-decide" the last); eng always last (`autoplan/SKILL.md.tmpl:78-95`) | no | plan mode, `check_in` | decision classes; company mode playbooks |
| /spec | Vague intent → executable spec → issue | Hard gate on the first message; outside reviewer scores executability ≥7/10 (`spec/sections/gate-and-file.md.tmpl`) | no | `/goal`, plan mode | spec scoring |
| /review | Pre-landing diff review, fix-first | Two passes (critical, informational) with sideways sweep and forced-critical classes (`review/checklist.md`); quote-the-line gate and confidence display rules (`scripts/resolvers/confidence.ts:19-52`); Review Army specialists by diff size (`scripts/resolvers/review-army.ts:57-86`); gate-integrity tags RH-1..16 (`review/gate-integrity.md`); ≤3 fix cycles | no | **built: `review` skill (`packages/runtime/src/prompts.ts:1260`), `/review`**; before: judge, `request_review` (`packages/runtime/src/tools.ts:2370`) | no tree-bound review log; specialists only as an optional crewmate |
| /codex, /claude-code | Second opinion from another model's CLI | Review gate fails closed (non-zero, empty, any P0/P1 = FAIL); tools stripped; 10-min/32 MiB caps (`codex/sections/review-mode.md.tmpl:157-175`) | no | separate `judgeModel`, advisor (`prompts.ts:1052`) | no "outside voice" step in review |
| /deslop-shared-libs | Finds shared-code extractions | ≥2 verified first-party callers; savings = removed − added; ≤3 recommendations (`scripts/resolvers/shared-libs.ts:8-30`) | no | none | none |
| /test-audit | Finds tests that cost more than they protect | NO_ASSERTION / SOURCE_GREP / NEAR_DUPLICATE pre-filter; red-proof bar (`test-audit/SKILL.md.tmpl:72-89`) | no | none | none |
| /investigate | Root-cause debugging | Iron law (no fix before root cause); scope lock via freeze; 3-strike stop; >5 files asks; debug report (`investigate/SKILL.md.tmpl`) | no | **built: `investigate` skill (`prompts.ts:1455`), `/investigate`**; before: `debug` tool | the scope lock is advisory (no freeze hook) |
| /qa | Test → fix → verify with atomic commits | Charters before probes; contract map; health score weights (`scripts/resolvers/utility.ts:280-320`); STOP after 2 reverts; regression test before fix | partial | **built: `qa` skill (`prompts.ts:1390`), `/qa`** (functional surfaces) | browser QA and health score left to browser-v2 |
| /qa-only | Report-only QA | Never edits product code or tests; unavailable service ≠ defect (`qa-only/SKILL.md.tmpl`) | partial | same `qa` skill, report-only by default | — |
| /design-review | Visual QA that fixes design issues | Risk meter: STOP above 20%, cap 30 fixes; slop score A-F (`design-review/SKILL.md.tmpl:258-276`) | yes | browser tools | browser-v2 |
| /design-consultation | Builds a DESIGN.md design system | Banned/overused font lists; product brief before Phase 3 | partial | none | none |
| /design-shotgun | Several design variants on a board | Variants must not be "siblings"; taste memory (`design-shotgun/SKILL.md.tmpl`) | partial | `generate_image` | none |
| /design-html | Mockup → production HTML | Screenshots at 375/768/1440; Edit not Write | partial | browser tools | browser-v2 |
| /devex-review | Live DX audit (time to hello world) | TESTED vs INFERRED on every score; boomerang vs plan score | yes | none | none |
| /cso | Security audit, evidence first | Trusted launcher; budgets; independent challenger per finding (`cso/SKILL.md.tmpl`) | no | `security_scan` (`tools.ts:3702`) | no audit workflow |
| /ship | Merge base, test, review, bump, changelog, verify, push, PR | Iron law of fresh evidence (`gstack-evidence`, ZERO-RUN = fail); version classify/drift; CHANGELOG cross-checked against the commit list (`ship/sections/changelog.md`); bisectable commits; idempotent push/PR (`ship/SKILL.md.tmpl`) | no | **built: `ship` skill (`prompts.ts:1324`), `/ship`**; before: `github` tool (`tools.ts:2734`) | no evidence ledger or version-slot queue |
| /land-and-deploy | Merge, wait for CI and deploy, canary, revert | `gstack-ci-gate --expect-head`; never bypass CI (`land-and-deploy/SKILL.md.tmpl:157-183`) | partial | `github` tool | no deploy workflow |
| /canary | Post-deploy watch | 60 s loop; alert only on 2+ consecutive checks | yes | `schedules.ts:90` | browser-v2 / later |
| /benchmark | Web performance baseline and regressions | >50% or >500 ms = regression; relative thresholds | yes | none | browser-v2 |
| /setup-deploy | Detects the deploy platform | writes a Deploy section to CLAUDE.md | no | none | none |
| /landing-report | Version slots across workspaces | read-only `gstack-next-version` | no | none | none |
| /document-release | Docs audit against the diff on every ship | Diataxis coverage map; Edit, never Write, CHANGELOG | no | `ship` skill step 6 (docs) | lighter |
| /document-generate | Missing docs, Diataxis | reference first; 100% public-surface check | no | none | none |
| /retro | Weekly retro from git | `gstack-retro-metrics`; 45-min sessions; fix ratio >50% flag; midnight-aligned windows (`retro/SKILL.md.tmpl`) | no | **built: `retro` skill (`prompts.ts:1516`), `/retro`** | no saved history (writes nothing to the repo) |
| /health | Code-quality dashboard | weighted score, empty run never 10/10 (`health/SKILL.md.tmpl:175-194`) | no | `run_checks` (`tools.ts:3538`) | no dashboard |
| /learn | Manage project learnings | STALE/CONFLICT prune; latest wins | no | `/learn` + skill learning (`skill-learning.ts:35`), memory (`memory.ts:206`) | memory-v2 territory |
| /context-save, /context-restore | Checkpoint and reload session state | hard gate: capture only; append-only files | no | compaction, `/resume`, checkpoints (`checkpoints.ts:25`) | — |
| /careful | Warn/ask before destructive commands | PreToolUse hook; deny `rm -r /`, force-push to default; ask on DROP TABLE, TRUNCATE, kubectl delete, docker prune; obfuscation tripwire (`careful/bin/check-careful.sh`) | no | Auto preset asks on `DESTRUCTIVE_COMMANDS` (`packages/protocol/src/permissions.ts:1155`) | missing DB/k8s/docker patterns and the obfuscation tripwire |
| /freeze, /unfreeze | Block edits outside one folder | fails closed; symlink-resolved prefix match (`freeze/bin/check-freeze.sh`) | no | permission rules, read-only preset | no one-command edit lock |
| /guard | careful + freeze | both hooks | no | — | — |
| /browse | Browser for the agent | persistent daemon, `@e` refs (see §6) | yes | browser tools (`tools.ts:3191`) | browser-v2 |
| /scrape, /skillify | Read-only page data; codify into a browser skill | refuses mutating intents; built in temp dir, renamed after its test passes | yes | `browser_extract`, `create_tool` | browser-v2 |
| /setup-browser-cookies, /open-gstack-browser, /connect-chrome, /pair-agent | Session cookies, headed browser, sharing the browser | cookie values never logged; single-use 5-min setup key | yes | `request_login`, person browser, live share | browser-v2 |
| /make-pdf, /diagram | Markdown → PDF/HTML/DOCX; English → diagram triplet | exit-code contract; never a "dead pixel dump" | partial | none | none |
| /eval-plan, /benchmark-models | Preregistered paid eval; cross-model benchmark | spends nothing before the pilot; budget never split | no | `apps/eval` | solo-quality territory |
| /plan-tune | Tune how often it asks | per-question never/always-ask | no | `check_in`, approvals | none |
| /gstack-upgrade | Upgrade itself | Bun floor check; never deletes a stale backup silently | no | `updates.ts` | — |
| /setup-gbrain, /sync-gbrain | gbrain memory engine | per-repo trust policy; `doctor` must pass | no | memory | memory-v2 |
| /ios-qa, /ios-fix, /ios-design-review, /ios-clean, /ios-sync | Live-device iOS QA and fixes | loopback-only state server; token tiers; "no fix without a reproducing snapshot" | no (device) | computer use | none |

Power tools worth noting (`bin/`): `gstack-review-log` (review start/finish bound to a tree fingerprint),
`gstack-specialist-stats` (drop a specialist after 0 findings in 10+ runs, never security), `gstack-diff-scope` (scope
flags from the diff), `gstack-evidence` (fresh-evidence ledger), `gstack-version-bump` / `gstack-next-version`,
`gstack-retro-metrics`, `gstack-redact` (secret scan before push).

## 3. What to adopt, ranked

Ranked by value to a Myrmidon person per unit of work, and by fit (no overlap with company-mode, browser-v2, memory-v2,
solo-quality).

1. **Review with severity-ranked findings and a verdict** (`/review`). The most-used workflow; Myrmidon had a judge that
   scores answers, not a reviewer of a diff. **Built.**
2. **Ship pipeline** (`/ship`): tests, review, version and CHANGELOG by the project's convention, bisectable commits,
   fresh verification, push/PR only when asked. **Built.**
3. **Investigate** (iron law, 3-strike rule, blast radius, debug report). Cheap, high value, model-agnostic. **Built.**
4. **Functional QA** (charters before probes, contract map, evidence per probe; report-only by default). **Built**
   (non-browser surfaces; pages use whatever browser tools the agent has).
5. **Retro** from git, read-only. **Built.**
6. Fixed report shapes + shared confidence rubric + DONE/DONE_WITH_CONCERNS/BLOCKED. **Built into the five skills**;
   could later become a typed outcome (company-mode / SOTA R1).
7. Tree-fingerprinted review records gating ship (gstack's Review Readiness Dashboard). Not built: needs a review event
   with a tree hash; belongs with company-mode's `fresh-reviews` gate.
8. Extra destructive patterns from `/careful` (DROP TABLE/DATABASE, TRUNCATE, kubectl delete, docker rm -f / system
   prune, terraform destroy) and the obfuscation tripwire (`${IFS}`, base64 piped to sh). Not built: it changes what the
   Auto preset asks for every person; a separate, small decision for `permissions.ts:1155`.
9. A one-command edit lock (`/freeze`): a chat-scoped deny rule for edits outside a folder. Not built: needs a permission
   rule kind and a Settings registry entry; `/investigate` states its scope lock in words meanwhile.
10. Outside voice (a second model family reviewing the diff) and scope-gated specialists with hit-rate gating: plausible,
    unmeasured; the `review` skill asks a crewmate for a fresh-context pass at 300+ changed lines when it can.
11. Plan reviews (CEO/eng/design/DX), office hours, autoplan: company-mode's roles and playbooks.
12. Docs release audit, health dashboard, test audit, cso: later candidates as skills of the same kind.

## 4. What was built

Mechanism (there were no built-in skills before; slash commands were app code or a plugin's prompt):

- **Built-in skills**: text in `prompts.builtinSkills` (`packages/runtime/src/prompts.ts:1259`), written at server start
  to `<home>/builtin-skills/<name>/SKILL.md` with `source: builtin` (`writeBuiltinSkills`,
  `packages/runtime/src/skills.ts:140`; folder name `BUILTIN_SKILLS_DIR` and the numbers they quote, `WORKFLOW_SKILLS`, in
  `packages/runtime/src/config.ts`). The library reads that folder last, as source `builtin`, so a person's own skill of
  the same name wins; they show in Settings → Skills as "built in" and switch off like any skill. Files are rewritten only
  when their text changes, and only folders Myrmidon wrote are removed.
- **Slash commands** in a new "Workflows" group (`apps/web/src/client/chat/commands.ts:47`): `/review [target]`,
  `/ship [notes]`, `/qa [target]`, `/investigate <symptom>`, `/retro [24h|7d|14d|30d|compare]`. Each sends a message
  ("Use the review skill on …", text in `copy.ts`), the agent loads the skill with `use_skill`. A plugin command of the
  same name replaces the workflow (the person installed it). One icon each in `FEATURE_ICONS` (ScanEye, PackageCheck,
  FlaskConical, Microscope, CalendarRange; none used before).
- Credit: `NOTICE`, `THIRD_PARTY_NOTICES.md` (gstack MIT).

What was deliberately left out of gstack's versions: its state root and helper scripts, Greptile, the queue of version
slots, auto-bootstrapping a test framework, "boil the ocean" completeness, writing retro history into the repo, and
pushing without the person asking (Myrmidon's Auto preset asks before `git push` / `gh pr create` anyway).

## 5. Real runs (DeepSeek only)

Throwaway repo: `main` with `total()`; branch `add-coupons` adding `applyCoupon()` with an inverted expiry check, its
test committed as `test.skip`, and no CHANGELOG/version change although `AGENTS.md` asks for both. Temp Myrmidon home,
own port, lead `ark/deepseek-v4-pro-260425`, reviewer `ark/deepseek-v4-flash-ga-260731`. Replies recorded in
`packages/runtime/tests/fixtures/workflow-runs/`.

- `/review` (19 tool calls; `skill/used` review): **Verdict BLOCK**; P0 inverted expiry at `src/coupons.js:12` (the line
  is 13: one off), P1 skipped test as an unjustified gate change, P2 missing CHANGELOG/version, P3 `code.toUpperCase()`
  on null; ran the tests. A first run, before the wording fix, rated the skip "Gate changes: none"; the skill now says a
  test added already skipped counts.
- `/ship` (round 1: tests, loaded the review skill, then **stopped to ask** about the skipped test, as the gate rule
  says; round 2 after "yes, fix it, don't push"): fixed `>` → `<`, unskipped the test, bumped 0.3.0 → 0.4.0, wrote the
  CHANGELOG entry, two commits staged by path, **Status READY**, not pushed (no remote). Checked in the repo afterwards:
  4 tests pass. Its report said "3 tests"; there are 4.
- Both replies put one sentence before the report despite "nothing before or after it".

## 6. Notes for the browser-v2 agent

From gstack's `/browse` daemon (`ARCHITECTURE.md:27-177`, `browse/src/`), worth weighing; nothing here was built:

- One persistent Bun HTTP daemon in front of Chromium: ~3 s first call, ~100-200 ms after; tabs, cookies and storage
  persist between commands; idle shutdown after 30 min (`browse/src/server.ts:133`).
- State file (pid, port, token, binary version) written tmp+rename, mode 0600; dead pid → respawn; live but silent →
  "busy" after ~8 s, never killed without `--force-restart`; daemon restarts itself when the binary version changes
  (`browse/src/cli.ts:935`).
- Random port in 10000-49151 with 5 retries, outside the macOS ephemeral range, so parallel workspaces never collide
  (`browse/src/port-allocator.ts`).
- `@e1…` refs from the accessibility tree backed by `getByRole().nth()` locators (no DOM mutation, CSP-safe); refs
  cleared on navigation; a ~5 ms `count()` check fails a stale ref fast instead of a 30 s timeout
  (`browse/src/tab-session.ts:97`); `-C` adds cursor-pointer elements, `-D` diffs against the previous snapshot.
- Console/network/dialog ring buffers (O(1) push), flushed to disk asynchronously each second
  (`browse/src/buffers.ts`).
- `chain`: a JSON array of commands in one call, stopping at the first error; errors rewritten into the next action
  ("Run snapshot -i") (`browse/src/commands.ts`, `server.ts:932`).
- Aside facts gstack relies on: exit code 0 even on a throw, so success is a sentinel line; console errors hooked via CDP
  before navigation (`scripts/resolvers/aside.ts:20-37`).
- QA pieces left for a browser QA pass: the health score weights (`scripts/resolvers/utility.ts:280-320`), screenshots
  per finding, and design-review's risk meter.

## 7. Not verified

- The skills on other model families than DeepSeek V4 Pro; QA, investigate and retro had no real run (tests only).
- The `/review` and `/ship` commands typed in the app's composer (the real runs sent the exact message the command sends,
  through the server's chat API).
- `apps/desktop/tests/sidecar.test.ts` fails in this worktree with a SyntaxError in the compiled binary, also with
  develop's `prompts.ts`; on a fresh checkout of develop with this branch's source files copied in, it passes (4/4).
  The cause is something in this worktree's environment, not found.
