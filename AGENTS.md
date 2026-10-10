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
