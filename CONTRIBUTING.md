# Contributing to Modrex

Thanks for taking the time to contribute! Every bug report, suggestion, and pull request helps make Modrex better for the whole community.

If you want to improve an existing translation or add a language, use the dedicated
[translation guide](TRANSLATING.md). It does not require the development setup below.

## Development setup

| Command                  | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `pnpm install`           | Install dependencies                            |
| `pnpm dev`               | Start with hot reload                           |
| `pnpm build`             | Production build                                |
| `pnpm typecheck`         | Type-check renderer                             |
| `pnpm format`            | Format all files with Prettier                  |
| `pnpm lint`              | Lint renderer source                            |
| `pnpm test`              | Run all tests (Rust + renderer)                 |
| `pnpm checks`            | Run the full CI gate locally                    |
| `pnpm generate-licenses` | Regenerate apps/desktop/THIRD_PARTY_LICENSES.md |

`pnpm checks` is the one to run before opening a pull request: it runs everything CI does
(formatting, lint, typecheck, tests, and the consistency checks below) in one pass.

## Tech stack

Tauri v2 · React · Tailwind CSS · Lucide · TypeScript

## Before committing

Pre-commit hooks run automatically via Husky:

- **`prettier --check`** - run `pnpm format` to fix formatting failures
- **`eslint`** - run `pnpm lint:fix` to fix lint failures
- **`check-commands`** - see Backend commands below
- **`commitlint`** - enforces the commit message format (see Commit style below)

When a desktop dependency file is staged, the hook also regenerates
`apps/desktop/THIRD_PARTY_LICENSES.md` and
stages it for you (this takes about 15 seconds). You can run it yourself with
`pnpm generate-licenses`. CI enforces it via the `check-licenses` job, so the build fails
if that file is out of date.

## Backend commands

`apps/desktop/src/shared/bindings.ts` is generated from the Rust command registry, not
written by hand.
Editing it directly will be overwritten and CI fails if it is stale.

If you add, rename, or change the signature of a `#[tauri::command]`:

1. Register it in `ipc_builder()` in `apps/desktop/src-tauri/src/lib.rs`
2. Regenerate the bindings: `cd apps/desktop/src-tauri && cargo test` (any test run does it)
3. Call it from `apps/desktop/src/renderer/src/api.ts`, which is the only renderer file allowed to
   touch the IPC layer

`pnpm check-commands` enforces all of that: a command registered but never called, called
but never registered, stale bindings, or an `invoke` outside `api.ts` each fail the check.

## Code style

Formatting and lint are automated: `pnpm format` and `pnpm lint:fix` fix most issues.
The rules below are the ones tooling cannot check for you.

Code: keep the happy path flat, use guard clauses for invalid cases, validate at
boundaries, and skip speculative abstractions. The full policy lives in
`.claude/rules/code-style.md`, a plain markdown file that doubles as the instruction
set the repo's AI tooling loads, so human and AI contributions are reviewed against
the same rules.

Comments:

- Explain why, not what. Delete anything that repeats the code.
- Default shape is one to four lines: the constraint, and what breaks without it.
- Plain sentences, plain ASCII. No backticks around identifiers, no em dashes, no
  semicolons or arrows chaining clauses. Write save_state, not `save_state`.
- No history. A comment describes the present code. Words like "previously" and
  "no longer" belong in the commit message.
- Longer blocks are reserved for file formats, algorithm provenance, reference
  implementations, and security assumptions. Those are load-bearing, leave them intact.

## Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.
Common types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`.

## Submitting changes

Open a pull request against `main`. Run `pnpm checks` first, it runs the same gate CI does.

Adding support for a new game, mod loader, or mod source is mostly a matter of adding an
entry to the relevant registry rather than editing call sites:

| What you're adding | Registry                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Game               | `apps/desktop/src-tauri/src/commands/games.rs` + `GAME_SPECS` in `apps/desktop/src/shared/types.ts` |
| Mod loader         | `apps/desktop/src-tauri/src/commands/loaders.rs`                                                    |
| Mod source         | `apps/desktop/src-tauri/src/commands/sources.rs`                                                    |

Neither side of a cross-language pair can see the other, so `pnpm check-games` and
`pnpm check-sources` diff them in CI. See `CLAUDE.md` for how they fit together before
starting.

## Translations

English is the source language for product development:

- Feature and bug-fix contributions add or change source strings in
  `apps/desktop/src/renderer/src/i18n/en.json`. Do not add unmarked English copies to non-English
  files. Translators can use `pnpm i18n:create <locale>` for a new language or
  `pnpm i18n:fill <locale>` for an existing language when they want marked source text for IDE
  editing.
- Keep translation-only pull requests focused when practical. Developers may include relevant
  human-written translations with a product change.
- Missing translated keys are valid and fall back to English in the app.

AI agents must not create or update non-English translations unless the user explicitly requests
translation for specific named locales.

The translator-focused workflow, optional commands, locale rules, and new-language steps are in
[TRANSLATING.md](TRANSLATING.md). Local tooling is optional; CI can perform validation without
pnpm, application dependencies, Rust, Tauri, or launching Modrex.

Maintainers can preview or verify the generated README without modifying it:

| Command                                                     | Description                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `node apps/desktop/scripts/update-i18n-readme.mjs --stdout` | Print the generated README without modifying `README.md`.     |
| `node apps/desktop/scripts/update-i18n-readme.mjs --check`  | Exit non-zero when the checked-in translation table is stale. |

After locale changes reach `main`, GitHub Actions regenerates contributor attribution and the
README table. Locale files remain the source for language discovery and coverage.
