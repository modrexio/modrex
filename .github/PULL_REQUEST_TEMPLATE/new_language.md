## Translation

See the [translation guide](https://github.com/modrexio/modrex/blob/main/TRANSLATING.md) for the
locale workflow and optional commands.

**Language:** <!-- e.g. Ukrainian -->
**Locale code:** <!-- e.g. uk, de, pt-BR -->

<!-- If you're not a native/fluent speaker of this language, say so here. -->

## Checklist

- [ ] Kept this translation-focused PR limited to relevant changes where practical
- [ ] Used a correctly formatted locale code for every filename (for example, `uk`, `pt-BR`, or `zh-Hant`)
- [ ] Translated values only; English keys are untouched
- [ ] Omitted untranslated keys instead of copying English values as placeholders
- [ ] Every `{var}` token (e.g. `{name}`, `{count}`) is preserved exactly, just repositioned to read naturally
- [ ] Both halves of every included singular/plural pair are translated (`modCount`/`modCountSingle`, `updatesAvailable`/`updatesAvailableSingle`, `installed`/`installedSingle`)
- [ ] `node apps/desktop/scripts/check-i18n.mjs --locale <code>` passes locally, or CI will validate it
- [ ] If I launched the app, I checked for obvious layout overflow

<!-- A screenshot of a page or two in the new language is appreciated but not required. -->
