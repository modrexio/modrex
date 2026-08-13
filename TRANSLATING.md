# Translating Modrex

You can contribute a translation without building Modrex or installing its development tools.
The language files are in [`apps/desktop/src/renderer/src/i18n`](apps/desktop/src/renderer/src/i18n).
See the [translation status](README.md#translations) for the languages currently available and
their key coverage.

## Update an existing language

1. Find the file named with your locale code, such as `de.json` for German.
2. Edit translated values. Do not rename the English keys.
3. Leave keys you have not translated out of the file. Partial translations are welcome, and
   missing text falls back to English in the app.

These optional local commands make the work easier:

| Direct Node command                                     | pnpm alias             | Description                                                 |
| ------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `node apps/desktop/scripts/check-i18n.mjs --status`     | `pnpm i18n:status`     | List every available language and its key coverage.         |
| `node apps/desktop/scripts/check-i18n.mjs --missing de` | `pnpm i18n:missing de` | List every missing German key with its English source text. |
| `node apps/desktop/scripts/check-i18n.mjs --locale de`  | `pnpm i18n:check de`   | Validate `de.json` and explain any problem.                 |
| `node apps/desktop/scripts/check-i18n.mjs`              | `pnpm check-i18n`      | Validate every locale, as CI does.                          |

Replace `de` with the locale code from the filename you are working on.

The direct commands require only Node.js and use no installed packages. The aliases are available
if you already use pnpm. Local tooling is optional: you do not need Node.js, pnpm, `pnpm install`,
Rust, Tauri, or a running copy of Modrex to edit a locale and submit a pull request.

## Add a language

1. Choose a locale code for the filename, such as `uk` for Ukrainian, `pt-BR` for Brazilian
   Portuguese, or `zh-Hant` for Traditional Chinese.
2. Create `<locale>.json` in the locale directory. Starting with `{}` is safest, then copy only
   the sections and keys you are ready to translate from `en.json`.
3. Run the optional `--locale <locale>` and `--missing <locale>` commands, or let CI validate the
   pull request.

The filename is the only registration step. Modrex discovers locale files automatically and
uses the platform's native language name.

## Submit the pull request

1. Commit the locale file to a branch in your fork, using a local clone or the GitHub web editor.
2. Open a normal pull request against `main`.
3. In the standard pull request template, select **Translation** and enter the language and locale
   code.
4. Select the validation option that matches what you ran. **CI only** is fully supported and CI
   validates the locale for you.

## Translation rules

- Keep placeholders such as `{name}`, `{count}`, and `{game}` exactly as written. You may move
  them wherever they read naturally in the translated sentence.
- Translate a plural key and its matching `Single` key together, such as `modCount` and
  `modCountSingle`.
- Values must be non-empty strings. Nested JSON objects are allowed; arrays and other values are
  not.
- Do not copy English text as a placeholder. Omit the key until it is translated.
- Key coverage measures whether translated keys exist, not translation quality or freshness.

## Contributor credit

Contributor links are generated automatically after locale changes reach `main`. Modrex uses
semantic locale history, so formatting-only edits do not count. Do not edit
`translation-contributors.generated.json`, the README translation table, or any language
registry; no manual attribution or registration is required.

Commits must be linked to your GitHub account for automatic credit. A GitHub squash merge keeps
the pull request author linked even when the maintainer performs the merge.

For code, documentation, or other changes, use the general
[contribution guide](CONTRIBUTING.md).
