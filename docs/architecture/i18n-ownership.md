# Translation ownership

Modrex reconstructs translation state from Git history. This page says who is allowed to
change what, and which check enforces which half of that.

## The three states

Every key, in every non-English locale, is in exactly one state. The state is derived from
history, not read off whichever marker the file currently holds.

| State    | Meaning                                                                      | Stored form                                              |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| Accepted | A human accepted this text against the English that is in the file right now | the translation, unmarked                                |
| Review   | English moved since the acceptance, or somebody asked for a second look      | `? <translation>`, or still unmarked before the bot runs |
| Missing  | Nobody has translated this key                                               | absent, or `! <English>`                                 |

The last column is where the subtlety lives. A translation whose English changed is in Review
the moment the English commit lands, whether or not its `? ` has been written yet. `en.json` is
the only file a product change has to touch, so a marker is always written later, by the bot, in
a separate commit. Code that reads state from the stored marker would call that entry Accepted
and would be wrong. `summarizeHistory` in `apps/desktop/scripts/i18n-history.mjs` exposes this as
`effectiveState`, and it is the one interpretation the validators, the synchronizer, the review
command and the CLI summaries all read.

Missing is not Review. An English scaffold is not an accepted translation. A translation that
happens to match some historical value is not evidence that anyone reviewed the current meaning.

## Who owns what

| Actor                | Owns                                                                            | Must not do                                                   |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Product contributor  | English source strings                                                          | Translate or backfill other locales as incidental work        |
| Language contributor | Translated text, and explicit Keep/Edit review decisions                        | Be required to regenerate badges to pass CI                   |
| CI                   | Whether the tree is valid translation data                                      | Reject a tree only because derived output is stale            |
| Bot                  | `!` and `?` markers, contributor attribution, the README block, the status SVGs | Invent translations, change payloads, or accept a new meaning |

## Which check asks which question

Two different questions, deliberately separated. Conflating them is what previously forced a
contributor to commit the bot's future output.

| Question                                      | Command                        | Who runs it         |
| --------------------------------------------- | ------------------------------ | ------------------- |
| Is this valid translation data?               | `pnpm i18n:check-readonly`     | CI, on every push   |
| Same, restricted to the staged files          | `pnpm i18n:check-staged`       | the pre-commit hook |
| Structural validation plus effective coverage | `pnpm check-i18n`              | CI and contributors |
| Have the locale markers caught up?            | `pnpm i18n:check-sync`         | the bot only        |
| Have the README and SVGs caught up?           | `pnpm i18n:presentation-check` | the bot only        |

The validity checks pass for a new English key with no translation, for changed English over an
unchanged translation, and for a scaffold quoting superseded English. They fail for a translation
whose `{placeholders}` disagree with English that has not changed, an unknown key holding real
translated text, invalid marker syntax, empty values, and unsafe Unicode.

When Git history is unavailable, a check that needs it reports what it could not determine and
exits non-zero. It never assumes the tree is fine. `pnpm i18n:fill` deliberately needs no history
and stays usable in a shallow clone; it writes English scaffolds and never decides acceptance.

## Acceptance has to exist in Git

`pnpm i18n:review` lists every entry that is effectively Review, including those whose `?` the
bot has not written yet, and it refuses any decision that would leave no trace. Keeping a
translation writes back the text that is already there, so it is only a real acceptance when the
committed file holds the `?` marker that the write removes. An Edit that retypes the committed
text is refused for the same reason.

Both checks compare against the committed tree, never the working tree: a marker that sync wrote
but nobody committed produces an empty diff, so removing it would record nothing while the
command reported a successful Keep. When Keep is unavailable, run `pnpm i18n:sync`, commit the
marker, and review again — or Edit, which writes new text and needs no marker first.

A Review whose placeholders no longer match English can still be reviewed. Only Keep is
unavailable there, because keeping text the runtime already replaces with English would accept a
translation nobody can see.

## Why history replay tolerates stale scaffolds

Between an English commit and the bot's next run, every intermediate revision holds scaffolds
quoting superseded English. History replay walks every revision from the audited baseline, so
rejecting that drift would let a single ordinary commit break every later analysis permanently.
`analyzeCommittedHistory` therefore does not check scaffold freshness. Malformed markers,
unreadable bundles, Pending without accepted lineage, and a missing or non-ancestor baseline all
still fail closed.

## What the writer checks before it commits

The bot pushes with `GITHUB_TOKEN`, which does not start another workflow run, so its commit gets
no CI. Everything that commit is checked against therefore has to happen inside
`.github/workflows/translation-status.yml` before the push:

1. the source commit is valid on its own, before anything is written
2. synchronize markers, regenerate contributors, README and SVGs
3. strict marker and presentation freshness against the regenerated tree
4. a second generation pass produces no further change
5. `scripts/i18n-writer-guard.mjs` proves only allowed paths changed and no translated text was
   created, rewritten or deleted
6. stage the owned paths by name, commit, and push without force

This is the bot verifying its own output. It is not a CI run attached to the bot's commit, and
nothing in the repository should describe it as one.

If `main` advanced while the run was working, the push is rejected, the generated work is thrown
away in the disposable runner, and the run recomputes from fresh `main`, bounded to three
attempts. A translator's commit is never overwritten and history is never force-pushed.

## Runtime is unaffected

`resolveTargetValue` in `apps/desktop/src/shared/i18n-values.js` is the whole runtime rule:

- absent or `! ` target: render current English
- Accepted or `? ` target whose placeholders match English: render the target, without the marker
- either, with placeholders that do not match: render current English

Review does not mean "display English". The desktop bundles locales at build time and has no Git
on the user's machine, so nothing in this document reaches the running app: a build made before
the bot synchronizes renders exactly what a build made after it renders.
