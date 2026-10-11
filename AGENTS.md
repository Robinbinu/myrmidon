# Agent instructions

## Settings: one registry, enforced by tests

Every setting in Settings has an entry in `apps/web/src/client/settings/registry.ts` (id, page, section path,
label, hint, keywords, the control it shows, and the keys of the settings file it changes). The page renders the
row from that entry (`SettingField`, or `settingRow` / `settingItem` on a row laid out by hand), so Settings search
reads exactly what the screen shows.

- **Add or move a setting** by adding or changing its registry entry, and render its row with that id. Rows made
  from live lists (providers, models, MCP servers, plugins, channels…) go in `DYNAMIC` with the function that
  names each item.
- **A new key in `packages/runtime/src/settings.ts`** needs an entry that claims it in `keys`, or a line in
  `NOT_SHOWN` saying why no row shows it.
- **Renaming a page** keeps old `?settings=` addresses working through `SECTION_ALIASES` in `settings/pages.ts`.

The tests enforce it: `apps/web/tests/settings-registry.test.tsx` renders every page and fails on a control with
no registry row, a row whose control or label differs from its entry, a live row search cannot find, and an entry
no page shows; `apps/web/tests/settings-search.test.ts` fails on a settings-file key no entry claims.

## Tests: parallel by default

- `bun run test` runs every test file in parallel worker processes (`bun test --parallel`, via scripts/test.ts), about
  2 minutes on a laptop instead of 5–10 serially; a run still going after 10 minutes (TEST_WALL_S) is stuck and is
  stopped, workers included. `bun run test:changed` runs only the files affected by your git changes
  (`--changed`; pass a branch to compare against, e.g. `bun run test:changed develop`): use it while working, and the
  full parallel run before you merge.
- Every file runs in its own process (`--parallel` implies `--isolate`), so a file may not lean on another file having
  run first. In apps/web, import a module that reads the page as it loads (anything reaching `api.ts`) from inside a
  test, after `withDom()`, never at the top of the file.
- `bun run test:serial` is the old one-process run, for chasing a failure that only shows there.
