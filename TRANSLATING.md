# Translating Modrex

You can contribute a translation without building Modrex or installing its development tools.
The language files are in [`apps/desktop/src/renderer/src/i18n`](apps/desktop/src/renderer/src/i18n).
See the [translation status](README.md#translations) for the languages currently available and
their key coverage.

## Choose how to translate

Use whichever workflow suits you. The fill command prepares the real locale file for editing in
an IDE, while the interactive command prompts for translations in the terminal.

| Command                  | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `pnpm i18n:help`         | Show all translation commands.                              |
| `pnpm i18n:status`       | List every available language and its key coverage.         |
| `pnpm i18n:check`        | Validate every locale, as CI does.                          |
| `pnpm i18n:check de`     | Validate `de.json` and explain any problem.                 |
| `pnpm i18n:missing de`   | List every missing German key with its English source text. |
| `pnpm i18n:fill de`      | Prepare an existing German locale for editing in an IDE.    |
| `pnpm i18n:translate de` | Interactively continue an existing German translation.      |
| `pnpm i18n:create uk`    | Create an IDE-ready Ukrainian locale with marked English.   |

Replace `de` or `uk` with the locale code you are working on. During an interactive session,
press Enter to skip a string. Partial translations are saved and can be resumed later. The CLI
validates placeholders immediately and asks for singular/plural translations together.

Local commands are optional. You can edit JSON manually and let CI validate the pull request.

## Update an existing language

### Edit in an IDE

Run `pnpm i18n:fill de`. Missing keys are added directly to `de.json` in English order, with `! `
before the English source:

```json
{
    "splash": {
        "title": "! Starting Modrex"
    }
}
```

Replace the entire marked value with your translation. Values that still start with `! ` remain
untranslated: they do not increase coverage, and Modrex displays the current English source
instead of the marked text. You can run the fill command again whenever English adds or changes
strings; existing translations are preserved.

### Translate interactively

Run `pnpm i18n:translate de`. The CLI shows only missing translations, inserts completed values
in the correct nested location, and preserves everything already translated. Enter skips the
current string without adding an English placeholder.

### Edit manually

1. Find the file named with your locale code, such as `de.json` for German.
2. Edit translated values. Do not rename the English keys.
3. Leave untranslated keys out, or keep the marked values created by `i18n:fill`. Partial
   translations are welcome, and untranslated text falls back to English in the app.

## Add a language

Choose a locale code such as `uk` for Ukrainian, `pt-BR` for Brazilian Portuguese, or `zh-Hant`
for Traditional Chinese.

Run `pnpm i18n:create uk`. It creates `uk.json` in English order with every source string marked
by `! `, ready to replace in your editor. To work in the terminal instead, create the file first
and then run `pnpm i18n:translate uk`.

For the manual workflow, create `<locale>.json` in the locale directory. Start with `{}`, then
copy only the sections and keys you are ready to translate from `en.json`. You do not need to copy
the whole English file.

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
- An untranslated value is either an omitted key or a value beginning with `! `.
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
