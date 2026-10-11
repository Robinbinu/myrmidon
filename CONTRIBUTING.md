# Contributing to Myrmidon

Thanks for helping. Myrmidon is a Bun monorepo: `apps/` (desktop, web, CLI, eval) and `packages/` (protocol,
runtime, core).

## Getting set up

```bash
bun install
```

```bash
bun run dev
```

`bun run dev` serves the app with hot reload. You need macOS (Linux and Windows are in progress: issues
[#27](https://github.com/Robinbinu/myrmidon/issues/27) and [#28](https://github.com/Robinbinu/myrmidon/issues/28))
and Bun 1.3.14 or newer.

## Branches and pull requests

- Branch from `develop` and open your pull request against `develop`; `main` only moves by pull requests from
  `develop`.
- Keep a pull request to one change, and match the style of the code around it.
- Write commit messages that say why, with a subject line of at most 72 characters.

## Checks

- `bun run check`: types, lint and the full test suite. Run it before you open a pull request.
- `bun run test`: the suite alone, in parallel (about 2 minutes).
- `bun run test:changed`: only the tests your changes reach, for while you work.

Fixing a bug? Add a test that fails without the fix.

## House rules

[AGENTS.md](AGENTS.md) holds the rules the code follows (the settings registry, tests in parallel, …); they apply to
people and coding agents alike. In short: user-facing text goes in `copy.ts` / `prompts.ts`, tunables in
`ui-config.ts` / `config.ts`, and every setting has one entry in the settings registry.

## Coding agents

Coding agents are welcome as tools. You are responsible for what you submit: review every changed file, run the
checks, and try the changed behaviour yourself before you open the pull request.

## Security

Please don't report vulnerabilities in public issues: see [SECURITY.md](SECURITY.md).
