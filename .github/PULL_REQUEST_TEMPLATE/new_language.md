## Translation

**Language:** <!-- e.g. Ukrainian -->
**Locale code:** <!-- e.g. uk, de, pt-BR -->

<!-- If you're not a native/fluent speaker of this language, say so here. -->

## Checklist

- [ ] Kept this translation-focused PR limited to relevant changes where practical
- [ ] Used a canonical BCP 47 locale code for every filename
- [ ] Translated values only; keys are untouched and stay in the same relative order as `en.json`
- [ ] Omitted untranslated keys instead of copying English values as placeholders
- [ ] Every `{var}` token (e.g. `{name}`, `{count}`) is preserved exactly, just repositioned to read naturally
- [ ] Both halves of every included singular/plural pair are translated (`modCount`/`modCountSingle`, `updatesAvailable`/`updatesAvailableSingle`, `installed`/`installedSingle`)
- [ ] `pnpm check-i18n` passes locally, or CI will perform validation
- [ ] If I launched the app, I checked for obvious layout overflow

<!-- A screenshot of a page or two in the new language is appreciated but not required. -->
