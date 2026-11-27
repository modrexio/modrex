# Translation ownership

Modrex's translation tooling is [lexmit](https://github.com/ShulhaOleh/lexmit). Its
[ownership guide](https://github.com/ShulhaOleh/lexmit/blob/v0.1.0/docs/ownership.md) defines the
three states, who may change what, and which check answers which question. This page covers how
Modrex wires it in.

## Wiring

- `lexmit.config.json` at the repository root names the locale folder, the README, the status
  images, the contributors file and the audited history baseline.
- Every `bun i18n:*` script in `apps/desktop/package.json` goes through its `lexmit` script, which
  runs one pinned version with `bunx`. Translators need only Bun, with no `bun install`.
- The renderer imports `@shulha/lexmit/runtime`, at the same version, to turn stored values into
  displayed text.
- `.github/workflows/translation-status.yml` calls lexmit's reusable workflow. It pushes with the
  `MAIN_PUSH_KEY` deploy key, because the main ruleset can exempt that key but not the workflow
  token.
- CI runs `bun run i18n:check-readonly` with full history, and the pre-commit hook runs
  `bun run i18n:check-staged`.

## Upgrading lexmit

Change the version in four places together: the `lexmit` script and the `@shulha/lexmit`
dependency in `apps/desktop/package.json`, and the tag and `lexmit-version` in the translation
status workflow. Then run `bun run i18n:check-readonly` and `bun run i18n:presentation-check`.
